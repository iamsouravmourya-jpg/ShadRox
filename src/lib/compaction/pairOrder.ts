/**
 * The single documented drop/trim order for a ShadRox conversation history.
 *
 * It merges two upstream lineages that ShadRox already ports separately, and it
 * is the order that BOTH stages now actually run in:
 *
 * - Cline's context management (`reference/cline-main/sdk/packages/core/src/
 *   extensions/context/basic-compaction.ts`, Apache-2.0 License, Copyright (c)
 *   2025 Cline / Bot AI, Inc.), specifically the fold policy documented there
 *   as "Typed user prompts always survive. The latest typed turn keeps its
 *   newest messages verbatim within the token target, dropping only the oldest
 *   ones (the kept suffix starts at an assistant message so no tool pair is
 *   split). Older turns keep their concluding assistant answer when it fits,
 *   newest turns first. Everything else is dropped", plus
 *   `sanitizeOlderAssistantFinal` (thinking/machine payload of an OLD turn goes
 *   before its prose) and `mergeAdjacentUserTurns` (work dropped in a gap is
 *   re-surfaced as a summary on the surviving prompt).
 * - OpenHands' condenser policy (`./openhands.ts`, MIT), which owns the
 *   keep-head / keep-tail / condense-the-middle shape and the pair rule
 *   "an observation travels with the action that produced it".
 *
 * ## THE ORDER (stages 0-6, cheapest-to-lose first)
 *
 * 0. `volatile_tail`  — the newest turn: never trimmed, never dropped. (Both
 *    lineages; aider's `cur` chunk is excluded from the cache prefix too.)
 * 1. `tool_payload`   — tool-call/tool-result fence BODIES of old turns. Folded
 *    to one-line notes before any prose is touched, because a folded fence
 *    still says what ran while its text is pure machine noise. Whole pair
 *    groups move together (Cline atomic pair removal / OpenHands
 *    TruncatingCondenser), so a result is never left pointing at a call that
 *    was cut away.
 * 2. `old_turn_work`  — the middle of the history: condensed into a digest
 *    (OpenHands) rather than deleted, so the shape of what happened survives.
 * 3. `assistant_prose`— older assistant prose (Void's ×10 role weight is the
 *    same verdict from the other direction).
 * 4. `user_ask`       — older typed user asks, shrunk only down to
 *    `USER_ASK_MIN_CHARS`, and only after stages 1-3 are exhausted.
 * 5. `head`           — the protected head (`keepFirstHead`): the original
 *    request. Escalated into only as the hard-context-reset last resort.
 * 6. `system_block`   — rules/repo-map/contract: never shrunk here at all.
 *    Only `capSystemInstruction()`/`fitSystemContext()` may degrade it, and
 *    from the weakest retrieval chunk inward.
 *
 * ## WHERE THE TWO LINEAGES CONFLICT, AND WHICH ONE SHADROX KEEPS
 *
 * Cline grants a typed user prompt *absolute* immunity; OpenHands' condenser
 * digests the middle of the archive, which includes the asks that sit in it,
 * and ShadRox's own trimmer has to be able to survive a single pasted 500k-char
 * file in the one user message of a brand-new chat (`contextBudget.test.ts`
 * pins that). Absolute immunity would overflow the window instead.
 * So: OpenHands' digest wins for the middle (a digest still quotes the first
 * ask verbatim — see `buildCondensationDigest`), and Cline's "asks are the last
 * thing to lose" survives as a *floor plus stage order* rather than immunity.
 * The head rule is the same resolution in miniature: Cline keeps the oldest
 * typed prompts verbatim as archive, OpenHands protects only `keep_first`;
 * ShadRox keeps OpenHands' numeric head, because the digest of a condensed run
 * is what carries an older ask once it leaves.
 */

/** Stage identifiers, in the order the stages are spent. */
export const TRIM_ORDER = [
  'volatile_tail',
  'tool_payload',
  'old_turn_work',
  'assistant_prose',
  'user_ask',
  'head',
  'system_block'
] as const;

export type TrimStage = (typeof TRIM_ORDER)[number];

/**
 * Characters of a typed user ask the trimmer will not cut below while any
 * earlier stage still has room (Cline's "prompts survive", made arithmetic).
 */
export const USER_ASK_MIN_CHARS = 600;

/** Shortest body a preserved tool fence may hold. */
const MIN_FENCE_BODY_CHARS = 40;

/**
 * Stage a message belongs to. Used as the primary victim ranking; the weighted
 * score inside it is the existing Void greedy tie-breaker.
 */
export function trimStageOf(role: 'user' | 'assistant' | 'system', content: string): TrimStage {
  if (role === 'system') return 'system_block';
  if (hasToolFence(content)) return 'tool_payload';
  return role === 'assistant' ? 'assistant_prose' : 'user_ask';
}

/**
 * The stage of a UI `ChatMessage`, whose assistant role is spelled `model` and
 * which is not typed as a `BudgetedMessage` here so this module stays free of
 * the app types.
 */
export function trimStageOfMessage(message: { role: string; content: string }): TrimStage {
  const role = message.role === 'system' ? 'system' : message.role === 'model' ? 'assistant' : 'user';
  return trimStageOf(role, message.content);
}

/** Rank of a stage in `TRIM_ORDER` — higher goes first. */
export function trimStageRank(stage: TrimStage): number {
  return TRIM_ORDER.length - TRIM_ORDER.indexOf(stage);
}

const TOOL_FENCE_MARK = '```shadrox:tools';
const RESULT_FENCE_MARK = '```shadrox:results';

