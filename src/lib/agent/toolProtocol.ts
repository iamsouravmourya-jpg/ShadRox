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
/**
 * Parsing stops here so a runaway block cannot allocate itself into the loop.
 * This is an anti-abuse bound, NOT the per-round budget: it sits well above
 * MAX_CALLS_PER_ROUND (16) so a round's overflow survives parsing and the loop
 * can cut it with the helpful "did not run this round, ask again" note instead
 * of a generic parse-loss message.
 */
const MAX_PARSED_CALLS = 64;
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

/**
 * Deterministic, string-state-aware JSON repair for common LLM formatting glitches:
 * - Inner ```json ... ``` wrapper inside a fence/XML tag
 * - // line comments and /* block comments *\/ outside string literals
 * - Unescaped literal newlines, carriage returns, or tabs inside double-quoted JSON strings
 * - Trailing commas before } or ]
 * - Single-quoted JSON keys/values outside double quotes
 * - Comma-separated `{...}, {...}` objects missing outer `[` `]`
 *
 * Intentionally does NOT close truncated strings/objects: if a stream was cut off
 * mid-argument, guessing missing fields would silently write corrupt files.
 */
function cleanJsonText(raw: string): string {
  let source = raw.trim();
  const fenced = source.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```[ \t]*)?$/i);
  if (fenced) source = fenced[1].trim();

  let out = '';
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (inDouble) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inDouble = false;
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }

    if (inSingle) {
      if (escaped) {
        out += ch === '\'' ? '\'' : `\\${ch}`;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '\'') {
        out += '"';
        inSingle = false;
        continue;
      }
      if (ch === '"') { out += '\\"'; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }

    // Outside any string
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '\'') {
      inSingle = true;
      out += '"';
      continue;
    }
    out += ch;
  }

  // Strip trailing commas directly before `}` or `]` outside strings.
  let withoutTrailingCommas = '';
  inDouble = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inDouble) {
      withoutTrailingCommas += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      withoutTrailingCommas += ch;
      continue;
    }
    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < out.length && /\s/.test(out[lookahead])) lookahead += 1;
      const after = out[lookahead];
      if (after === '}' || after === ']') continue;
    }
    withoutTrailingCommas += ch;
  }
  return withoutTrailingCommas.trim();
}

export function repairJsonValue(raw: string): { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw), repaired: false };
  } catch (initialError) {
    const cleaned = cleanJsonText(raw);
    const candidates = [cleaned];
    if (cleaned.startsWith('{') && cleaned.endsWith('}') && /\}\s*,\s*\{/.test(cleaned)) {
      candidates.push(`[${cleaned}]`);
    }
    for (const candidate of candidates) {
      try {
        return { ok: true, value: JSON.parse(candidate), repaired: true };
      } catch {
        /* try next candidate */
      }
    }
    return {
      ok: false,
      error: initialError instanceof Error ? initialError.message : String(initialError)
    };
  }
}

export function repairAndParseNativeToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = repairJsonValue(raw);
  if (!('value' in parsed)) {
    return {
      __nativeArgumentError:
        'The tool arguments were incomplete or invalid JSON — likely the reply was cut off by the output limit. Re-issue this call with complete arguments.'
    };
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { __nativeArgumentError: 'Arguments must be a JSON object.' };
  }
  return parsed.value as Record<string, unknown>;
}

function normalizeCallEntry(value: unknown): ToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;

  // Support OpenAI shape `{ type: "function", function: { name, arguments } }`
  const source =
    candidate.function && typeof candidate.function === 'object' && !Array.isArray(candidate.function)
      ? (candidate.function as Record<string, unknown>)
      : candidate;

  if (typeof source.name !== 'string' || !source.name.trim()) return null;
  const rawArgs = source.args !== undefined
    ? source.args
    : source.arguments !== undefined
      ? source.arguments
      : source.parameters;

  if (rawArgs === undefined) {
    return { name: source.name.trim(), args: {} };
  }
  if (typeof rawArgs === 'string') {
    const parsedArgs = repairJsonValue(rawArgs);
    if ('value' in parsedArgs && parsedArgs.value && typeof parsedArgs.value === 'object' && !Array.isArray(parsedArgs.value)) {
      return { name: source.name.trim(), args: parsedArgs.value as Record<string, unknown> };
    }
    return null;
  }
  if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
    return { name: source.name.trim(), args: rawArgs as Record<string, unknown> };
  }
  return null;
}

function isStrictToolCall(value: unknown): value is ToolCall {
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
    if (!isStrictToolCall(entry)) return false;
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

/**
 * A fence closes ONLY on a line that is exactly ``` (optional trailing
 * whitespace, CRLF aware, anchored to line start). A bare ``` anywhere else —
 * e.g. inside a JSON string argument that quotes markdown — must not end the
 * match early and lose the whole block. The `m` flag makes ^/$ line boundaries.
 */
const TOOL_BLOCK_PATTERN = /```[ \t]*shadrox:tools[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gm;
const RESULT_BLOCK_PATTERN = /```[ \t]*shadrox:results[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gm;
/** Open-source local/Qwen/Hermes models occasionally wrap calls in <tool_call> tags. */
const XML_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
/** A closing fence as it appears AFTER an opening marker: the rest begins
 * mid-line, so only a later line that is exactly ``` counts as the close. */
const CLOSE_FENCE_AFTER_OPEN = /\n[ \t]*```[ \t]*\r?(?:\n|$)/;

function parseCallPayload(raw: string): ParsedToolBlock {
  const parsedResult = repairJsonValue(raw);
  if ('error' in parsedResult) {
    return { calls: [], error: `The tool block is not valid JSON: ${parsedResult.error}` };
  }
  const list = Array.isArray(parsedResult.value) ? parsedResult.value : [parsedResult.value];
  const calls = list
    .map(normalizeCallEntry)
    .filter((call): call is ToolCall => call !== null)
    .slice(0, MAX_PARSED_CALLS);
  if (calls.length === 0) {
    return { calls: [], error: 'The tool block held no usable calls. Each entry needs a "name" and an "args" object.' };
  }
  const lost = list.length - calls.length;
  return {
    calls,
    error: lost > 0
      ? `${lost} ${lost === 1 ? 'entry was' : 'entries were'} unusable or past the parse limit of ${MAX_PARSED_CALLS} and did not run.`
      : null
  };
}

/** Finds every tool fence in a reply. An unterminated fence is a streamed block still in flight. */
export function parseToolBlocks(text: string): ParsedToolBlock[] {
  const blocks: ParsedToolBlock[] = [];
  const pattern = new RegExp(TOOL_BLOCK_PATTERN.source, 'gm');
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    blocks.push(parseCallPayload(match[1].trim()));
    match = pattern.exec(text);
  }
  if (blocks.length === 0) {
    const xmlPattern = new RegExp(XML_TOOL_CALL_PATTERN.source, 'gi');
    let xmlMatch: RegExpExecArray | null = xmlPattern.exec(text);
    while (xmlMatch) {
      blocks.push(parseCallPayload(xmlMatch[1].trim()));
      xmlMatch = xmlPattern.exec(text);
    }
  }
  if (blocks.length === 0) {
    const bare = parseBareToolCalls(text);
    if (bare) blocks.push(bare);
  }
  return blocks;
}

export function hasOpenToolFence(text: string): boolean {
  const opening = /```[ \t]*shadrox:tools/g;
  let start = -1;
  let match: RegExpExecArray | null = opening.exec(text);
  while (match) {
    start = match.index;
    match = opening.exec(text);
  }
  if (start < 0) return false;
  const rest = text.slice(start + 3 + TOOL_FENCE.length);
  // Same line-anchored close as parseToolBlocks: an inline ``` inside the
  // streamed JSON does not close the fence, so the block is still in flight.
  return !CLOSE_FENCE_AFTER_OPEN.test(rest);
}

/** Strips every tool fence so a partial block never renders as JSON in the chat. */
export function stripToolBlocks(text: string): string {
  const stripped = text
    .replace(new RegExp(TOOL_BLOCK_PATTERN.source, 'gm'), '')
    .replace(/```[ \t]*shadrox:tools[\s\S]*$/g, '')
    .replace(new RegExp(XML_TOOL_CALL_PATTERN.source, 'gi'), '')
    .replace(/<tool_call>[\s\S]*$/gi, '')
    // A model that echoes its observations back as a results fence must never
    // surface raw JSON in the transcript.
    .replace(new RegExp(RESULT_BLOCK_PATTERN.source, 'gm'), '')
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
