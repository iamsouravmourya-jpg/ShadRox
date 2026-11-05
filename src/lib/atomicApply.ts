import type { FilePatch } from './markdown';
import { assessRewriteRisk, formatApplyFailure, resolvePatchContent } from './patchEngine';
import type { ReviewPatch, WorkspaceFile } from './types';

/**
 * All-or-nothing planning for a review set.
 *
 * Resolving patch-by-patch is what let a ten-file refactor land nine files and
 * fail the tenth. This module resolves every pending patch against the current
 * buffers first and only hands the caller a job list when the whole set would
 * apply; a single blocker empties the plan.
 */
export interface AtomicPlanFailure {
  path: string;
  reason: string;
  /**
   * Stable machine-readable cause when the pipeline knows one (a refused
   * deletion, a superseded duplicate, a destructive rewrite...). The UI uses it
   * to explain *which* check failed instead of "some checks did not pass".
   */
  code?: string;
}

export interface AtomicPlanJob {
  path: string;
  content: string;
  originalContent: string;
  created: boolean;
}

export type AtomicPlan =
  | { ok: true; jobs: AtomicPlanJob[]; patches: ReviewPatch[] }
  | { ok: false; jobs: []; failures: AtomicPlanFailure[]; patches: ReviewPatch[] };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSafePath(path: string): boolean {
  return Boolean(path) && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

/** assessRewriteRisk already prefixes the path; strip it so the failure is not doubled. */
function stripPathPrefix(path: string, reason: string): string {
  const prefix = `${path}:`;
  return reason.startsWith(prefix) ? reason.slice(prefix.length).trim() : reason;
}

export function planAtomicApply(
  patches: ReviewPatch[],
  files: WorkspaceFile[],
  options: { allowDestructive?: boolean } = {}
): AtomicPlan {
  const nextPatches = patches.map((patch) => ({ ...patch }));
  // One operation per path: when the same file is named twice (a model that
  // re-emits a block across two tool rounds), only the LAST pending patch is
  // planned — it reflects the final state. Without this the plan carried two
  // jobs for one file and the review card said "2 files" for a single create.
  const lastPendingIndex = new Map<string, number>();
  nextPatches.forEach((patch, index) => {
    if (patch.status !== 'pending') return;
    const key = normalizePath(patch.path).toLowerCase();
    if (!isSafePath(key)) return;
    lastPendingIndex.set(key, index);
  });

  const jobs: AtomicPlanJob[] = [];
  const failures: AtomicPlanFailure[] = [];
  const jobIndexes: number[] = [];

  nextPatches.forEach((patch, index) => {
    if (patch.status !== 'pending') return;

    const target = normalizePath(patch.path);
    const fail = (path: string, reason: string, code?: string) => {
      const failure: AtomicPlanFailure = code ? { path, reason, code } : { path, reason };
      failures.push(failure);
      patch.status = 'failed';
      patch.failure = `Blocked: ${path}: ${reason}`;
    };

    if (!isSafePath(target)) {
      fail(target || patch.path, 'not a workspace-relative path', 'PATH_UNSAFE');
      return;
    }

    if (lastPendingIndex.get(target.toLowerCase()) !== index) {
      // Not an error: the later patch to this file supersedes this one. Marking
      // it rejected keeps the review row honest instead of leaving it pending.
      patch.status = 'rejected';
      patch.failure = `Superseded by a later patch to ${target} in the same change set`;
      return;
    }

    const current = files.find((file) => normalizePath(file.name).toLowerCase() === target.toLowerCase());
    const path = current ? normalizePath(current.name) : target;

    if (patch.kind === 'rewrite') {
      const content = patch.content ?? '';
      if (!current) {
        jobs.push({ path, content, originalContent: '', created: true });
        jobIndexes.push(index);
        return;
      }
      if (!options.allowDestructive) {
        const risk = assessRewriteRisk(path, content, current.content);
        if (risk) {
          fail(path, stripPathPrefix(path, risk), 'DESTRUCTIVE_REWRITE');
          return;
        }
      }
      jobs.push({ path, content, originalContent: current.content, created: false });
      jobIndexes.push(index);
      return;
    }

    if (!current) {
      fail(path, 'file is not in the workspace', 'FILE_NOT_LOADED');
      return;
    }

    const resolved = resolvePatchContent(patch, current.content);
    if (resolved.refusal) {
      // A typed refusal (deletion, move, empty body): zero bytes, but the
      // reason is carried through instead of surfacing as a stale anchor.
      fail(path, resolved.refusal.reason, resolved.refusal.code);
      return;
    }
    if (resolved.failures.length > 0) {
      fail(path, formatApplyFailure(resolved.failures[0]), 'ANCHOR_NOT_FOUND');
      return;
    }
    jobs.push({ path, content: resolved.content, originalContent: current.content, created: false });
    jobIndexes.push(index);
  });

  if (failures.length > 0) {
    return { ok: false, jobs: [], failures, patches: nextPatches };
  }

  jobIndexes.forEach((patchIndex, jobIndex) => {
    const job = jobs[jobIndex];
    nextPatches[patchIndex].status = 'applied';
    nextPatches[patchIndex].originalContent = job.originalContent;
  });

  return { ok: true, jobs, patches: nextPatches };
}

export function applyAtomicJobs(jobs: AtomicPlanJob[], apply: (updates: FilePatch[]) => unknown): string[] {
  if (jobs.length === 0) return [];
  apply(jobs.map((job) => ({ path: job.path, content: job.content })));
  return jobs.map((job) => job.path);
}

/**
 * Created files have no previous content to restore, so undo must delete them
 * through the workspace's delete path — this leaves them in place.
 */
export function revertAtomicJobs(jobs: AtomicPlanJob[]): FilePatch[] {
  return jobs.filter((job) => !job.created).map((job) => ({ path: job.path, content: job.originalContent }));
}
