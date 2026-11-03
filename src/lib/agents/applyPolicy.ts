/**
 * The apply policy: which of a turn's file changes may be written without asking.
 *
 * This module exists because a run used to apply whatever a model emitted with
 * `allowDestructive: true` and no review card, while the identical edit typed in
 * chat stopped for a click. That asymmetry meant an agent could quietly empty a
 * file the user never showed it. Here the rule is written once, in the open:
 *
 *   - `review` — nothing is written. Every change becomes a review card, exactly
 *     like a chat reply.
 *   - `auto`   — only changes that cannot lose the user's work: a brand-new file,
 *     or an edit to a file the turn actually opened and did not gut.
 *
 * Deletions and overwrites of files the turn never read always require review,
 * under every policy. The check is deliberately syntactic (line counts, not
 * meaning): it is a floor under the damage, not a substitute for reading the diff.
 */

import type { ApplyPolicyKind } from '../autonomy/types';
import { DEFAULT_APPLY_POLICY } from '../autonomy/types';

/** A change a turn proposed. Structural, so a `UnifiedPatch` satisfies it. */
export interface PolicyPatch {
  path: string;
  kind: 'rewrite' | 'searchReplace';
  content?: string;
  blocks?: Array<{ original: string; updated: string }>;
}

/** What the workspace says about the target, as of this turn. */
export interface PolicyFileState {
  /** A file already exists at that path. */
  exists: boolean;
  /** This very turn read it with a tool. */
  read: boolean;
  /** Its current contents, when known. Used to judge a gutting rewrite. */
  content?: string;
}

export type ApplyAction = 'auto-apply' | 'require-review';

export interface ApplyDecision<T extends PolicyPatch = PolicyPatch> {
  patch: T;
  action: ApplyAction;
  /** Written for a human; the card shows it verbatim. */
  reason: string;
}

export interface ApplyPartition<T extends PolicyPatch = PolicyPatch> {
  auto: T[];
  review: Array<ApplyDecision<T>>;
  /** Reasons for the held-back ones, one line each, ready for the trace. */
  reviewNotes: string[];
}

/** A file shorter than this is not worth protecting: gutting it is a normal edit. */
const PROTECTED_LINE_COUNT = 12;
/** Below either of these ratios, a rewrite is a replacement, not an edit. */
const KEEP_RATIO_FLOOR = 0.4;

export function normalizePolicyPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function nonBlankLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * True when a rewrite destroys most of what is on disk: it empties the file, or
 * replaces a file of substance with something that keeps neither its length nor
 * its lines. Mirrors `assessRewriteRisk` in the patch engine so the chat path and
 * the run path call the same shape of edit destructive.
 */
export function isDestructiveRewrite(newContent: string, currentContent: string): boolean {
  if (!newContent.trim()) return true;
  const before = nonBlankLines(currentContent);
  if (before < PROTECTED_LINE_COUNT) return false;
  const after = nonBlankLines(newContent);
  if (after >= before * KEEP_RATIO_FLOOR) return false;
  const kept = currentContent
    .split('\n')
    .filter((line) => line.trim() && newContent.includes(line.trim()))
    .length;
  return kept / before < KEEP_RATIO_FLOOR;
}

/** A search/replace whose updated body is empty deletes the matched region. */
function isEmptyingSearchReplace(patch: PolicyPatch): boolean {
  if (patch.kind !== 'searchReplace' || !patch.blocks) return false;
  return patch.blocks.length > 0 && patch.blocks.every((block) => !block.updated.trim());
}

/**
 * One patch, one decision. `state.content` may be absent when the caller could
 * not read the file; an unknown target is treated as an existing one, because the
 * safe guess about a file you cannot see is that it holds work.
 */
export function decideApply<T extends PolicyPatch>(
  policy: ApplyPolicyKind,
  patch: T,
  state: PolicyFileState
): ApplyDecision<T> {
  const path = normalizePolicyPath(patch.path);
  const isCreate = !state.exists;
  const overwrites = state.content !== undefined ? state.content : '';

  if (policy === 'review') {
    return { patch, action: 'require-review', reason: `${path}: the run sends every change to review` };
  }

  if (isCreate) {
    // A new file cannot lose anything, and a rewrite of it is the only way to make it.
    return { patch, action: 'auto-apply', reason: `${path}: new file` };
  }

  if (!state.read) {
    return {
      patch,
      action: 'require-review',
      reason: `${path}: this turn changed a file it never read`
    };
  }

  if (isEmptyingSearchReplace(patch)) {
    return {
      patch,
      action: 'require-review',
      reason: `${path}: the edit deletes the matched block`
    };
  }

  if (patch.kind === 'rewrite' && isDestructiveRewrite(patch.content ?? '', overwrites)) {
    return {
      patch,
      action: 'require-review',
      reason: `${path}: whole-file replacement that keeps almost none of the current file`
    };
  }

  return { patch, action: 'auto-apply', reason: `${path}: edit to a file this turn read` };
}

/**
 * Splits a turn's patches into what may be written now and what must wait for the
 * user. `stateFor` is looked up per patch so the caller can read lazily; the
 * function itself never awaits, which is what makes it testable.
 */
export function partitionPatches<T extends PolicyPatch>(
  policy: ApplyPolicyKind,
  patches: T[],
  stateFor: (patch: T) => PolicyFileState
): ApplyPartition<T> {
  const auto: T[] = [];
  const review: Array<ApplyDecision<T>> = [];
  for (const patch of patches) {
    const decision = decideApply(policy, patch, stateFor(patch));
    if (decision.action === 'auto-apply') auto.push(patch);
    else review.push(decision);
  }
  return { auto, review, reviewNotes: review.map((decision) => decision.reason) };
}

/** The policy a request gets when nobody named one. */
export function resolvePolicy(policy: ApplyPolicyKind | undefined): ApplyPolicyKind {
  return policy === 'review' ? 'review' : DEFAULT_APPLY_POLICY;
}

/**
 * A one-line explanation of what the policy held back, for the chat card. Says
 * how many files await acceptance and why, so an unfinished-looking run is never
 * mistaken for a run that did nothing.
 */
export function reviewSummaryLine(paths: string[], notes: string[]): string {
  if (paths.length === 0) return '';
  const list = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : '';
  const why = notes[0]?.split(': ').slice(1).join(': ') ?? 'review is required';
  return `${paths.length} file${paths.length === 1 ? '' : 's'} await${paths.length === 1 ? 's' : ''} your review: ${list}${more} — ${why}.`;
}
