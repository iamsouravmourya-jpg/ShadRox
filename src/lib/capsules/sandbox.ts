import { sha256Hex } from '../proof/ledger';
import type { ChangeCapsule, ReplayConflict, ReplayJob, ReplayPlan } from './types';

/**
 * Pure 3-way resolver for replaying/reverting a capsule against the live
 * workspace. Mirrors planAtomicApply's all-or-nothing contract: a single base
 * divergence, missing anchor or unsafe path empties the job list so zero bytes
 * are written. The caller (Agent C's hook) feeds `jobs` to the safe apply path.
 */

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSafePath(path: string): boolean {
  return Boolean(path) && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

function indexCurrent(
  currentFiles: Array<{ path: string; content: string }>
): Map<string, { path: string; content: string }> {
  const map = new Map<string, { path: string; content: string }>();
  for (const file of currentFiles) {
    const path = normalizePath(file.path);
    map.set(path, { path, content: file.content });
  }
  return map;
}

function plan(jobs: ReplayJob[], conflicts: ReplayConflict[]): ReplayPlan {
  if (conflicts.length > 0) return { ok: false, jobs: [], conflicts };
  return { ok: true, jobs, conflicts: [] };
}

export async function resolveReplay(
  capsule: ChangeCapsule,
  currentFiles: Array<{ path: string; content: string }>
): Promise<ReplayPlan> {
  const current = indexCurrent(currentFiles);
  const jobs: ReplayJob[] = [];
  const conflicts: ReplayConflict[] = [];

  for (const diff of capsule.diffs) {
    const path = normalizePath(diff.path);
    if (!isSafePath(path)) {
      conflicts.push({ path: path || diff.path, reason: 'PATH_UNSAFE', detail: 'not a workspace-relative path' });
      continue;
    }
    const existing = current.get(path);

    if (diff.kind === 'created') {
      if (existing) {
        const hash = await sha256Hex(existing.content);
        if (hash !== diff.afterHash) {
          conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'created file already exists with different content' });
        }
        continue;
      }
      // Capsules are a redacted replay artifact: the post content is written as-is.
      jobs.push({ path, content: diff.after ?? '', originalContent: '', created: true });
      continue;
    }

    if (diff.kind === 'edited') {
      if (!existing) {
        conflicts.push({ path, reason: 'FILE_MISSING', detail: 'file to edit is not in the workspace' });
        continue;
      }
      const hash = await sha256Hex(existing.content);
      if (hash !== diff.beforeHash) {
        conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'current content differs from the task base' });
        continue;
      }
      jobs.push({ path, content: diff.after ?? '', originalContent: existing.content, created: false });
      continue;
    }

    if (!existing) continue;
    const hash = await sha256Hex(existing.content);
    if (hash !== diff.beforeHash) {
      conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'current content differs from the task base' });
      continue;
    }
    // Empty content models a deletion; the wiring routes it through the safe delete path.
    jobs.push({ path, content: '', originalContent: existing.content, created: false });
  }

  return plan(jobs, conflicts);
}

export async function resolveRevert(
  capsule: ChangeCapsule,
  currentFiles: Array<{ path: string; content: string }>
): Promise<ReplayPlan> {
  const current = indexCurrent(currentFiles);
  const jobs: ReplayJob[] = [];
  const conflicts: ReplayConflict[] = [];

  for (const diff of capsule.diffs) {
    const path = normalizePath(diff.path);
    if (!isSafePath(path)) {
      conflicts.push({ path: path || diff.path, reason: 'PATH_UNSAFE', detail: 'not a workspace-relative path' });
      continue;
    }
    const existing = current.get(path);

    if (diff.kind === 'created') {
      if (!existing) continue;
      const hash = await sha256Hex(existing.content);
      if (hash !== diff.afterHash) {
        conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'created file was edited after the task' });
        continue;
      }
      // Empty content models a deletion; the wiring routes it through the safe delete path.
      jobs.push({ path, content: '', originalContent: existing.content, created: false });
      continue;
    }

    if (diff.kind === 'edited') {
      if (!existing) {
        conflicts.push({ path, reason: 'FILE_MISSING', detail: 'file to revert is not in the workspace' });
        continue;
      }
      const hash = await sha256Hex(existing.content);
      if (hash !== diff.afterHash) {
        conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'current content differs from the task output' });
        continue;
      }
      jobs.push({ path, content: diff.before ?? '', originalContent: existing.content, created: false });
      continue;
    }

    if (existing) {
      const hash = await sha256Hex(existing.content);
      if (hash !== diff.beforeHash) {
        conflicts.push({ path, reason: 'BASE_DIVERGED', detail: 'deleted file was re-created with different content' });
        continue;
      }
    }
    jobs.push({ path, content: diff.before ?? '', originalContent: existing?.content ?? '', created: true });
  }

  return plan(jobs, conflicts);
}
