import type { ChatMessage } from './types';
import { RESULT_FENCE, TOOL_FENCE, stripToolBlocks } from './agent/toolProtocol';
import { estimateTokens, messageBudgetChars, TRIM_TO_LEN } from './contextBudget';
import { resolveTarget } from './markdown';
import { SEARCH_ORIGINAL_MARKER, parseSearchReplaceBlocks } from './patchEngine';
import {
  CONDENSER_MINIMUM_PROGRESS,
  DEFAULT_KEEP_FIRST_HEAD,
  buildCondensationDigest,
  computeLocks,
  condensationPrompt,
  observationAnchors,
  transcriptOf
} from './compaction/openhands';
import { TRIM_ORDER, pairGroupsFromAnchors, trimStageNote, trimStageOfMessage, type TrimStage } from './compaction/pairOrder';

/**
 * LLM-free history compaction: the step that runs before trimMessagesToBudget().
 *
 * The trimmer only ever cuts a message down to `TRIM_TO_LEN` chars, so a long
 * session loses the *shape* of what already happened. Compaction instead folds
 * the parts of an old turn that were only ever machine payload — tool fences and
 * pasted file bodies — into one-line notes, so the turn still means something to
 * the model while costing a fraction of the tokens.
 *
 * An edit block is never folded away, reviewed or not: the SEARCH/REPLACE bodies
 * are the one thing in a turn the model cannot reconstruct from the file on disk,
 * because the file may have moved on since.
 *
 * When the folded history still overruns the budget, the second stage is the
 * OpenHands condenser lineage, ported in ./compaction/openhands.ts (MIT):
 * keep the head (the original requests, keep_first), keep the tail (the recent
 * turns), condense the middle into one digest per run, drop single messages
 * only when condensation cannot reach minimum progress — and escalate into the
 * head as a last resort, the analogue of the upstream hard context reset.
 *
 * * which one goes, in which order * is one documented answer: the stages in
 * ./compaction/pairOrder.ts (Cline's context-management drop order merged with
 * the OpenHands condenser policy). This stage spends them positionally oldest-
 * first — a digest of the oldest middle beats a digest of a newer tool round —
 * while ./contextBudget.ts spends them by stage. Both use the same pair
 * grouping, so a tool call and its observation cannot be split by either stage.
 *
 * Everything here is deterministic and idempotent: no ordering by length, no
 * sampling, no model call. Compacting an already compacted history is a no-op
 * that hands the caller back its own array reference. Byte-stable output for a
 * byte-stable history is deliberate: it keeps the provider prompt cache warm,
 * which is what actually saves credits.
 */

export const DEFAULT_KEEP_RECENT = 4;

/** Share of the message budget the folded history may still occupy. */
export const HISTORY_BUDGET_RATIO = 0.5;

const PROSE_KEEP_CHARS = 700;
const MIN_FILE_BODY_LINES = 12;
const MAX_ACK_CHARS = 24;
/** One digest's worth of slack, so a condensation event lands under budget. */
const DIGEST_SLACK_CHARS = 200;

export interface CompactedHistory {
  messages: ChatMessage[];
  tokensSaved: number;
  folds: string[];
}

export interface CompactionOptions {
  contextWindow: number;
  /** Newest messages that pass through byte-identical. Defaults to 4. */
  keepRecent?: number;
  /** Ceiling for the whole history; defaults to half the message budget. */
  maxHistoryChars?: number;
  /**
   * Ids of messages whose edits are still awaiting review. `ChatMessage` carries
   * no patches of its own — App keeps them in `patchSets` keyed by message id —
   * so the caller hands that set over for the "never drop a patched message" rule.
   */
  patchedMessageIds?: ReadonlySet<string>;
  /**
   * OpenHands keep_first, adapted: how many of the oldest messages are always
   * kept when condensing (default 2 ≈ upstream's 4 events). 0 disables the
   * head protection and restores the old plain oldest-drops-first behaviour.
   */
  keepFirstHead?: number;
  /**
   * Optional synchronous summarizer seam for the condenser pass. ShadRox's
   * compaction runs inside a synchronous dispatch path and uses no LLM call
   * today, so the seam stays synchronous: give it one and the middle runs are
   * summarized by whatever you wire (a cached small-model call, a template);
   * without one the deterministic extractive digest is used, and a run whose
   * summary would not reach minimum progress falls back to plain dropping.
   */
  condenseSummarizer?: (prompt: string) => string;
}

interface Fence {
  text: string;
  info: string;
  bodyLines: string[];
  terminated: boolean;
  patch: boolean;
  path: string | null;
}