/** True when a message carries a tool-call or tool-result fence. */
export function hasToolFence(content: string): boolean {
  return content.includes(TOOL_FENCE_MARK) || content.includes(RESULT_FENCE_MARK);
}

/**
 * Pair groups over an anchor array (`observationAnchors` output): every message
 * travels with the one it answers, so a group is dropped or folded as a unit.
 * Groups come back in position order, oldest first.
 */
export function pairGroupsFromAnchors(anchors: readonly number[]): number[][] {
  const byAnchor = new Map<number, number[]>();
  anchors.forEach((anchor, index) => {
    const key = anchor >= 0 && anchor < anchors.length ? anchor : index;
    const list = byAnchor.get(key) ?? [];
    list.push(index);
    byAnchor.set(key, list);
  });
  return [...byAnchor.values()];
}

/** Group indices for a plain `{role, content}` history. */
export function pairGroups(contents: readonly string[]): number[][] {
  return pairGroupsFromAnchors(pairAnchorIndices(contents));
}

/**
 * The pair rule, imported from the OpenHands port so there is exactly one
 * implementation of it in the app (kept inline rather than imported to avoid a
 * module cycle with `contextBudget`, which this file is loaded from).
 *
 * Walking the archive: a message issuing tool calls becomes the anchor for the
 * results that follow it; the walk breaks on any prose message, because a new
 * exchange opens a new pair.
 */
export function pairAnchorIndices(contents: readonly string[]): number[] {
  const anchors: number[] = [];
  let anchor = -1;
  contents.forEach((content, index) => {
    if (content.includes(TOOL_FENCE_MARK)) {
      anchor = index;
      anchors.push(index);
    } else if (content.includes(RESULT_FENCE_MARK)) {
      anchors.push(anchor === -1 ? index : anchor);
    } else {
      anchor = -1;
      anchors.push(index);
    }
  });
  return anchors;
}

interface Segment {
  /** Raw text, fences included. */
  text: string;
  fence: boolean;
}

/** Split into prose runs and complete ``` fence blocks (same convention as ./compaction.ts). */
function segments(content: string): Segment[] {
  const lines = content.split('\n');
  const out: Segment[] = [];
  let prose: string[] = [];
  let index = 0;

  const flush = () => {
    if (prose.length === 0) return;
    const text = prose.join('\n');
    prose = [];
    if (text.trim()) out.push({ text, fence: false });
  };

  while (index < lines.length) {
    if (!lines[index].trim().startsWith('```')) {
      prose.push(lines[index]);
      index += 1;
      continue;
    }
    flush();
    const body: string[] = [lines[index]];
    index += 1;
    while (index < lines.length && !lines[index].trim().startsWith('```')) {
      body.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      body.push(lines[index]);
      index += 1;
    } else {
      // Unterminated fence: the pair is still open, so it must not be cut.
      body.push('```');
    }
    out.push({ text: body.join('\n'), fence: true });
  }
  flush();
  return out;
}

/**
 * Shrink one message without ever deleting a tool fence: the opening/closing
 * lines of every block survive, the body inside them gets the budget, and prose
 * outside the blocks is what goes first. This is the difference between a
 * history that still means "I ran read_file, here is what came back" and one
 * that leaves a result whose call was cut away.
 *
 * Fence-free content keeps the historical byte-exact behaviour: the first
 * `budget` characters plus `'...'`.
 */
export function pairSafeShrink(content: string, budget: number): string {
  const blocks = segments(content);
  const fenced = blocks.some((block) => block.fence);
  if (!fenced) {
    return content.length <= budget ? content : `${content.slice(0, budget)}...`;
  }

  let proseLeft = Math.max(0, budget);
  let foldedChars = 0;
  const kept: string[] = [];

  blocks.forEach((block) => {
    if (!block.fence) {
      if (block.text.length <= proseLeft) {
        proseLeft -= block.text.length;
        kept.push(block.text);
        return;
      }
      const head = block.text.slice(0, proseLeft);
      foldedChars += block.text.length - head.length;
      proseLeft = 0;
      if (head.trim()) kept.push(head);
      return;
    }

    const lines = block.text.split('\n');
    const open = lines[0];
    const close = lines[lines.length - 1];
    const body = lines.slice(1, lines.length - 1).join('\n');
    const room = Math.max(MIN_FENCE_BODY_CHARS, budget);
    if (body.length <= room) {
      kept.push(block.text);
      return;
    }
    foldedChars += body.length - room;
    kept.push(`${open}\n${body.slice(0, room)}\n[… ${body.length - room} chars of this block folded]\n${close}`);
  });

  const text = kept.filter((part) => part.trim()).join('\n\n');
  return foldedChars > 0 ? `${text}\n[… ${foldedChars} chars folded, tool blocks preserved]` : text;
}

/**
 * The smallest form this message can take without breaking a tool pair. The
 * trimmer treats it as "already at floor", which is also what stops its greedy
 * loop from spinning on a message that cannot shrink further.
 */
export function pairFloorChars(content: string, trimToLen: number): number {
  if (!hasToolFence(content)) return trimToLen;
  return Math.min(content.length, pairSafeShrink(content, trimToLen).length);
}

/** Human-readable summary of the stages this pass spent, for the UI notice. */
export function trimStageNote(stages: readonly TrimStage[]): string {
  if (stages.length === 0) return '';
  const names: Record<TrimStage, string> = {
    volatile_tail: 'the current turn',
    tool_payload: 'tool call/result bodies',
    old_turn_work: 'older turn summaries',
    assistant_prose: 'older replies',
    user_ask: 'older requests',
    head: 'the original request',
    system_block: 'rules and repo map'
  };
  return stages.map((stage) => names[stage]).join(', ');
}
