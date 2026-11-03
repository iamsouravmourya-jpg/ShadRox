/**
 * The render model for a run or a team, as plain data.
 *
 * What the chat showed was a log: eight sliced lines of prose, with the task
 * checklist reserved for chat messages. That is a trace, not a status — it cannot
 * answer "which task is this, who owns it, did anything check it, what is waiting
 * on me". This module answers those, from the state alone, in strings a component
 * can drop into existing Tailwind tokens without any formatting logic of its own.
 *
 * Two rules keep it honest:
 *   - a row's status is copied from the state machine, never inferred from prose;
 *   - the six `status` values are exactly the ones a chat card already renders, so
 *     a view model cannot invent a state the product has not agreed to show.
 *
 * Pure and total: any state in, a view out, no throws, no dates, no randomness.
 */

import type { Milestone, MilestoneStatus, RunState, RunStatus } from '../autonomy/types';
import { findAgent } from './roles';
import type { TaskStatus, TeamState, TeamTask } from './types';

export type RunViewStatus = 'planning' | 'running' | 'done' | 'failed' | 'stopped' | 'budget';

export interface RunViewRow {
  id: string;
  /** The task or milestone, one line, as the plan wrote it. */
  subject: string;
  /** 'Frontend' for a team task; null for a solo milestone. */
  owner: string | null;
  status: TaskStatus | MilestoneStatus;
  /** Short word for the badge: `done`, `not checked`, `waiting on t1`. */
  statusLabel: string;
  /** `attempt 2 of 2`, or null when nothing has run yet. */
  attempt: string | null;
  /** Files this row owns or changed, newest first, capped. */
  files: string[];
  /** Files the apply policy held back for the user. */
  review: string[];
  /** Why this row is not green. Null when there is nothing to explain. */
  blocker: string | null;
  /** What the checker said, in one line. Null when no check ran. */
  check: string | null;
  credits: number;
  /** True for the row a spin indicator belongs on. */
  active: boolean;
}

export interface RunViewModel {
  kind: 'team' | 'run';
  status: RunViewStatus;
  /** 'Agent team' or 'Autonomous run'. */
  title: string;
  /** The line under the title: `3 of 5 tasks passed · 7.4 of 24 cr`. */
  statusLine: string;
  /** Why Auto escalated this request. Copied from the decision, never rewritten. */
  reason: string;
  spent: number;
  budget: number;
  budgetLabel: string;
  progressLabel: string;
  rows: RunViewRow[];
  /** Two tasks claiming one file, one sentence each. */
  conflicts: string[];
  /** Held-back files across every row, so one count covers the run. */
  awaitingReview: string[];
  /** The sentence to show when `awaitingReview` is not empty. */
  reviewLine: string | null;
  /** Recent engine log lines, newest last. */
  trace: string[];
  canStop: boolean;
  canResume: boolean;
  /** The engine's own reason for not working, shown verbatim when present. */
  error: string | null;
}

export const MAX_VIEW_TRACE_LINES = 8;
export const MAX_VIEW_ROWS = 12;
const MAX_VIEW_FILES = 5;

