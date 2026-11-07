import type { ToolCall } from './tools';
import { scrubWorkspaceText } from '../envSafety';

/**
 * The wire format for a tool round.
 *
 * A fenced JSON array is used instead of provider-native function calling
 * because ShadRox talks to Gemini, Groq, OpenAI and any user-supplied
 * OpenAI-compatible endpoint with one code path; a textual protocol works on
 * all of them and stays inspectable in the transcript.
 */
export const TOOL_FENCE = 'shadrox:tools';
export const RESULT_FENCE = 'shadrox:results';
/** Parsing stops here so a runaway block cannot allocate itself into the loop. */
const MAX_PARSED_CALLS = 16;
/** One observation may not eat the context: the round's results share this budget. */
const MAX_ROUND_RESULT_CHARS = 48_000;
const MIN_RESULT_CHARS = 1_000;
const UNTRUSTED_DATA_BEGIN = '[[SHADROX_UNTRUSTED_DATA_BEGIN]]';
const UNTRUSTED_DATA_END = '[[SHADROX_UNTRUSTED_DATA_END]]';

export interface ParsedToolBlock {
  calls: ToolCall[];
  /** Set when the block existed but could not be used; fed back to the model. */
  error: string | null;
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string' && candidate.name.trim().length > 0
    && (candidate.args === undefined || (typeof candidate.args === 'object' && candidate.args !== null && !Array.isArray(candidate.args)));
}

function parseBareToolCalls(text: string): ParsedToolBlock | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0 || !list.every((entry) => {
    if (!isToolCall(entry)) return false;
    return entry.args !== undefined
      && typeof entry.args === 'object'
      && entry.args !== null
      && !Array.isArray(entry.args);
  })) return null;
  const calls = list.slice(0, MAX_PARSED_CALLS).map((call) => ({
    name: call.name.trim(),
    args: (call.args ?? {}) as Record<string, unknown>
  }));
  const lost = list.length - calls.length;
  return {
    calls,
    error: lost > 0
      ? `${lost} ${lost === 1 ? 'entry was' : 'entries were'} past the parse limit of ${MAX_PARSED_CALLS} and did not run.`
      : null
  };
}

/** Finds every tool fence in a reply. An unterminated fence is a streamed block still in flight. */
export function parseToolBlocks(text: string): ParsedToolBlock[] {
  const blocks: ParsedToolBlock[] = [];
  const pattern = /```[ \t]*shadrox:tools[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const calls = list.filter(isToolCall).map((call) => ({ name: call.name.trim(), args: (call.args ?? {}) as Record<string, unknown> })).slice(0, MAX_PARSED_CALLS);
      if (calls.length === 0) blocks.push({ calls: [], error: 'The tool block held no usable calls. Each entry needs a "name".' });
      else {
        // Past the parse limit the loss is reported: a dropped call the model
        // never hears about cannot be re-asked. The per-round cap belongs to the
        // loop, which owns the budget across blocks.
        const lost = list.length - calls.length;
        blocks.push({ calls, error: lost > 0
          ? `${lost} ${lost === 1 ? 'entry was' : 'entries were'} unusable or past the parse limit of ${MAX_PARSED_CALLS} and did not run.`
          : null });
      }
    } catch (error) {
      blocks.push({ calls: [], error: `The tool block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    }
    match = pattern.exec(text);
  }
  if (blocks.length === 0) {
    const bare = parseBareToolCalls(text);
    if (bare) blocks.push(bare);
  }
  return blocks;
}

export function hasOpenToolFence(text: string): boolean {
  const start = text.lastIndexOf(`\`\`\`${TOOL_FENCE}`);
  if (start < 0) return false;
  return text.slice(start + TOOL_FENCE.length + 3).indexOf('```') < 0;
}

/** Strips every tool fence so a partial block never renders as JSON in the chat. */
export function stripToolBlocks(text: string): string {
  const stripped = text
    .replace(/```[ \t]*shadrox:tools[ \t]*\r?\n[\s\S]*?```/g, '')
    .replace(/```[ \t]*shadrox:tools[\s\S]*$/g, '')
    // A model that echoes its observations back as a results fence must never
    // surface raw JSON in the transcript.
    .replace(/```[ \t]*shadrox:results[ \t]*\r?\n[\s\S]*?```/g, '')
    .replace(/```[ \t]*shadrox:results[\s\S]*$/g, '')
    .trim();
  return parseBareToolCalls(stripped) ? '' : stripped;
}

interface ResultEntry {
  name: string;
  ok: boolean;
  text: string;
}

function framePayload(payload: unknown): string {
  return `\`\`\`${RESULT_FENCE}\n${JSON.stringify(payload, null, 1)}\n\`\`\``;
}

function payloadOf(entries: ResultEntry[], share: number | null): unknown[] {
  return entries.map((entry) => {
    const text = share === null ? entry.text : cutToShare(entry.text, share);
    return entry.ok
      ? { tool: entry.name, ok: true, result: markUntrustedData(text) }
      : { tool: entry.name, ok: false, error: markUntrustedData(text) };
  });
}

export function serializeResults(results: Array<{ name: string; ok: boolean; content: string; error?: string }>, budget = MAX_ROUND_RESULT_CHARS): string {
  // The whole observation is paid for out of the model's context: successful
  // content, error strings and the JSON/fence/marker framing alike. Budget the
  // serialized total, not just the happy-path bodies, so a round of failures or
  // a wide framing cannot slip past the cap.
  const entries: ResultEntry[] = results.map((result) => ({
    name: result.name,
    ok: result.ok,
    text: result.ok ? result.content : (result.error ?? 'The tool failed.')
  }));
  const fixed = framePayload(payloadOf(entries.map((entry) => ({ ...entry, text: '' })), null)).length;
  const variable = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  let share: number | null = null;
  if (fixed + variable > budget) {
    const available = Math.max(0, budget - fixed);
    share = Math.max(MIN_RESULT_CHARS, Math.floor(available / Math.max(1, entries.length)));
  }
  let output = framePayload(payloadOf(entries, share));
  // The cut markers themselves add characters; shrink until the framed result
  // actually fits rather than trusting the first estimate.
  while (output.length > budget && share !== null && share > MIN_RESULT_CHARS) {
    share = Math.max(MIN_RESULT_CHARS, Math.floor(share * 0.8));
    output = framePayload(payloadOf(entries, share));
  }
  return output;
}

export function markUntrustedData(content: string): string {
  const escaped = scrubWorkspaceText(content)
    .replaceAll(UNTRUSTED_DATA_BEGIN, `\\${UNTRUSTED_DATA_BEGIN}`)
    .replaceAll(UNTRUSTED_DATA_END, `\\${UNTRUSTED_DATA_END}`);
  return `${UNTRUSTED_DATA_BEGIN}\n${escaped}\n${UNTRUSTED_DATA_END}`;
}

function cutToShare(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n… [the round returned too much to keep: ${limit} of ${content.length} characters shown. Ask for one file or a narrower query at a time.]`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalValue(source[key]);
    return ordered;
  }
  return value;
}

export function serializeCallKey(call: ToolCall): string {
  return `${call.name} ${JSON.stringify(canonicalValue(call.args ?? {}))}`;
}
