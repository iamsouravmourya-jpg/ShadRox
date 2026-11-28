import type { ChatTurn } from '../ai';

/**
 * Context compaction for long tool turns.
 *
 * At ~70% of the loop's character budget, old tool observations are summarized
 * to "what was found/decided" — one line per tool with the head of its result —
 * while the most recent observations, every user ask, every assistant reply and
 * every nudge stay verbatim. The model keeps its recent evidence intact and
 * loses only the bulk of stale file dumps it has already acted on.
 *
 * Pure function over the transcript: the loop swaps its `messages` array for the
 * returned one and records the event; nothing here touches the provider.
 */

export const LOOP_CONTEXT_BUDGET_CHARS = 160_000;
export const MIN_LOOP_CONTEXT_BUDGET_CHARS = 20_000;
export const COMPACT_TRIGGER_SHARE = 0.7;
/** The newest observations stay verbatim — they are the working evidence. */
export const KEEP_RECENT_OBSERVATIONS = 4;
/** Even the newest observations are capped individually so one huge result cannot blow the window. */
export const CAP_RECENT_OBSERVATION_CHARS = 12_000;
const SUMMARY_ENTRY_CHARS = 160;
const SUMMARY_MESSAGE_CHARS = 1_800;
const MIN_COMPACT_CHARS = 400;

/**
 * Computes an appropriate character budget for intermediate tool-loop
 * transcripts from the active model's context window so smaller/free BYOK
 * models compact stale file dumps before overflowing their window.
 *
 * The threshold is DERIVED from `resolveContextWindow(model)` — ~65% of the
 * usable window (after the output reservation and the system instruction) —
 * then capped cleanly to `[MIN_LOOP_CONTEXT_BUDGET_CHARS, LOOP_CONTEXT_BUDGET_CHARS]`
 * so a huge window never over-spends and a tiny one still gets a usable budget.
 * There is no fixed 160K threshold: 160K is only the upper clamp.
 *
 * `schemaChars` accounts for the native tool schemas that ride in every
 * request but are not part of the message array — they consume tokens too.
 */
export function computeLoopContextBudgetChars(
  contextWindowTokens: number,
  reservedOutputTokens = 4_096,
  systemInstructionChars = 0,
  schemaChars = 0
): number {
  const usableTokens = Math.max(2_000, contextWindowTokens - Math.max(512, reservedOutputTokens));
  const systemTokens = Math.ceil(Math.max(0, systemInstructionChars + schemaChars) / 4);
  const loopTokens = Math.max(5_000, Math.floor((usableTokens - systemTokens) * 0.65));
  return Math.max(MIN_LOOP_CONTEXT_BUDGET_CHARS, Math.min(LOOP_CONTEXT_BUDGET_CHARS, loopTokens * 4));
}

const OBSERVATION_FENCE = /```shadrox:results\r?\n([\s\S]*?)\r?\n```/;
const ASSISTANT_TOOLS_FENCE = /```shadrox:tools\r?\n([\s\S]*?)\r?\n```/g;
const DATA_MARKERS = /\[\[SHADROX_UNTRUSTED_DATA_(?:BEGIN|END)\]\]/g;
const ASSISTANT_WRITE_COMPACT_THRESHOLD = 240;
const ASSISTANT_EDIT_COMPACT_THRESHOLD = 400;

export function transcriptChars(messages: ChatTurn[]): number {
  return messages.reduce((total, turn) => total + turn.content.length, 0);
}

export function isToolObservation(turn: ChatTurn): boolean {
  return turn.role === 'user' && turn.content.includes('```shadrox:results');
}

export function isAssistantToolTurn(turn: ChatTurn): boolean {
  return turn.role === 'assistant' && turn.content.includes('```shadrox:tools');
}