export interface RunViewOptions {
  /** The engine's log lines, newest last. */
  log?: readonly string[];
  /** Why the request escalated, from `decideOrchestration`. */
  reason?: string;
  /** The credit ceiling; falls back to the state's own budget when known. */
  budgetCredits?: number;
  /** The run/team is still executing in this process. */
  isRunning?: boolean;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function firstSentence(text: string, limit = 200): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function traceOf(log: readonly string[] | undefined): string[] {
  if (!log || log.length === 0) return [];
  return log.slice(-MAX_VIEW_TRACE_LINES).map((line) => firstSentence(line, 240));
}

const TASK_LABELS: Record<string, string> = {
  pending: 'queued',
  running: 'working',
  passed: 'done',
  unverified: 'not checked',
  failed: 'failed',
  blocked: 'blocked',
  stopped: 'stopped'
};

const NOUN: Record<RunViewModel['kind'], { unit: string; units: string }> = {
  team: { unit: 'task', units: 'tasks' },
  run: { unit: 'milestone', units: 'milestones' }
};

function filesOf(declared: readonly string[], touched: readonly string[], review: readonly string[]): string[] {
  const merged: string[] = [];
  for (const path of [...touched, ...declared]) {
    if (!merged.includes(path)) merged.push(path);
    if (merged.length >= MAX_VIEW_FILES) break;
  }
  return merged.filter((path) => !review.includes(path)).slice(0, MAX_VIEW_FILES);
}

/** The one thing a user needs from a red row: which other row is the reason. */
function blockerFor(task: TeamTask | Milestone, all: readonly (TeamTask | Milestone)[]): string | null {
  if (task.status === 'blocked') {
    const failing = task.dependsOn.find((id) => {
      const dependency = all.find((candidate) => candidate.id === id);
      return dependency ? dependency.status !== 'passed' && dependency.status !== 'unverified' : false;
    });
    return failing ? `waiting on ${failing}, which did not pass` : 'a dependency did not pass';
  }
  if (task.status === 'failed') {
    const report = 'lastReport' in task ? task.lastReport : task.attempts[task.attempts.length - 1]?.verification;
    const note = report?.notes?.[0];
    if (report?.diagnostics.length) {
      const first = report.diagnostics[0];
      return `${report.diagnostics.length} problem(s) after the last attempt: ${first.path}:${first.line} ${firstSentence(first.message, 90)}`;
    }
    return note ? firstSentence(note, 160) : 'the last attempt did not pass its check';
  }
  if (task.status === 'stopped') return 'stopped while it was running';
  if (task.status === 'unverified') {
    const report = 'lastReport' in task ? task.lastReport : task.attempts[task.attempts.length - 1]?.verification;
    return firstSentence(report?.notes?.[0] ?? 'nothing checked this, so it is not proven', 160);
  }
  return null;
}

function checkFor(task: TeamTask | Milestone): string | null {
  if ('lastReport' in task) {
    const report = task.lastReport;
    if (!report) return null;
    const command = report.command ? ` · ${report.command.argv} exited ${report.command.exitCode ?? 'n/a'}` : '';
    return `${report.verdict}${command}`;
  }
  const attempt = task.attempts[task.attempts.length - 1];
  if (!attempt?.verification) return null;
  const command = attempt.verification.command ? ` · ${attempt.verification.command.argv} exited ${attempt.verification.command.exitCode ?? 'n/a'}` : '';
  return `${attempt.verification.verdict}${command}`;
}

function countDone(rows: readonly RunViewRow[]): { done: number; total: number } {
  const total = rows.length;
  const done = rows.filter((row) => row.status === 'passed').length;
  return { done, total };
}

function reviewLineOf(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return `${paths.length} file${paths.length === 1 ? '' : 's'} ${paths.length === 1 ? 'awaits' : 'await'} your review — accept the change card to apply them.`;
}

function statusOfRun(status: RunStatus): RunViewStatus {
  switch (status) {
    case 'planning':
    case 'ready':
      return 'planning';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped-budget':
      return 'budget';
    case 'paused':
    case 'cancelled':
      return 'stopped';
    default:
      return 'stopped';
  }
}

function statusOfTeam(status: TeamState['status']): RunViewStatus {
  switch (status) {
    case 'planning':
      return 'planning';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped-budget':
      return 'budget';
    case 'cancelled':
      return 'stopped';
    default:
      return 'stopped';
  }
}

function resumable(status: RunViewStatus, rows: readonly RunViewRow[]): boolean {
  return (status === 'stopped' || status === 'budget' || status === 'failed') && rows.some((row) => row.status === 'pending' || row.status === 'stopped');
}

function assemble(
  kind: RunViewModel['kind'],
  status: RunViewStatus,
  spent: number,
  budget: number,
  rows: RunViewRow[],
  conflicts: string[],
  error: string | undefined,
  options: RunViewOptions
): RunViewModel {
  const awaitingReview = [...new Set(rows.flatMap((row) => row.review))];
  const { done, total } = countDone(rows);
  const noun = NOUN[kind];
  const head = status === 'planning'
    ? `${total} ${noun.units} planned`
    : status === 'running'
      ? `${done} of ${total} ${noun.units} done`
      : status === 'done'
      ? `${done} of ${total} ${noun.units} passed`
      : status === 'budget'
        ? `stopped at the credit cap after ${done} of ${total} ${noun.units}`
        : status === 'stopped'
          ? `stopped after ${done} of ${total} ${noun.units}`
          : status === 'failed'
            ? `${done} of ${total} ${noun.units} passed`
            : `${done} of ${total} ${noun.units} planned`;
  const statusLine = error && status !== 'running' ? firstSentence(`${head} — ${error}`, 300) : head;
  return {
    kind,
    status,
    title: kind === 'team' ? 'Agent team' : 'Autonomous run',
    statusLine,
    reason: options.reason ?? '',
    spent,
    budget,
    budgetLabel: `${round(spent)} of ${round(budget)} cr`,
    progressLabel: `${done}/${total} ${noun.units}`,
    rows: rows.slice(0, MAX_VIEW_ROWS),
    conflicts,
    awaitingReview,
    reviewLine: reviewLineOf(awaitingReview),
    trace: traceOf(options.log),
    canStop: status === 'running' || status === 'planning' || options.isRunning === true,
    canResume: resumable(status, rows),
    error: error ? firstSentence(error, 300) : null
  };
}

/** The team's state as rows a chat card can render, newest work first in plan order. */
export function teamRows(tasks: readonly TeamTask[]): RunViewRow[] {
  return tasks.map((task) => {
    const touched = task.touchedFiles ?? [];
    const review = task.pendingReview ?? [];
    return {
      id: task.id,
      subject: firstSentence(task.title, 160) || task.id,
      owner: findAgent(task.assignee).name,
      status: task.status,
      statusLabel: TASK_LABELS[task.status] ?? task.status,
      attempt: task.attempts > 0 ? `attempt ${task.attempts}` : null,
      files: filesOf(task.expectedFiles, touched, review),
      review,
      blocker: blockerFor(task, tasks),
      check: checkFor(task),
      credits: task.creditsSpent,
      active: task.status === 'running'
    };
  });
}

export function milestoneRows(milestones: readonly Milestone[]): RunViewRow[] {
  return milestones.map((milestone) => {
    const last = milestone.attempts[milestone.attempts.length - 1];
    const touched = milestone.touchedFiles ?? [];
    const review = milestone.pendingReview ?? [];
    return {
      id: milestone.id,
      subject: firstSentence(milestone.title, 160) || milestone.id,
      owner: null,
      status: milestone.status,
      statusLabel: TASK_LABELS[milestone.status] ?? milestone.status,
      attempt: milestone.attempts.length > 0 ? `attempt ${milestone.attempts.length}` : null,
      files: filesOf(milestone.expectedFiles, touched, review),
      review,
      blocker: blockerFor(milestone, milestones),
      check: checkFor(milestone),
      credits: last?.creditsSpent ?? 0,
      active: milestone.status === 'running'
    };
  });
}

export function teamRunView(state: TeamState | null, options: RunViewOptions = {}): RunViewModel | null {
  if (!state) return null;
  const rows = teamRows(state.tasks);
  const budget = state.budget?.maxCredits ?? options.budgetCredits ?? 0;
  return assemble('team', statusOfTeam(state.status), state.creditsSpent, budget, rows, state.conflicts ?? [], state.error, options);
}

export function autonomyRunView(state: RunState | null, options: RunViewOptions = {}): RunViewModel | null {
  if (!state) return null;
  const rows = milestoneRows(state.milestones);
  const budget = options.budgetCredits ?? 0;
  return assemble('run', statusOfRun(state.status), state.creditsSpent, budget, rows, [], state.error, options);
}

/**
 * The view for whichever engine is live, from the orchestration message alone.
 * Returns null when there is nothing to render, so a card never shows a skeleton.
 */
export function runViewFor(
  kind: 'team' | 'autonomy',
  team: TeamState | null,
  run: RunState | null,
  options: RunViewOptions = {}
): RunViewModel | null {
  return kind === 'team' ? teamRunView(team, options) : autonomyRunView(run, options);
}
