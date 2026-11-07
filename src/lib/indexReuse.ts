/**
 * Reusing local indexing, and keeping remote indexing opt-in (S19).
 *
 * The local repo index is navigation, not a bill: an unchanged file must not be
 * re-embedded, and no local indexing step may ever reach a provider or upload a
 * byte. Two things are easy to get wrong and are made explicit here:
 *
 * - "Unchanged" is content identity, not file length. A same-length edit is a
 *   change and must be re-embedded; keying on size would silently miss it.
 * - Switching workspaces must isolate and cancel the old batch. A late result
 *   from the previous workspace is dropped, not merged into the new one.
 *
 * An optional remote embedding route (the approved text-embedding-3-small) is a
 * separate, explicit admission: it previews exactly which files would leave the
 * machine and what they cost, and it never uploads the repository by default.
 */

import type { ResolvedPayer } from './sharedKeyPolicy';

export interface IndexedFile {
  path: string;
  /** Content identity (e.g. a hash). Two files with the same id are identical. */
  contentId: string;
  length: number;
}

export interface IndexPlan {
  /** Unchanged content: reuse the existing vector, do not re-embed. */
  reuse: string[];
  /** New or changed content: (re-)embed. */
  embed: string[];
  /** Paths that disappeared: drop their vectors. */
  removed: string[];
}

function key(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Diff a previous index against the current contents by content identity. A file
 * whose id moved is re-embedded even if its length did not change.
 */
export function planIndex(previous: readonly IndexedFile[], next: readonly IndexedFile[]): IndexPlan {
  const before = new Map(previous.map((file) => [key(file.path), file]));
  const nextKeys = new Set<string>();
  const reuse: string[] = [];
  const embed: string[] = [];
  for (const file of next) {
    const pathKey = key(file.path);
    nextKeys.add(pathKey);
    const prior = before.get(pathKey);
    if (prior && prior.contentId === file.contentId) reuse.push(file.path);
    else embed.push(file.path);
  }
  const removed = previous.filter((file) => !nextKeys.has(key(file.path))).map((file) => file.path);
  return { reuse, embed, removed };
}

/**
 * Tags indexing batches with a workspace and an epoch. A result is accepted only
 * when its workspace and epoch are still current, so a stale batch — from a
 * previous workspace or a superseded pass — can never contaminate the new index.
 */
export class IndexingCoordinator {
  private workspaceId: string | null = null;
  private epoch = 0;

  begin(workspaceId: string): { workspaceId: string; epoch: number } {
    this.workspaceId = workspaceId;
    this.epoch += 1;
    return { workspaceId, epoch: this.epoch };
  }

  accept(result: { workspaceId: string; epoch: number }): boolean {
    return result.workspaceId === this.workspaceId && result.epoch === this.epoch;
  }

  /** Invalidate every in-flight batch without starting a new one. */
  cancel(): void {
    this.epoch += 1;
  }

  get current(): { workspaceId: string | null; epoch: number } {
    return { workspaceId: this.workspaceId, epoch: this.epoch };
  }
}

export interface IndexCounts {
  /** Files embedded in this pass. */
  indexed: number;
  /** Files whose existing vector was reused. */
  reused: number;
  /** Files carried into a request. */
  sent: number;
  /** Whether ShadRox charged anything for this indexing. */
  charged: boolean;
  /** Whether any byte left the machine. */
  uploaded: boolean;
}

/**
 * The numbers the index status shows. Local indexing is never charged and never
 * uploads, so `charged` and `uploaded` are always false here — indexed and sent
 * are reported separately so "indexed 240, sent 12" is visible.
 */
export function indexCounts(plan: IndexPlan, sentPaths: readonly string[]): IndexCounts {
  return {
    indexed: plan.embed.length,
    reused: plan.reuse.length,
    sent: sentPaths.length,
    charged: false,
    uploaded: false
  };
}

export interface RemoteIndexAdmission {
  admitted: boolean;
  reason: string;
  /** The exact files that would leave the machine if this ran. */
  scope: readonly string[];
  estimatedRupees: number;
}

/**
 * The optional remote embedding route. It is admitted only on an explicit
 * approval, with a named non-empty scope and a finite positive cost — so it can
 * never become a default full-repo upload, and a shared-key run can reserve its
 * cost before sending. On the user's own key it is never charged by ShadRox.
 */
export function admitRemoteIndex(input: {
  approved: boolean;
  payer: ResolvedPayer;
  files: readonly string[];
  estimatedRupees: number;
}): RemoteIndexAdmission {
  if (!input.approved) {
    return { admitted: false, reason: 'Remote indexing is not approved.', scope: [], estimatedRupees: 0 };
  }
  if (input.files.length === 0) {
    return { admitted: false, reason: 'Nothing selected to index.', scope: [], estimatedRupees: 0 };
  }
  if (!Number.isFinite(input.estimatedRupees) || input.estimatedRupees <= 0) {
    return { admitted: false, reason: 'Unpriced remote request refused.', scope: [], estimatedRupees: 0 };
  }
  return {
    admitted: true,
    reason:
      input.payer === 'shared'
        ? 'Remote indexing approved; its cost is reserved against the shared budget.'
        : 'Remote indexing approved on the user’s own key; ShadRox charges nothing.',
    scope: [...input.files],
    estimatedRupees: input.estimatedRupees
  };
}