function flatHead(text: string, limit: number): string {
  const flat = text.replace(DATA_MARKERS, '').replace(/\\\[\[/g, '[[').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

interface AssistantToolCallShape {
  name?: unknown;
  args?: Record<string, unknown>;
}

/** Shrinks bulky file contents inside older assistant `write_file`/`apply_patch`/`edit_file` tool fences. */
export function summarizeAssistantToolPayload(content: string): string {
  let mutated = false;
  const compacted = content.replace(ASSISTANT_TOOLS_FENCE, (fullMatch, body: string) => {
    try {
      const parsed = JSON.parse(body) as AssistantToolCallShape | AssistantToolCallShape[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      let blockChanged = false;
      const nextCalls = calls.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.args || typeof entry.args !== 'object') {
          return entry;
        }
        const args = { ...entry.args };
        if (entry.name === 'write_file' && typeof args.content === 'string' && args.content.length > ASSISTANT_WRITE_COMPACT_THRESHOLD) {
          const target = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'file';
          args.content = `[compacted write_file content: ${args.content.length} chars written to ${target}]`;
          blockChanged = true;
        } else if (entry.name === 'apply_patch') {
          for (const field of ['patches', 'hunks'] as const) {
            const rawList = args[field];
            if (!Array.isArray(rawList)) continue;
            let listChanged = false;
            const nextList = rawList.map((hunk) => {
              if (!hunk || typeof hunk !== 'object') return hunk;
              const record = { ...(hunk as Record<string, unknown>) };
              let hunkChanged = false;
              for (const key of ['old', 'new', 'content'] as const) {
                if (typeof record[key] === 'string' && (record[key] as string).length > ASSISTANT_WRITE_COMPACT_THRESHOLD) {
                  record[key] = `[compacted ${key}: ${(record[key] as string).length} chars]`;
                  hunkChanged = true;
                }
              }
              if (hunkChanged) listChanged = true;
              return hunkChanged ? record : hunk;
            });
            if (listChanged) {
              args[field] = nextList;
              blockChanged = true;
            }
          }
        } else if (entry.name === 'edit_file') {
          for (const key of ['original', 'updated'] as const) {
            if (typeof args[key] === 'string' && (args[key] as string).length > ASSISTANT_EDIT_COMPACT_THRESHOLD) {
              args[key] = `[compacted ${key}: ${(args[key] as string).length} chars]`;
              blockChanged = true;
            }
          }
        } else if (entry.name === 'patch_lines') {
          if (typeof args.replacement === 'string' && args.replacement.length > ASSISTANT_EDIT_COMPACT_THRESHOLD) {
            const target = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'file';
            args.replacement = `[compacted patch_lines replacement: ${args.replacement.length} chars for ${target}]`;
            blockChanged = true;
          }
        }
        return blockChanged ? { ...entry, args } : entry;
      });
      if (!blockChanged) return fullMatch;
      const serialized = JSON.stringify(Array.isArray(parsed) ? nextCalls : nextCalls[0]);
      const replacement = `\`\`\`shadrox:tools\n${serialized}\n\`\`\``;
      if (replacement.length >= fullMatch.length) return fullMatch;
      mutated = true;
      return replacement;
    } catch {
      return fullMatch;
    }
  });
  return mutated ? compacted : content;
}

/** One observation → "[compacted] tool → ok/err: head of what it said". */
export function summarizeObservation(content: string): string {
  const match = content.match(OBSERVATION_FENCE);
  const lines: string[] = [];
  if (match) {
    try {
      const parsed = JSON.parse(match[1]) as Array<{ tool?: string; ok?: boolean; result?: string; error?: string; path?: string }>;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const name = typeof entry.tool === 'string' ? entry.tool : 'tool';
          const body = entry.ok ? entry.result ?? '' : entry.error ?? '';
          // Keep the exact path verbatim so the agent can see which file it
          // already read/edited and never spends tokens re-reading it.
          const path = typeof entry.path === 'string' && entry.path.trim() ? ` ${entry.path.trim()}` : '';
          lines.push(`${name}${path} → ${entry.ok ? 'ok' : 'error'}: ${flatHead(String(body), SUMMARY_ENTRY_CHARS)}`);
        }
      }
    } catch {
      /* fall through to the raw head below */
    }
  }
  if (lines.length === 0) lines.push(flatHead(content, SUMMARY_ENTRY_CHARS * 2));
  // A refusal/cut note appended after the fence is a decision, not bulk: keep it.
  const also = content.indexOf('\n\nAlso: ');
  if (also >= 0) lines.push(`note: ${flatHead(content.slice(also + 8), 300)}`);
  const summary = `[compacted observation — earlier tool results, summarized to what was found/decided]\n${lines.join('\n')}`;
  return summary.length <= SUMMARY_MESSAGE_CHARS ? summary : `${summary.slice(0, SUMMARY_MESSAGE_CHARS)}…`;
}

