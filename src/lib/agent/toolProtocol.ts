import type { ToolCall } from './tools';

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

export function serializeResults(results: Array<{ name: string; ok: boolean; content: string; error?: string }>, budget = MAX_ROUND_RESULT_CHARS): string {
  // Six 24k reads are 144k characters of observation: the round pays for them
  // out of the model's context. Split evenly instead of keeping the first calls
  // whole and silently dropping the last ones.
  const sizes = results.filter((result) => result.ok).map((result) => result.content.length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const share = total > budget ? Math.max(MIN_RESULT_CHARS, Math.floor(budget / Math.max(1, sizes.length))) : null;
  const payload = results.map((result) => (result.ok
    ? { tool: result.name, ok: true, result: share === null ? result.content : cutToShare(result.content, share) }
    : { tool: result.name, ok: false, error: result.error ?? 'The tool failed.' }));
  return `\`\`\`${RESULT_FENCE}\n${JSON.stringify(payload, null, 1)}\n\`\`\``;
}

function cutToShare(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n… [the round returned too much to keep: ${limit} of ${content.length} characters shown. Ask for one file or a narrower query at a time.]`;
}

export function serializeCallKey(call: ToolCall): string {
  return `${call.name} ${JSON.stringify(call.args ?? {}, Object.keys(call.args ?? {}).sort())}`;
}
