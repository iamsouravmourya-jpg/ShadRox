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
const SUMMARY_ENTRY_CHARS = 160;
const SUMMARY_MESSAGE_CHARS = 1_800;
const MIN_COMPACT_CHARS = 400;

/**
 * Computes an appropriate character budget for intermediate tool-loop
 * transcripts from the active model's context window so smaller/free BYOK
 * models compact stale file dumps before overflowing their window.
 */
export function computeLoopContextBudgetChars(
  contextWindowTokens: number,
  reservedOutputTokens = 4_096,
  systemInstructionChars = 0
): number {
  const usableTokens = Math.max(2_000, contextWindowTokens - Math.max(512, reservedOutputTokens));
  const systemTokens = Math.ceil(Math.max(0, systemInstructionChars) / 4);
  const loopTokens = Math.max(5_000, Math.floor((usableTokens - systemTokens) * 0.75));
  return Math.max(MIN_LOOP_CONTEXT_BUDGET_CHARS, Math.min(LOOP_CONTEXT_BUDGET_CHARS, loopTokens * 4));
}

const OBSERVATION_FENCE = /```shadrox:results\r?\n([\s\S]*?)\r?\n```/;
const DATA_MARKERS = /\[\[SHADROX_UNTRUSTED_DATA_(?:BEGIN|END)\]\]/g;

export function transcriptChars(messages: ChatTurn[]): number {
  return messages.reduce((total, turn) => total + turn.content.length, 0);
}

export function isToolObservation(turn: ChatTurn): boolean {
  return turn.role === 'user' && turn.content.includes('```shadrox:results');
}

function flatHead(text: string, limit: number): string {
  const flat = text.replace(DATA_MARKERS, '').replace(/\\\[\[/g, '[[').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** One observation → "[compacted] tool → ok/err: head of what it said". */
export function summarizeObservation(content: string): string {
  const match = content.match(OBSERVATION_FENCE);
  const lines: string[] = [];
  if (match) {
    try {
      const parsed = JSON.parse(match[1]) as Array<{ tool?: string; ok?: boolean; result?: string; error?: string }>;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const name = typeof entry.tool === 'string' ? entry.tool : 'tool';
          const body = entry.ok ? entry.result ?? '' : entry.error ?? '';
          lines.push(`${name} → ${entry.ok ? 'ok' : 'error'}: ${flatHead(String(body), SUMMARY_ENTRY_CHARS)}`);
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

/**
 * Summarizes old observations once the transcript passes the trigger share of
 * the budget. Below the trigger the SAME array is returned, so a short turn
 * pays nothing and keeps byte-identical prompts for provider caching.
 */
export function compactToolObservations(messages: ChatTurn[], budget = LOOP_CONTEXT_BUDGET_CHARS): CompactionResult {
  const total = transcriptChars(messages);
  if (total <= budget * COMPACT_TRIGGER_SHARE) return { messages, compacted: 0 };
  const observationIndices: number[] = [];
  messages.forEach((turn, index) => {
    if (isToolObservation(turn)) observationIndices.push(index);
  });
  const compactable = observationIndices.slice(0, Math.max(0, observationIndices.length - KEEP_RECENT_OBSERVATIONS));
  let compacted = 0;
  const next = messages.map((turn, index) => {
    if (!compactable.includes(index) || turn.content.length < MIN_COMPACT_CHARS) return turn;
    compacted += 1;
    return { ...turn, content: summarizeObservation(turn.content) };
  });
  return compacted > 0 ? { messages: next, compacted } : { messages, compacted: 0 };
}