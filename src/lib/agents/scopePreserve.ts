/**
 * Keeping a request's scope across retry, resume, queue and undo (S17).
 *
 * The single rule these helpers enforce: an action the user takes *after* a turn
 * runs must not silently change what that turn was. Retry keeps the frozen
 * request identity; resume adds to the same task and never reruns work that
 * already landed; Stop preserves what exists instead of undoing it; Undo refuses
 * to clobber newer edits with a stale checkpoint. When provenance is missing,
 * the answer is to ask for a new request, never to guess the old one.
 */

import {
  describeEnvelopeDrift,
  envelopeDrift,
  type EnvelopeDrift,
  type RequestEnvelope
} from '../requestEnvelope';
import type { TargetVersion } from './taskLedger';

export interface RetryCheck {
  ok: boolean;
  drift: EnvelopeDrift[];
  /** Paths whose content version changed since the request was submitted. */
  versionChanges: string[];
  reason: string;
}

/**
 * Whether a retry can run as the original request. Drift in workspace, payer,
 * plan, provider, model or permission is reported, not applied — a retry that
 * quietly switched the paying key or the workspace is exactly the failure this
 * guards. An attached file whose version moved is reported the same way.
 */
export function retryCheck(
  frozen: RequestEnvelope,
  current: RequestEnvelope,
  versions: { frozen: readonly TargetVersion[]; current: readonly TargetVersion[] } = { frozen: [], current: [] }
): RetryCheck {
  const drift = envelopeDrift(frozen, current);
  const versionChanges = targetVersionDrift(versions.frozen, versions.current);
  const reasons: string[] = [];
  if (drift.length > 0) reasons.push(describeEnvelopeDrift(drift));
  if (versionChanges.length > 0) reasons.push(`attached files changed: ${versionChanges.join(', ')}`);
  return {
    ok: reasons.length === 0,
    drift,
    versionChanges,
    reason: reasons.length === 0
      ? 'The retry runs with the request identity it was sent with.'
      : `Retry would change ${reasons.join('; ')}.`
  };
}

/** Paths whose frozen version no longer matches — a changed attachment. */
export function targetVersionDrift(
  frozen: readonly TargetVersion[],
  current: readonly TargetVersion[]
): string[] {
  const now = new Map(current.map((entry) => [entry.path.replace(/\\/g, '/').toLowerCase(), entry.version]));
  return frozen
    .filter((entry) => {
      const key = entry.path.replace(/\\/g, '/').toLowerCase();
      return now.has(key) && now.get(key) !== entry.version;
    })
    .map((entry) => entry.path);
}

export interface ResumableTask {
  id: string;
  status: 'pending' | 'running' | 'passed' | 'unverified' | 'failed' | 'blocked' | 'stopped';
  /** Effects this task already carried out, so a resume never repeats them. */
  completedEffects?: readonly string[];
}

export interface ResumePlan {
  /** Tasks that still need work, in the order given. */
  rerun: string[];
  /** Tasks already passed; resume must not touch them again. */
  alreadyDone: string[];
  /** Effects to skip because a passed task already performed them. */
  skipEffects: string[];
}

/**
 * What a resume actually has left to do. Only `passed` tasks are finished; an
 * `unverified` or `stopped` task is resumed, never assumed complete. Effects
 * recorded by passed tasks are collected so they are not run twice.
 */
export function planResume(tasks: readonly ResumableTask[]): ResumePlan {
  const alreadyDone: string[] = [];
  const rerun: string[] = [];
  const skipEffects = new Set<string>();
  for (const task of tasks) {
    if (task.status === 'passed') {
      alreadyDone.push(task.id);
      for (const effect of task.completedEffects ?? []) skipEffects.add(effect);
    } else {
      rerun.push(task.id);
    }
  }
  return { rerun, alreadyDone, skipEffects: [...skipEffects] };
}

export type TurnCommand = 'stop' | 'undo' | 'resume' | 'regenerate';

export interface CommandIntent {
  /** Whether the command sends work to the model again. */
  rerunsWork: boolean;
  /** Whether the command restores a checkpoint over current files. */
  restoresCheckpoint: boolean;
  /** Whether files the turn already wrote are left in place. */
  keepsExistingWork: boolean;
}

/** Stop is not Undo: one halts and preserves, the other rewinds. */
export function commandIntent(command: TurnCommand): CommandIntent {
  switch (command) {
    case 'stop':
      return { rerunsWork: false, restoresCheckpoint: false, keepsExistingWork: true };
    case 'undo':
      return { rerunsWork: false, restoresCheckpoint: true, keepsExistingWork: false };
    case 'resume':
      return { rerunsWork: true, restoresCheckpoint: false, keepsExistingWork: true };
    case 'regenerate':
      return { rerunsWork: true, restoresCheckpoint: true, keepsExistingWork: false };
  }
}

export interface CheckpointSnapshot {
  path: string;
  /** The content the patch was computed against, captured at checkpoint time. */
  baseContent: string;
  stage: 'pre-stream' | 'pre-apply';
}

export type UndoVerdict = 'safe' | 'stale' | 'missing';

/**
 * Whether a checkpoint can be restored over the current file. `stale` means the
 * file no longer matches the content the checkpoint was taken from — the user (or
 * another turn) edited it — so a restore would destroy newer work and must be
 * refused. `missing` means there is nothing to restore onto.
 */
export function undoVerdict(
  snapshot: CheckpointSnapshot,
  current: { exists: boolean; content: string }
): UndoVerdict {
  if (!current.exists) return 'missing';
  if (current.content !== snapshot.baseContent) return 'stale';
  return 'safe';
}

/**
 * After a checkpoint fails, the composer must come back usable and say plainly
 * that nothing changed — never a half-restored state the user has to reason about.
 */
export function composerAfterCheckpointFailure(error: string): { usable: boolean; status: string } {
  const detail = error.trim() || 'unknown error';
  return {
    usable: true,
    status: `Could not take the checkpoint (${detail}). Nothing was changed — your message is still here and you can try again.`
  };
}