export interface CompactionResult {
  messages: ChatTurn[];
  /** How many observations were summarized; 0 means the transcript is untouched. */
  compacted: number;
}

export const WORKING_MEMORY_HEADER = '[WORKING MEMORY — PINNED ACROSS COMPACTION]';
const MAX_WORKING_MEMORY_CHARS = 3_600;

export interface WorkingMemoryRange {
  path: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
}

export interface WorkingMemoryEdit {
  path: string;
  op: string;
}

export interface WorkingMemoryState {
  inspectedRanges: WorkingMemoryRange[];
  completedEdits: WorkingMemoryEdit[];
  pendingRequirements: string[];
  latestDiagnostics: string[];
}

export function isWorkingMemoryContent(content: string): boolean {
  return content.trimStart().startsWith(WORKING_MEMORY_HEADER);
}

export function isWorkingMemoryMessage(turn: Pick<ChatTurn, 'role' | 'content'>): boolean {
  return (turn.role === 'user' || turn.role === 'system') && isWorkingMemoryContent(turn.content);
}

export function formatWorkingMemoryMessage(state: WorkingMemoryState): string {
  const sections: string[] = [WORKING_MEMORY_HEADER];

  if (state.pendingRequirements.length > 0) {
    sections.push(
      'Pending requirements:\n' +
        state.pendingRequirements.slice(0, 16).map((req) => `- ${req.slice(0, 180)}`).join('\n')
    );
  }

  if (state.completedEdits.length > 0) {
    const byPath = new Map<string, string>();
    for (const edit of state.completedEdits) {
      byPath.set(edit.path, edit.op);
    }
    const items = [...byPath.entries()].slice(-24).map(([path, op]) => `- ${path} (${op})`);
    sections.push(`Completed edits:\n${items.join('\n')}`);
  }

  if (state.inspectedRanges.length > 0) {
    const byKey = new Map<string, WorkingMemoryRange>();
    for (const range of state.inspectedRanges) {
      const span = range.startLine !== undefined || range.endLine !== undefined
        ? `${range.startLine ?? 1}-${range.endLine ?? '?'}`
        : 'full';
      byKey.set(`${range.path}#${span}`, range);
    }
    const items = [...byKey.values()].slice(-20).map((range) => {
      if (range.startLine !== undefined || range.endLine !== undefined) {
        const total = range.totalLines !== undefined ? ` of ${range.totalLines}` : '';
        return `- ${range.path} (lines ${range.startLine ?? 1}-${range.endLine ?? '?'}${total})`;
      }
      return `- ${range.path}`;
    });
    sections.push(`Inspected files/ranges:\n${items.join('\n')}`);
  }

  if (state.latestDiagnostics.length > 0) {
    sections.push(
      'Latest diagnostics/failures:\n' +
        state.latestDiagnostics.slice(-10).map((line) => `- ${line.slice(0, 200)}`).join('\n')
    );
  }

  const text = sections.join('\n\n');
  return text.length <= MAX_WORKING_MEMORY_CHARS
    ? text
    : `${text.slice(0, MAX_WORKING_MEMORY_CHARS - 1)}…`;
}

export function upsertWorkingMemory(messages: ChatTurn[], state: WorkingMemoryState): ChatTurn[] {
  const content = formatWorkingMemoryMessage(state);
  const existingIndex = messages.findIndex((turn) => isWorkingMemoryMessage(turn));
  if (existingIndex >= 0) {
    if (messages[existingIndex].content === content) return messages;
    return messages.map((turn, index) => (index === existingIndex ? { ...turn, content } : turn));
  }
  const entry: ChatTurn = { role: 'user', content };
  if (messages.length === 0) return [entry];
  return [messages[0], entry, ...messages.slice(1)];
}

