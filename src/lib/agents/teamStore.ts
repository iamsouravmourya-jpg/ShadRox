/**
 * Where a team run's state survives a reload.
 *
 * `autonomy/runStore.ts` does this for solo runs; a team had no store at all, so
 * pausing a team and coming back re-ran the coordinator from zero — paying again
 * for tasks that had already finished. This file is the missing half: the same
 * defensive shape (a corrupt or foreign blob is "no team", never a crash), plus
 * the per-task detail a resume needs: which tasks are done, what each one
 * changed, what it reported, and how many credits the run has already spent.
 *
 * Size is bounded on write. The whole point of persisting a team is to spend less
 * next time, so a store that fills the quota and throws away every transcript is
 * worse than no store.
 */

import type { PlanError, Verdict, VerificationReport } from '../autonomy/types';
import type { AgentRole, TaskStatus, TeamBudget, TeamMessage, TeamState, TeamTask } from './types';

export interface TeamStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface TeamStore {
  save: (rootPath: string, state: TeamState) => void;
  load: (rootPath: string) => TeamState | null;
  clear: (rootPath: string) => void;
}

const KEY_PREFIX = 'shadrox.agents.team';

const MAX_TASKS = 12;
const MAX_MESSAGES = 16;
const MAX_FILES_PER_TASK = 40;
const MAX_DIAGNOSTICS_PER_REPORT = 40;
const MAX_NOTES_PER_REPORT = 8;
const MAX_GOAL_CHARS = 2000;
const MAX_TITLE_CHARS = 400;
const MAX_INSTRUCTION_CHARS = 6000;
const MAX_REPORT_CHARS = 1200;
const MAX_MESSAGE_CHARS = 800;
const MAX_PATH_CHARS = 300;
const MAX_ERROR_CHARS = 1500;
const MAX_CREDITS = 100_000;

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'passed', 'unverified', 'failed', 'blocked', 'stopped'];
const TEAM_STATUSES = ['planning', 'running', 'done', 'failed', 'cancelled', 'stopped-budget'] as const;
const VERDICTS: readonly Verdict[] = ['passed', 'failed', 'unverified'];
const ROLES: readonly AgentRole[] = ['coordinator', 'frontend', 'backend', 'tests', 'reviewer'];
const MESSAGE_KINDS = ['handoff', 'finding', 'blocked'] as const;

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), MAX_CREDITS) : fallback;
}

function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const path = entry.trim();
    if (path) out.push(path.slice(0, MAX_PATH_CHARS));
    if (out.length >= MAX_FILES_PER_TASK) break;
  }
  return out;
}

function sanitizeReport(value: unknown): VerificationReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Partial<VerificationReport>;
  if (typeof report.verdict !== 'string' || !VERDICTS.includes(report.verdict as Verdict)) return null;
  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics
        .slice(0, MAX_DIAGNOSTICS_PER_REPORT)
        .map((line) => {
          return {
            path: text(line.path, MAX_PATH_CHARS),
            line: numberOr(line.line, 0),
            column: numberOr(line.column, 0),
            message: text(line.message, 500),
            severity: line.severity === 'warning' ? ('warning' as const) : ('error' as const)
          };
        })
    : [];
  const command =
    report.command && typeof report.command === 'object'
      ? {
          argv: text(report.command.argv, 500),
          exitCode: typeof report.command.exitCode === 'number' && Number.isFinite(report.command.exitCode)
            ? report.command.exitCode
            : null,
          stdoutTail: text(report.command.stdoutTail, 2000),
          stderrTail: text(report.command.stderrTail, 2000),
          timedOut: report.command.timedOut === true
        }
      : undefined;
  return {
    verdict: report.verdict as Verdict,
    diagnostics,
    ...(command ? { command } : {}),
    notes: (Array.isArray(report.notes) ? report.notes : []).slice(0, MAX_NOTES_PER_REPORT).map((note) => text(note, 400))
  };
}

function sanitizeTask(value: unknown): TeamTask | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 60).trim();
  const title = text(raw.title, MAX_TITLE_CHARS).trim();
  if (!id || !title) return null;
  const status = TASK_STATUSES.includes(raw.status as TaskStatus) ? (raw.status as TaskStatus) : 'pending';
  const assignee = ROLES.includes(raw.assignee as AgentRole) ? (raw.assignee as AgentRole) : null;
  if (!assignee) return null;
  const report = sanitizeReport(raw.lastReport);
  return {
    id,
    title,
    instruction: text(raw.instruction, MAX_INSTRUCTION_CHARS),
    expectedFiles: pathList(raw.expectedFiles),
    dependsOn: pathList(raw.dependsOn),
    assignee,
    ...(typeof raw.verifyCommand === 'string' ? { verifyCommand: text(raw.verifyCommand, 500) } : {}),
    status,
    attempts: Math.max(0, Math.floor(numberOr(raw.attempts, 0))),
    lastReport: report,
    report: text(raw.report, MAX_REPORT_CHARS),
    patchesApplied: Math.floor(numberOr(raw.patchesApplied, 0)),
    patchFailures: pathList(raw.patchFailures).slice(0, 20),
    creditsSpent: numberOr(raw.creditsSpent, 0),
    touchedFiles: pathList(raw.touchedFiles),
    pendingReview: pathList(raw.pendingReview),
    filesRead: pathList(raw.filesRead),
    summary: text(raw.summary, 400)
  };
}

