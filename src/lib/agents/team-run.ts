/**
 * The team driver: coordinate a goal into tasks, then run them until they pass,
 * the budget dies, or the user stops it.
 *
 * Nothing in this file knows what a model, a file, or a terminal is. Every
 * capability arrives through `TeamPorts`, which is the same seam the solo run
 * uses — so a team member cannot invent an exec or write path, and every task is
 * checked by the same verifier that judges a solo milestone.
 *
 * Tasks run one at a time, on purpose. Every task's turn goes through the app's
 * single workspace, so two agents editing at once would produce a patch that
 * applies against bytes the other one already changed. Bounded concurrency here
 * means a hard task cap and a hard credit cap, not a thread pool.
 */

import { estimateTurn } from '../autonomy/budget';
import { countPending, findBlocked, nextRunnable } from '../autonomy/dag';
import { buildRepairBrief } from '../autonomy/feedback';
import type { CreditTracker } from '../autonomy/run-loop';
import type { PlanError, TurnUnit, VerificationReport } from '../autonomy/types';
import { buildTaskInstruction } from './roles';
import type { TaskStatus, TeamBudget, TeamMessage, TeamPorts, TeamState, TeamPlan, TeamTask } from './types';

export interface TeamDeps {
  ports: TeamPorts;
  budget: TeamBudget;
  /** coordinator.planTeam, adapted to the files the workspace reports right now. */
  planTeam: (goal: string, files: string[], budget: TeamBudget) => Promise<TeamPlan>;
  validate: (tasks: TeamTask[], budget: TeamBudget) => PlanError[];
  tracker: CreditTracker;
  /** Runs once before the first write so a failed team can be rolled back. */
  checkpoint: (goal: string) => Promise<void> | void;
  persist: (state: TeamState) => void;
  now: () => number;
}

/** How much of an agent's reply is kept for the view and for later agents. */
const REPORT_LIMIT = 800;
/** How many prior messages are handed to the next agent, and how many characters. */
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 1600;

function newTask(source: TeamTask): TeamTask {
  return {
    ...source,
    status: 'pending',
    attempts: 0,
    lastReport: null,
    report: '',
    patchesApplied: 0,
    patchFailures: [],
    creditsSpent: 0
  };
}

function describeErrors(errors: PlanError[]): string {
  return errors.map((error) => error.message).join('; ');
}

function trim(text: string, limit: number): string {
  const value = text.trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return trim(line, 200);
}

/** What the team already knows, oldest kept out once the window fills. */
function sharedContext(state: TeamState): string {
  const lines = state.messages
    .slice(-CONTEXT_MESSAGES)
    .map((message) => `- ${message.from}${message.to === 'team' ? '' : ` → ${message.to}`}: ${trim(message.text, 300)}`);
  const text = lines.join('\n');
  return text.length <= CONTEXT_CHARS ? text : text.slice(text.length - CONTEXT_CHARS);
}

/** The task's one-line contribution to the team's shared context. */
function summarise(task: TeamTask, outcome: 'passed' | 'failed'): string {
  const notes = task.lastReport?.notes ?? [];
  if (outcome === 'failed') {
    return `"${task.title}" did not pass after ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}: ${notes.join('; ') || 'no checker could run'}.`;
  }
  if (task.expectedFiles.length === 0) {
    return `"${task.title}" — ${firstLine(task.report) || 'no reply'}`;
  }
  return `"${task.title}" changed ${task.patchesApplied} file${task.patchesApplied === 1 ? '' : 's'}; the check said ${task.lastReport?.verdict ?? 'unverified'}.`;
}

/**
 * Runs the goal to completion and returns the final state.
 *
 * A task advances the plan on `passed`; an `unverified` task advances too, since
 * nothing was disproved, but its verdict is never rewritten — the panel and the
 * summary both keep saying it was not proven.
 */