/**
 * Summarizes old observations once the transcript passes the trigger share of
 * the budget. Below the trigger the SAME array is returned, so a short turn
 * pays nothing and keeps byte-identical prompts for provider caching.
 */
export function compactToolObservations(messages: ChatTurn[], budget = LOOP_CONTEXT_BUDGET_CHARS): CompactionResult {
  const total = transcriptChars(messages);
  if (total <= budget * COMPACT_TRIGGER_SHARE) return { messages, compacted: 0 };
  const observationIndices: number[] = [];
  const assistantToolIndices: number[] = [];
  messages.forEach((turn, index) => {
    if (isToolObservation(turn) && !isWorkingMemoryMessage(turn)) observationIndices.push(index);
    else if (isAssistantToolTurn(turn)) assistantToolIndices.push(index);
  });
  const recentObsStart = Math.max(0, observationIndices.length - KEEP_RECENT_OBSERVATIONS);
  const compactableObs = new Set(observationIndices.slice(0, recentObsStart));
  const recentObs = new Set(observationIndices.slice(recentObsStart));
  const recentAssistantStart = Math.max(0, assistantToolIndices.length - KEEP_RECENT_OBSERVATIONS);
  const compactableAssistant = new Set(assistantToolIndices.slice(0, recentAssistantStart));
  let compacted = 0;
  const next = messages.map((turn, index) => {
    if (turn.content.length < MIN_COMPACT_CHARS) return turn;
    if (compactableObs.has(index)) {
      // Old observations → summarized to what was found/decided.
      compacted += 1;
      return { ...turn, content: summarizeObservation(turn.content) };
    }
    if (recentObs.has(index)) {
      // Newest observations stay but are individually capped.
      const capped = capObservation(turn.content);
      if (capped !== turn.content) compacted += 1;
      return { ...turn, content: capped };
    }
    if (compactableAssistant.has(index)) {
      const shortened = summarizeAssistantToolPayload(turn.content);
      if (shortened !== turn.content) compacted += 1;
      return { ...turn, content: shortened };
    }
    return turn;
  });
  return compacted > 0 ? { messages: next, compacted } : { messages, compacted: 0 };
}

/** Truncate one observation to the per-observation cap, keeping head and tail. */
function capObservation(content: string): string {
  if (content.length <= CAP_RECENT_OBSERVATION_CHARS) return content;
  const marker = `\n… [observation trimmed, ${content.length} chars total; head and tail kept] …\n`;
  const headChars = Math.floor((CAP_RECENT_OBSERVATION_CHARS - marker.length) * 0.6);
  const tailChars = CAP_RECENT_OBSERVATION_CHARS - marker.length - headChars;
  const head = content.slice(0, headChars);
  const tail = tailChars > 0 ? content.slice(-tailChars) : '';
  return `${head}${marker}${tail}`;
}

export function hardCapChatHistory(messages: ChatTurn[], maxMessages = 90): ChatTurn[] {
  if (messages.length <= maxMessages) return messages;
  const pinnedIndices = new Set<number>();
  let foundFirstUser = false;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'system' || m.content.includes('WORKSPACE TOOLS')) {
      pinnedIndices.add(i);
      continue;
    }
    if (!foundFirstUser && m.role === 'user' && !isWorkingMemoryMessage(m)) {
      pinnedIndices.add(i);
      foundFirstUser = true;
      continue;
    }
    if (isWorkingMemoryMessage(m)) {
      pinnedIndices.add(i);
    }
  }
  const tailSlots = Math.max(10, maxMessages - pinnedIndices.size);
  const tailStart = Math.max(0, messages.length - tailSlots);
  const kept: ChatTurn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (pinnedIndices.has(i) || i >= tailStart) {
      kept.push(messages[i]);
    }
  }
  return kept;
}