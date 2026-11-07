/**
 * One task ledger for planner, workers and repairs (S16).
 *
 * A team or autonomous run is not a second engine and must not be a second
 * bookkeeping system either. The request the user submitted is frozen once
 * (S01); the planner and every worker inherit that same frozen identity — the
 * same workspace, payer, plan, permission mode and budget — instead of being
 * handed free text while the attachments stay on screen for display only.
 *
 * This module is the parity layer:
 *
 * - `workerScope` projects the frozen envelope plus a task's files into the
 *   exact scope a worker runs under, so no worker can relax Ask/Plan or spend
 *   beyond the shared budget.
 * - `TaskLedger` counts planner, worker and repair attempts in one place.
 * - `taskCompletionVerdict` decides "done" from verified checks only. A loop
 *   that exited is not a task that passed.
 * - `detectFileRaces` names two tasks claiming one file, so a multi-file plan
 *   cannot race on a single path.
 *
 * Everything here is pure; the caller owns the clock and the model calls.
 */

import type { PermissionMode } from '../agent/runPolicy';
import type { RequestEnvelope } from '../requestEnvelope';
import type { ResolvedPayer } from '../sharedKeyPolicy';
import type { PlanTier } from '../types';

export type AttemptRole = 'planner' | 'worker' | 'repair';

export interface TaskAttempt {
  id: string;
  /** null for the planner attempt, which carries no single task. */
  taskId: string | null;
  role: AttemptRole;
  model: string;
  payer: ResolvedPayer;
  permissionMode: PermissionMode;
  targets: readonly string[];
  creditsSpent: number;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
}

/** A frozen target plus the content version it was submitted at. */
export interface TargetVersion {
  path: string;
  version: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').toLowerCase();
}

/**
 * Merge a task's own files into the frozen target manifest, keeping the exact
 * version a target was submitted at. The first version seen for a path wins:
 * a later worker cannot re-pin a file to a newer version under the request.
 */
export function mergeTargetManifest(
  base: readonly TargetVersion[],
  additions: readonly TargetVersion[]
): TargetVersion[] {
  const byPath = new Map<string, TargetVersion>();
  for (const entry of [...base, ...additions]) {
    const key = normalizePath(entry.path);
    if (!byPath.has(key)) byPath.set(key, { path: entry.path, version: entry.version });
  }
  return [...byPath.values()];
}

/** The scope one worker (or the planner) runs under — inherited, never relaxed. */
export interface WorkerScope {
  taskId: string;
  workspaceId: string | null;
  targets: readonly TargetVersion[];
  permissionMode: PermissionMode;
  payer: ResolvedPayer;
  plan: PlanTier;
  provider: string;
  model: string;
  budgetCredits: number;
}

/** The planner sees the frozen request exactly as submitted. */
export function plannerScope(
  envelope: RequestEnvelope,
  targets: readonly TargetVersion[] = []
): WorkerScope {
  return {
    taskId: 'planner',
    workspaceId: envelope.workspaceId,
    targets: mergeTargetManifest(targets, []),
    permissionMode: envelope.permissionMode,
    payer: envelope.payer,
    plan: envelope.plan,
    provider: envelope.provider,
    model: envelope.model,
    budgetCredits: envelope.budgetCredits
  };
}

/**
 * The scope a worker runs under: the frozen envelope plus this task's files.
 * Permission mode, payer, plan and budget are copied verbatim — a worker cannot
 * widen them, only add the files it was assigned.
 */
export function workerScope(
  envelope: RequestEnvelope,
  task: { id: string; files?: readonly TargetVersion[] },
  base: readonly TargetVersion[] = []
): WorkerScope {
  return {
    taskId: task.id,
    workspaceId: envelope.workspaceId,
    targets: mergeTargetManifest(base, task.files ?? []),
    permissionMode: envelope.permissionMode,
    payer: envelope.payer,
    plan: envelope.plan,
    provider: envelope.provider,
    model: envelope.model,
    budgetCredits: envelope.budgetCredits
  };
}

export interface RequiredCheck {
  name: string;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
}

export type TaskOutcome = 'done' | 'failed' | 'unverified' | 'stopped';

/**
 * A task is `done` only when nothing checked failed and every required check
 * passed. A task that changed files with no check run is `unverified`, never a
 * pass; a stopped task is `stopped`, not a failure of the work.
 */
export function taskCompletionVerdict(input: {
  filesChanged: number;
  requiredChecks: readonly RequiredCheck[];
  stopped?: boolean;
}): TaskOutcome {
  if (input.stopped) return 'stopped';
  if (input.requiredChecks.some((check) => check.status === 'failed')) return 'failed';
  if (input.requiredChecks.some((check) => check.status !== 'passed')) return 'unverified';
  if (input.filesChanged > 0 && input.requiredChecks.length === 0) return 'unverified';
  return 'done';
}

/** Paths two tasks both claim. Empty means no task races another on one file. */
export function detectFileRaces(
  assignments: readonly { taskId: string; files: readonly string[] }[]
): { file: string; taskIds: string[] }[] {
  const byFile = new Map<string, { file: string; taskIds: string[] }>();
  for (const assignment of assignments) {
    for (const file of assignment.files) {
      const key = normalizePath(file);
      const entry = byFile.get(key) ?? { file, taskIds: [] };
      if (!entry.taskIds.includes(assignment.taskId)) entry.taskIds.push(assignment.taskId);
      byFile.set(key, entry);
    }
  }
  return [...byFile.values()].filter((entry) => entry.taskIds.length > 1);
}

/**
 * The single ledger for a run. Planner, worker and repair attempts all land
 * here, keyed by task, so credits and attempt counts cannot be split across
 * three stores that disagree.
 */
export class TaskLedger {
  private readonly attempts: TaskAttempt[] = [];

  record(attempt: TaskAttempt): void {
    this.attempts.push({ ...attempt, targets: [...attempt.targets] });
  }

  all(): readonly TaskAttempt[] {
    return this.attempts;
  }

  attemptsFor(taskId: string): TaskAttempt[] {
    return this.attempts.filter((attempt) => attempt.taskId === taskId);
  }

  get attemptCount(): number {
    return this.attempts.length;
  }

  /** Credits across planner, worker and repair attempts, in one total. */
  get creditsSpent(): number {
    return this.attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.creditsSpent) ? attempt.creditsSpent : 0), 0);
  }
}
