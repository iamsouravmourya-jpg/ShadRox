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
  const jobs: AtomicPlanJob[] = [];
  const failures: AtomicPlanFailure[] = [];
  const jobIndexes: number[] = [];

  nextPatches.forEach((patch, index) => {
    if (patch.status !== 'pending') return;

    const target = normalizePath(patch.path);
    const fail = (path: string, reason: string) => {
      failures.push({ path, reason });
      patch.status = 'failed';
      patch.failure = `Blocked: ${path}: ${reason}`;
    };

    if (!isSafePath(target)) {
      fail(target || patch.path, 'not a workspace-relative path');
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
          fail(path, stripPathPrefix(path, risk));
          return;
        }
      }
      jobs.push({ path, content, originalContent: current.content, created: false });
      jobIndexes.push(index);
      return;
    }

    if (!current) {
      fail(path, 'file is not in the workspace');
      return;
    }

    const resolved = resolvePatchContent(patch, current.content);
    if (resolved.failures.length > 0) {
      fail(path, formatApplyFailure(resolved.failures[0]));
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
