import type { ChatMessage } from './types';
import { RESULT_FENCE, TOOL_FENCE, stripToolBlocks } from './agent/toolProtocol';
import { estimateTokens, messageBudgetChars, TRIM_TO_LEN } from './contextBudget';
import { resolveTarget } from './markdown';
import { SEARCH_ORIGINAL_MARKER, parseSearchReplaceBlocks } from './patchEngine';

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
 * Everything here is deterministic and idempotent: no ordering by length, no
 * sampling, no model call. Compacting an already compacted history is a no-op
 * that hands the caller back its own array reference.
 */

export const DEFAULT_KEEP_RECENT = 4;

/** Share of the message budget the folded history may still occupy. */
export const HISTORY_BUDGET_RATIO = 0.5;

const PROSE_KEEP_CHARS = 700;
const MIN_FILE_BODY_LINES = 12;
const MAX_ACK_CHARS = 24;

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
    return {
      content: folded,
      changed: folded !== content,
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

/**
 * Folds the machine payload out of every message older than `keepRecent`, then
 * drops the oldest folded messages until the history fits `maxHistoryChars`. The
 * newest message always survives, and so does any message that still carries an
 * edit — that is the information a fold cannot invent again later.
 */
export function compactHistory(
  messages: ChatMessage[],
  options: CompactionOptions
): CompactedHistory {
  const keepRecent = Math.max(0, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const cutoff = Math.max(0, messages.length - keepRecent);
  const newest = messages.length - 1;

  const kept: Array<{ message: ChatMessage; patch: boolean }> = [];
  let toolBlocks = 0;
  let fileBodies = 0;
  let proseFolded = 0;
  let acknowledgements = 0;
  let emptied = 0;

  messages.forEach((message, index) => {
    if (index >= cutoff || index === newest) {
      kept.push({ message, patch: true });
      return;
    }
    if (message.role === 'user' && isAcknowledgement(message.content)) {
      acknowledgements += 1;
      return;
    }

    const outcome = foldOldMessage(message, options.patchedMessageIds);
    if (!outcome.changed) {
      kept.push({ message, patch: outcome.patch });
      return;
    }

    toolBlocks += outcome.toolBlocks;
    fileBodies += outcome.fileBodies;
    if (outcome.proseFolded) proseFolded += 1;

    if (!outcome.content.trim() && !outcome.patch) {
      emptied += 1;
      return;
    }
    kept.push({ message: { ...message, content: outcome.content }, patch: outcome.patch });
  });

  if (toolBlocks + fileBodies + proseFolded + acknowledgements + emptied === 0) {
    return { messages, tokensSaved: 0, folds: [] };
  }

  const budget = options.maxHistoryChars
    ?? Math.floor(messageBudgetChars(options.contextWindow) * HISTORY_BUDGET_RATIO);
  let chars = kept.reduce((sum, entry) => sum + entry.message.content.length, 0);
  let dropped = 0;

  while (chars > budget) {
    const victim = kept.findIndex((entry, index) => !entry.patch && index < kept.length - 1);
    if (victim === -1) break;
    chars -= kept[victim].message.content.length;
    kept.splice(victim, 1);
    dropped += 1;
  }

  const folds: string[] = [];
  if (toolBlocks > 0) folds.push(`folded ${plural(toolBlocks, 'tool round')}`);
  if (fileBodies > 0) folds.push(`dropped ${plural(fileBodies, 'stale file body', 'stale file bodies')}`);
  if (proseFolded > 0) folds.push(`shortened ${plural(proseFolded, 'old reply')}`);
  if (acknowledgements > 0) folds.push(`collapsed ${plural(acknowledgements, 'acknowledgement message')}`);
  if (emptied > 0) folds.push(`dropped ${plural(emptied, 'emptied message')}`);
  if (dropped > 0) folds.push(`dropped ${plural(dropped, 'oldest message')} to fit the budget`);

  const compacted = kept.map((entry) => entry.message);
  return {
    messages: compacted,
    tokensSaved: Math.max(0, tokensOf(messages) - tokensOf(compacted)),
    folds
  };
}