type Segment = { prose: string } | { fence: Fence };

interface FoldOutcome {
  content: string;
  changed: boolean;
  toolBlocks: number;
  fileBodies: number;
  proseFolded: boolean;
  patch: boolean;
}

const RESULT_FENCE_PATTERN = new RegExp(
  '```[ \\t]*' + RESULT_FENCE + '[ \\t]*\\r?\\n[\\s\\S]*?```',
  'g'
);

const ACKNOWLEDGEMENTS = new Set([
  'ok', 'okay', 'kk', 'k', 'yes', 'yeah', 'yep', 'yes please',
  'continue', 'please continue', 'carry on', 'go on', 'go ahead', 'proceed', 'next',
  'theek hai', 'thik hai', 'theek hain', 'theek hai ji', 'haan', 'ji haan', 'kar do',
  'got it', 'understood', 'thanks', 'thank you', 'nice', 'good'
]);

/**
 * The same fence convention as patchEngine's scanner, kept local because a fold
 * has to splice replacement lines back in where the fence stood.
 */
function scanSegments(content: string): Segment[] {
  const lines = content.split('\n');
  const segments: Segment[] = [];
  let prose: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim().startsWith('```')) {
      prose.push(line);
      index += 1;
      continue;
    }

    if (prose.length > 0) {
      segments.push({ prose: prose.join('\n') });
      prose = [];
    }

    const info = line.trim().slice(3);
    const bodyLines: string[] = [];
    let close = index + 1;
    while (close < lines.length && !lines[close].trim().startsWith('```')) {
      bodyLines.push(lines[close]);
      close += 1;
    }
    const terminated = close < lines.length;
    const body = bodyLines.join('\n');

    segments.push({
      fence: {
        text: lines.slice(index, terminated ? close + 1 : lines.length).join('\n'),
        info,
        bodyLines,
        terminated,
        patch: body.includes(SEARCH_ORIGINAL_MARKER) || parseSearchReplaceBlocks(body).length > 0,
        path: resolveTarget(info, '', body, [])
      }
    });
    index = terminated ? close + 1 : lines.length;
  }

  if (prose.length > 0) segments.push({ prose: prose.join('\n') });
  return segments;
}

function isToolTag(info: string): boolean {
  const tag = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return tag === TOOL_FENCE || tag === RESULT_FENCE;
}

function countToolFences(content: string): number {
  return scanSegments(content).filter((segment) => 'fence' in segment && isToolTag(segment.fence.info)).length;
}

function hasEditFence(segments: Segment[], includeRewrites: boolean): boolean {
  return segments.some((segment) =>
    'fence' in segment && (segment.fence.patch || (includeRewrites && segment.fence.path !== null)));
}

function carriesPatches(message: ChatMessage, patchedIds?: ReadonlySet<string>): boolean {
  if (patchedIds?.has(message.id)) return true;
  const patches = (message as { patches?: readonly unknown[] }).patches;
  return Array.isArray(patches) && patches.length > 0;
}