export async function runTeam(goal: string, deps: TeamDeps): Promise<TeamState> {
  const files = deps.ports.listFiles();
  const state: TeamState = {
    id: `team-${deps.now()}`,
    goal,
    status: 'planning',
    tasks: [],
    messages: [],
    creditsSpent: 0,
    startedAt: deps.now()
  };
  deps.persist(state);
  deps.ports.onEvent({ type: 'team:log', text: `Coordinating: ${goal}` });

  const planned = await deps.planTeam(goal, files, deps.budget);
  const tasks = planned.tasks.map(newTask);
  const errors = [...planned.errors, ...(planned.errors.length > 0 ? [] : deps.validate(tasks, deps.budget))];
  if (errors.length > 0) {
    state.status = 'failed';
    state.error = describeErrors(errors);
    deps.ports.onEvent({ type: 'team:done', status: 'failed' });
    deps.persist(state);
    return state;
  }

  state.tasks = tasks;
  state.status = 'running';
  deps.ports.onEvent({ type: 'team:planned', tasks });
  deps.persist(state);

  let checkpointed = false;
  /** File-changing tasks that finished without a check that could prove them. */
  const unverified: string[] = [];

  while (!deps.ports.isCancellationRequested()) {
    const next = nextRunnable(state.tasks);
    if (!next) break;

    if (deps.tracker.exhausted()) {
      state.status = 'stopped-budget';
      state.error = `Stopped at the ${deps.budget.maxCredits}-credit cap. ${countPending(state.tasks)} task(s) did not run.`;
      break;
    }

    if (!checkpointed) {
      await deps.checkpoint(goal);
      checkpointed = true;
    }

    next.status = 'running';
    next.attempts = 0;
    deps.ports.onEvent({ type: 'task:start', id: next.id, assignee: next.assignee });

    let outcome: 'passed' | 'failed' | 'stopped' = 'failed';
    for (let attempt = 1; attempt <= deps.budget.maxAttemptsPerTask; attempt += 1) {
      if (deps.ports.isCancellationRequested()) break;

      const estimate = estimateTurn(next);
      if (deps.tracker.spent() + estimate > deps.budget.maxCredits) {
        // Nothing has been attempted yet, so the task goes back to pending rather
        // than staying flagged as running in a persisted state.
        next.status = 'pending';
        state.status = 'stopped-budget';
        state.error = `Stopped before "${next.title}": the next turn is estimated at ${estimate} credits and the team cap is ${deps.budget.maxCredits}.`;
        outcome = 'stopped';
        break;
      }

      next.attempts = attempt;
      deps.ports.onEvent({ type: 'task:attempt', id: next.id, attempt });

      const prior = previousFailure(next);
      // The role brief and the team's shared context belong in the instruction,
      // not in the port: the app's chat path takes one instruction string, so the
      // team composes it here, where it alone knows who is speaking and what the
      // others have already reported.
      const unit: TurnUnit = { ...next, instruction: buildTaskInstruction(next, sharedContext(state)) };
      const turn = await deps.ports.runTurn({
        goal,
        milestone: unit,
        feedback: prior ?? undefined,
        feedbackText: prior ? buildRepairBrief(unit, prior, next.patchFailures, attempt - 1) : undefined
      });
      next.touchedFiles = [...new Set([...(next.touchedFiles ?? []), ...(turn.touchedFiles ?? [])])];
      next.filesRead = [...new Set([...(next.filesRead ?? []), ...(turn.filesRead ?? [])])];
      next.pendingReview = [...new Set([...(next.pendingReview ?? []), ...(turn.pendingReview ?? [])])];
      if (turn.pendingReview && turn.pendingReview.length > 0) {
        deps.ports.onEvent({ type: 'task:review', id: next.id, paths: turn.pendingReview });
      }
      const report = await deps.ports.verify(next);

      next.lastReport = report;
      next.report = trim(turn.reply, REPORT_LIMIT);
      next.patchesApplied += turn.patchesApplied;
      next.patchFailures = turn.patchFailures;
      next.creditsSpent = Math.round((next.creditsSpent + turn.creditsSpent) * 10) / 10;
      // The real cost is settled after the turn, from the tokens the provider
      // reported; the estimate before it is only the gate that stops a runaway.
      deps.tracker.credit(turn.creditsSpent);
      state.creditsSpent = deps.tracker.spent();
      deps.ports.onEvent({ type: 'task:verdict', id: next.id, verdict: report.verdict, report });
      deps.ports.onEvent({ type: 'credit', spent: turn.creditsSpent, total: state.creditsSpent });
      deps.persist(state);

      if (turn.aborted) {
        next.status = 'failed';
        outcome = 'failed';
        deps.ports.onEvent({ type: 'team:log', text: `"${next.title}" was interrupted mid-turn.` });
        break;
      }

      if (report.verdict === 'passed') {
        next.status = 'passed';
        outcome = 'passed';
        break;
      }

      if (report.verdict === 'unverified') {
        next.status = 'passed';
        outcome = 'passed';
        if (next.expectedFiles.length > 0) {
          unverified.push(`${next.title}: ${report.notes.join('; ') || 'no checker could run'}`);
        }
        deps.ports.onEvent({
          type: 'team:log',
          text: `"${next.title}" was not verified (${report.notes.join('; ') || 'no checker could run'}).`
        });
        break;
      }

      if (attempt >= deps.budget.maxAttemptsPerTask) {
        next.status = 'failed';
        outcome = 'failed';
        break;
      }

      deps.ports.onEvent({
        type: 'team:log',
        text: `"${next.title}" failed check ${attempt}/${deps.budget.maxAttemptsPerTask}.`
      });
    }

    if (outcome === 'stopped') {
      deps.persist(state);
      break;
    }

    postMessage(state, next, outcome, deps);
    deps.persist(state);
  }

  if (deps.ports.isCancellationRequested() && state.status === 'running') {
    state.status = 'cancelled';
    state.error = `Cancelled with ${countPending(state.tasks)} task(s) left.`;
  }

  for (const blocked of findBlocked(state.tasks)) {
    if (blocked.status === 'pending') {
      blocked.status = 'blocked';
      deps.ports.onEvent({ type: 'task:done', id: blocked.id, status: 'blocked' });
    }
  }

  state.creditsSpent = deps.tracker.spent();
  if (state.status === 'running') {
    const unresolved = state.tasks.filter((task) => task.status === 'failed' || task.status === 'blocked');
    state.status = unresolved.length > 0 ? 'failed' : 'done';
    if (unresolved.length > 0) {
      state.error = `${unresolved.length} of ${state.tasks.length} tasks did not complete.`;
    } else if (unverified.length > 0) {
      state.error = `${unverified.length} file-changing task(s) finished without a check that could prove them — ${unverified.join('; ')}.`;
    }
  }

  const touchedFiles = Array.from(new Set(state.tasks.flatMap((t) => t.touchedFiles ?? [])));
  const completedTasks = state.tasks.filter((t) => t.status === 'passed' || t.status === 'unverified').length;
  const testsPassed = state.tasks.filter((t) => t.assignee === 'tests' && t.status === 'passed').length;
  const testsRun = state.tasks.filter((t) => t.assignee === 'tests').length;
  const openIssues = state.tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').map((t) => `${t.assignee}: ${t.title}`);

  state.summaryReport = {
    overview: state.status === 'done'
      ? `Agent team successfully completed goal: "${state.goal}".`
      : `Agent team concluded with status "${state.status}": ${state.error ?? 'Review individual task reports.'}`,
    filesModified: touchedFiles,
    tasksCompleted: completedTasks,
    totalTasks: state.tasks.length,
    testsPassed,
    testsRun,
    durationMs: Math.max(0, deps.now() - state.startedAt),
    openIssues: openIssues.length > 0 ? openIssues : undefined
  };

  deps.persist(state);
  deps.ports.onEvent({ type: 'team:done', status: state.status });
  return state;
}

/** The last check's report, but only when it is what the next attempt must repair. */
function previousFailure(task: TeamTask): VerificationReport | null {
  return task.lastReport?.verdict === 'failed' ? task.lastReport : null;
}

/**
 * Record what this agent wants the rest of the team to know. A failed task posts
 * a `blocked` note so its dependents (and the reviewer reading the shared
 * context) see why the work stopped there.
 */
function postMessage(state: TeamState, task: TeamTask, outcome: 'passed' | 'failed', deps: TeamDeps): void {
  const message: TeamMessage = {
    from: task.assignee,
    to: 'team',
    kind: outcome === 'failed' ? 'blocked' : task.expectedFiles.length > 0 ? 'handoff' : 'finding',
    text: summarise(task, outcome),
    at: deps.now()
  };
  state.messages.push(message);
  deps.ports.onEvent({ type: 'message', message });
  deps.ports.onEvent({ type: 'task:done', id: task.id, status: task.status });
}

/** Exposed for the panel's rollup: the statuses that mean "the team is stuck". */
export const UNSETTLED_TASK_STATUSES: TaskStatus[] = ['failed', 'blocked'];