function sanitizeMessage(value: unknown): TeamMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!ROLES.includes(raw.from as AgentRole)) return null;
  const to = raw.to === 'team' ? ('team' as const) : ROLES.includes(raw.to as AgentRole) ? (raw.to as AgentRole) : null;
  if (!to) return null;
  const kind = (MESSAGE_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as TeamMessage['kind']) : null;
  if (!kind) return null;
  const body = text(raw.text, MAX_MESSAGE_CHARS).trim();
  if (!body) return null;
  return { from: raw.from as AgentRole, to, kind, text: body, at: numberOr(raw.at, 0) };
}

function sanitizeBudget(value: unknown): TeamBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const maxCredits = numberOr(raw.maxCredits, 0);
  const maxTasks = Math.floor(numberOr(raw.maxTasks, 0));
  const maxAttemptsPerTask = Math.floor(numberOr(raw.maxAttemptsPerTask, 0));
  if (maxCredits <= 0 || maxTasks <= 0 || maxAttemptsPerTask <= 0) return undefined;
  return { maxCredits, maxTasks, maxAttemptsPerTask };
}

/**
 * Rebuild a team state from anything on disk, or return null.
 *
 * Every field is re-derived rather than trusted: a task without an id or an
 * unknown assignee is dropped, because a resumed run that hands a half-task to a
 * nonexistent role would pay for a turn it cannot report on.
 */
export function sanitizeTeamState(value: unknown): TeamState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const goal = text(raw.goal, MAX_GOAL_CHARS).trim();
  if (!goal) return null;
  if (!TEAM_STATUSES.includes(raw.status as (typeof TEAM_STATUSES)[number])) return null;
  if (!Array.isArray(raw.tasks)) return null;
  const tasks = raw.tasks.slice(0, MAX_TASKS).map(sanitizeTask).filter((task): task is TeamTask => task !== null);
  if (tasks.length === 0) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.slice(0, MAX_MESSAGES).map(sanitizeMessage).filter((message): message is TeamMessage => message !== null)
    : [];
  const state: TeamState = {
    id: text(raw.id, 120) || `team-restored`,
    goal,
    status: raw.status as TeamState['status'],
    tasks,
    messages,
    creditsSpent: numberOr(raw.creditsSpent, 0),
    startedAt: numberOr(raw.startedAt, 0)
  };
  if (typeof raw.error === 'string') state.error = text(raw.error, MAX_ERROR_CHARS);
  const budget = sanitizeBudget(raw.budget);
  if (budget) state.budget = budget;
  if (Array.isArray(raw.conflicts)) {
    state.conflicts = raw.conflicts.slice(0, 12).map((note) => text(note, 400)).filter((note) => note.length > 0);
  }
  if (raw.checkpointed === true) state.checkpointed = true;
  return state;
}

/** Cheap check for callers that only need to know whether a blob is a team. */
export function isTeamState(value: unknown): value is TeamState {
  return sanitizeTeamState(value) !== null;
}

/** The tasks a resume must not run again, and the errors that killed the last attempt. */
export function completedTaskIds(state: TeamState | null): string[] {
  if (!state) return [];
  return state.tasks.filter((task) => task.status === 'passed' || task.status === 'unverified').map((task) => task.id);
}

/** Plan errors are not persisted as a list; the state keeps the rendered reason. */
export function planErrorText(errors: PlanError[]): string {
  return errors.map((error) => error.message).join('; ');
}

function keyFor(rootPath: string): string {
  return `${KEY_PREFIX}:${rootPath || 'default'}`;
}

/** Wrap a storage backend. A `null` backend gives a store that forgets by design. */
export function createTeamStore(storage: TeamStorage | null): TeamStore {
  if (!storage) {
    return { save: () => undefined, load: () => null, clear: () => undefined };
  }
  return {
    save(rootPath, state) {
      try {
        // Written through the sanitizer so what lands on disk is always what a
        // load would produce: no unbounded reply text, no half-task.
        const clean = sanitizeTeamState(state);
        if (!clean) return;
        storage.setItem(keyFor(rootPath), JSON.stringify(clean));
      } catch {
        // Quota or private mode: a team that cannot be persisted still runs.
      }
    },
    load(rootPath) {
      try {
        const raw = storage.getItem(keyFor(rootPath));
        if (!raw) return null;
        return sanitizeTeamState(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    clear(rootPath) {
      try {
        storage.removeItem(keyFor(rootPath));
      } catch {
        // A failed clear only means the next load sees a stale team.
      }
    }
  };
}

/** The browser-backed store, or a no-op when there is no storage (SSR/tests). */
export function browserTeamStore(): TeamStore {
  try {
    return createTeamStore(typeof window === 'undefined' ? null : window.localStorage);
  } catch {
    return createTeamStore(null);
  }
}