function isAcknowledgement(content: string): boolean {
  if (content.length > MAX_ACK_CHARS) return false;
  const text = content
    .replace(/[*_`>#~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '');
  return ACKNOWLEDGEMENTS.has(text);
}

function summarizeActivity(activity: ChatMessage['toolActivity']): string {
  if (!activity || activity.length === 0) return '';
  const groups = new Map<string, { labels: string[]; failed: number }>();

  activity.forEach((entry) => {
    const label = entry.label.trim();
    const group = groups.get(entry.name) ?? { labels: [], failed: 0 };
    groups.set(entry.name, group);
    if (label && !group.labels.includes(label)) group.labels.push(label);
    if (!entry.ok) group.failed += 1;
  });

  const parts = [...groups].map(([name, group]) =>
    `${name}: ${group.labels.join(', ') || 'no target'}${group.failed > 0 ? ` (${group.failed} failed)` : ' (ok)'}`);
  return `[tools] ${parts.join('; ')}`;
}

function isStaleFileBody(fence: Fence): boolean {
  return fence.terminated && !fence.patch && fence.path !== null
    && fence.bodyLines.length > MIN_FILE_BODY_LINES;
}

function foldFileBody(fence: Fence): string {
  const droppedLines = fence.bodyLines.length - 1;
  return [
    `\`\`\`${fence.info}`,
    fence.bodyLines[0].slice(0, TRIM_TO_LEN),
    `[… body dropped, ${droppedLines} lines]`,
    '```'
  ].join('\n');
}

/** Keeps every fence verbatim and spends `budget` characters on the prose between them. */
function capProse(segments: Segment[], budget: number): { text: string; dropped: number } {
  const kept: string[] = [];
  let left = budget;
  let dropped = 0;

  segments.forEach((segment) => {
    if ('fence' in segment) {
      kept.push(segment.fence.text);
      return;
    }
    const prose = segment.prose.trim();
    if (!prose) return;

    if (prose.length <= left) {
      left -= prose.length;
      kept.push(prose);
      return;
    }
    const head = prose.slice(0, left);
    dropped += prose.length - head.length;
    if (head.trim()) kept.push(head);
    left = 0;
  });

  if (dropped > 0) kept.push(`[… prose folded, ${dropped} chars]`);
  return { text: kept.join('\n\n'), dropped };
}

function foldOldMessage(message: ChatMessage, patchedIds?: ReadonlySet<string>): FoldOutcome {
  const content = message.content;
  const blocks = countToolFences(content);
  const cleared = blocks > 0
    ? stripToolBlocks(content.replace(RESULT_FENCE_PATTERN, ''))
    : content;
  const segments = scanSegments(cleared);
  const isUser = message.role === 'user';
  const patch = carriesPatches(message, patchedIds) || hasEditFence(segments, !isUser);

  if (isUser) {
    let fileBodies = 0;
    const folded = segments
      .map((segment) => {
        if ('prose' in segment) return segment.prose;
        if (!isStaleFileBody(segment.fence)) return segment.fence.text;
        fileBodies += 1;
        return foldFileBody(segment.fence);
      })
      .join('\n');
    // A pasted observation that folds to nothing must still say what went: an
    // action whose only trace of an answer vanished reads as a lost result.
    const withNote = !folded.trim() && blocks > 0 && content.trim()
      ? `[tools] ${plural(blocks, 'tool result', 'tool results')} folded`
      : folded;
    return {
      content: withNote,
      changed: withNote !== content,
      toolBlocks: blocks,
      fileBodies,
      proseFolded: false,
      patch
    };
  }

  if (blocks === 0) {
    return { content, changed: false, toolBlocks: 0, fileBodies: 0, proseFolded: false, patch };
  }

  const prose = capProse(segments, PROSE_KEEP_CHARS);
  const summary = summarizeActivity(message.toolActivity) || `[tools] ${plural(blocks, 'tool block')} folded`;
  const folded = [summary, prose.text].filter((part) => part.trim()).join('\n\n');

  return {
    content: folded,
    changed: true,
    toolBlocks: blocks,
    fileBodies: 0,
    proseFolded: prose.dropped > 0,
    patch
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function tokensOf(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

interface KeptEntry {
  message: ChatMessage;
  /** Index of the original message, so pair anchors survive the fold's reindexing. */
  origin: number;
  /** Untouchable by the fit stage: head aside, this is the survivors' shield. */
  protected: boolean;
  /** The message still carries an edit block — counts into the digest's honesty line. */
  edits: boolean;
  /** True for a condenser digest; digests are never dropped by the fit loop. */
  digest: boolean;
}

function lockableView(entries: readonly KeptEntry[]): Array<{ message: ChatMessage; protected: boolean }> {
  return entries.map((entry) => ({ message: entry.message, protected: entry.protected || entry.digest }));
}

/**
 * Position-based pair anchors for the current `kept` array: an observation
 * travels with the action that produced it. The walk runs over the *original*
 * contents once (folding rewrites fences in place, so the raw history is the
 * only stable witness of who answered whom); an anchor whose action was itself
 * dropped degrades to no anchor.
 */
function fitAnchors(kept: readonly KeptEntry[], anchorByOrigin: ReadonlyMap<number, number>): number[] {
  const positionByOrigin = new Map<number, number>();
  kept.forEach((entry, index) => positionByOrigin.set(entry.origin, index));
  return kept.map((entry, index) => {
    const anchorOrigin = anchorByOrigin.get(entry.origin) ?? entry.origin;
    return positionByOrigin.get(anchorOrigin) ?? index;
  });
}

function locksFor(kept: readonly KeptEntry[], keepFirstHead: number, anchors: readonly number[]): boolean[] {
  return computeLocks(lockableView(kept), keepFirstHead, anchors);
}

function messageCarriesEdits(message: ChatMessage, patchedIds?: ReadonlySet<string>): boolean {
  if (carriesPatches(message, patchedIds)) return true;
  return hasEditFence(scanSegments(message.content), message.role !== 'user');
}

/**
 * The OpenHands keep-head-keep-tail condensation: the middle between the
 * protected head and the protected tail is forgotten oldest-first, each stretch
 * replaced in place by one digest — the `summary_offset` of the ported
 * CondensationEvent. Like upstream, only as much history as the budget overrun
 * demands is condensed (plus one entry of slack for the digest itself), so the
 * fit keeps the most recent context alive as long as it fits. A run that no
 * digest can shrink by minimum progress is left alone for the drop loop;
 * digest text is a pure function of the forgotten entries (plus the previous
 * digest, rolled forward), so the same history always produces the same bytes.
 */
function condenseRuns(
  kept: KeptEntry[],
  keepFirstHead: number,
  anchors: readonly number[],
  summarizer: ((prompt: string) => string) | undefined,
  preservedEdits: number,
  overrun: number
): { entries: KeptEntry[]; condensed: number; digests: number; savedChars: number } {
  const locked = locksFor(kept, keepFirstHead, anchors);
  const next: KeptEntry[] = [];
  let condensed = 0;
  let digests = 0;
  let savedChars = 0;
  let previousDigest: string | null = null;
  let index = 0;
  let pending = overrun;

  while (index < kept.length) {
    if (locked[index]) {
      next.push(kept[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < kept.length && !locked[end]) end += 1;
    const run = kept.slice(index, end);

    // OpenHands computes the summarize window from the overflow, not from the
    // whole middle: take the oldest entries that cover the overrun plus one
    // digest's worth of slack, and stop there.
    let take = 0;
    let seenChars = 0;
    while (take < run.length && (take === 0 || seenChars < pending + DIGEST_SLACK_CHARS)) {
      seenChars += run[take].message.content.length;
      take += 1;
    }
    // Never digest an action and strand its observation in the survivors:
    // grow the forgotten prefix over any entry anchored inside it.
    while (take < run.length && anchors[index + take] >= index && anchors[index + take] < index + take) {
      seenChars += run[take].message.content.length;
      take += 1;
    }
    const forgotten = run.slice(0, take);
    const remaining = run.slice(take);
    const runChars = forgotten.reduce((sum, entry) => sum + entry.message.content.length, 0);
    const foldable = forgotten.map((entry) => entry.message);
    const text = summarizer
      ? (summarizer(condensationPrompt(transcriptOf(foldable), previousDigest)).trim() ||
        buildCondensationDigest(foldable, preservedEdits, previousDigest))
      : buildCondensationDigest(foldable, preservedEdits, previousDigest);

    if (text.length >= runChars || runChars - text.length < CONDENSER_MINIMUM_PROGRESS * runChars) {
      next.push(...run);
      index = end;
      continue;
    }

    const first = forgotten[0].message;
    next.push({
      message: { ...first, id: `condensed:${first.id}`, content: text, toolActivity: undefined },
      origin: forgotten[0].origin,
      protected: true,
      edits: false,
      digest: true
    });
    next.push(...remaining);
    condensed += forgotten.length;
    digests += 1;
    savedChars += runChars - text.length;
    pending -= runChars - text.length;
    previousDigest = text;
    index = end;
  }

  return { entries: next, condensed, digests, savedChars };
}

/**
 * Folds the machine payload out of every message older than `keepRecent`, then
 * fits the history into `maxHistoryChars` with the ported condenser: condense
 * the middle into digests first (head and tail protected, tool-action/
 * observation pairs never split), drop single unprotected messages oldest-first
 * only when condensation cannot reach minimum progress, and escalate into the
 * head as the hard-reset last resort. The newest message always survives, and
 * so does any message that still carries an edit — that is the information a
 * fold cannot invent again later.
 */
export function compactHistory(
  messages: ChatMessage[],
  options: CompactionOptions
): CompactedHistory {
  const keepRecent = Math.max(0, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const keepFirstHead = Math.max(0, options.keepFirstHead ?? DEFAULT_KEEP_FIRST_HEAD);
  const cutoff = Math.max(0, messages.length - keepRecent);
  const newest = messages.length - 1;
  const anchorByOrigin = new Map<number, number>();
  observationAnchors(messages.map((message) => message.content))
    .forEach((anchor, origin) => anchorByOrigin.set(origin, anchor));

  const kept: KeptEntry[] = [];
  let toolBlocks = 0;
  let fileBodies = 0;
  let proseFolded = 0;
  let acknowledgements = 0;
  let emptied = 0;

  messages.forEach((message, index) => {
    if (index >= cutoff || index === newest) {
      kept.push({
        message,
        origin: index,
        protected: true,
        edits: messageCarriesEdits(message, options.patchedMessageIds),
        digest: false
      });
      return;
    }
    if (message.role === 'user' && isAcknowledgement(message.content)) {
      acknowledgements += 1;
      return;
    }

    const outcome = foldOldMessage(message, options.patchedMessageIds);
    if (!outcome.changed) {
      kept.push({ message, origin: index, protected: outcome.patch, edits: outcome.patch, digest: false });
      return;
    }

    toolBlocks += outcome.toolBlocks;
    fileBodies += outcome.fileBodies;
    if (outcome.proseFolded) proseFolded += 1;

    if (!outcome.content.trim() && !outcome.patch) {
      emptied += 1;
      return;
    }
    kept.push({
      message: { ...message, content: outcome.content },
      origin: index,
      protected: outcome.patch,
      edits: outcome.patch,
      digest: false
    });
  });

  if (toolBlocks + fileBodies + proseFolded + acknowledgements + emptied === 0) {
    return { messages, tokensSaved: 0, folds: [] };
  }

  const budget = options.maxHistoryChars
    ?? Math.floor(messageBudgetChars(options.contextWindow) * HISTORY_BUDGET_RATIO);
  let chars = kept.reduce((sum, entry) => sum + entry.message.content.length, 0);
  let dropped = 0;
  let condensed = 0;
  let digests = 0;

  if (chars > budget) {
    const outcome = condenseRuns(
      kept,
      keepFirstHead,
      fitAnchors(kept, anchorByOrigin),
      options.condenseSummarizer,
      kept.filter((entry) => entry.edits).length,
      chars - budget
    );
    kept.length = 0;
    kept.push(...outcome.entries);
    condensed = outcome.condensed;
    digests = outcome.digests;
    chars -= outcome.savedChars;
  }

  let guard = 0;
  const droppedStages = new Set<TrimStage>();
  while (chars > budget && guard < 100_000) {
    guard += 1;
    const anchors = fitAnchors(kept, anchorByOrigin);
    const locked = locksFor(kept, keepFirstHead, anchors);
    // Whole pair groups only: an action and its observation leave together or
    // not at all. This is the shared implementation of the rule — the same
    // grouping the trimmer in ./contextBudget.ts walks, so the two stages of
    // one fit pass cannot disagree about what a "turn" is (the documented order
    // lives in ./compaction/pairOrder.ts). Groups come out in position order,
    // so the oldest low-value block is always the first victim.
    const groups = pairGroupsFromAnchors(anchors);

    let victims = groups.find((members) => members.every((i) => !locked[i] && i < kept.length - 1));
    if (!victims) {
      // Last resort, the ported hard context reset: condensing and middle
      // drops cannot fit the budget, so unprotected history is dropped from
      // the head up. Edit carriers, digests, pair-mates of kept messages and
      // the newest message stay.
      victims = groups.find((members) =>
        members.every((i) => !kept[i].protected && !kept[i].digest && i < kept.length - 1));
    }
    if (!victims) break;
    for (const index of [...victims].sort((a, b) => b - a)) {
      droppedStages.add(trimStageOfMessage(kept[index].message));
      chars -= kept[index].message.content.length;
      kept.splice(index, 1);
      dropped += 1;
    }
  }

  const folds: string[] = [];
  if (toolBlocks > 0) folds.push(`folded ${plural(toolBlocks, 'tool round')}`);
  if (fileBodies > 0) folds.push(`dropped ${plural(fileBodies, 'stale file body', 'stale file bodies')}`);
  if (proseFolded > 0) folds.push(`shortened ${plural(proseFolded, 'old reply')}`);
  if (acknowledgements > 0) folds.push(`collapsed ${plural(acknowledgements, 'acknowledgement message')}`);
  if (emptied > 0) folds.push(`dropped ${plural(emptied, 'emptied message')}`);
  if (condensed > 0) {
    folds.push(`condensed ${plural(condensed, 'middle message', 'middle messages')} into ${plural(digests, 'digest')}`);
  }
  if (dropped > 0) {
    const note = trimStageNote([...droppedStages]);
    folds.push(note
      ? `dropped ${plural(dropped, 'oldest message')} to fit the budget (${note} go first, per the ${TRIM_ORDER.length}-stage order)`
      : `dropped ${plural(dropped, 'oldest message')} to fit the budget`);
  }

  const compacted = kept.map((entry) => entry.message);
  return {
    messages: compacted,
    tokensSaved: Math.max(0, tokensOf(messages) - tokensOf(compacted)),
    folds
  };
}
