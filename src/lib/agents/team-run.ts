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
 * means a hard task cap and a hard spend cap, not a thread pool.
 *
 * When the last task settles, one closing turn reads the run as a whole. Each task
 * only ever checked its own files, so a prop Frontend renamed and Backend never
 * saw passes every per-task check and still ships broken; the integration turn is
 * the only moment anything looks at all the changed files at once.
 */

import { ceilingReached, estimateTurn, toolCallsReported, type WorkUsage } from '../autonomy/budget';
import { countPending, findBlocked, nextRunnable } from '../autonomy/dag';
import { buildRepairBrief } from '../autonomy/feedback';
import type { CreditTracker } from '../autonomy/run-loop';
import type { DiagnosticLine, PlanError, TurnUnit, VerificationReport } from '../autonomy/types';
import { normalizeOwnedPath } from './ownership';
import {
  buildIntegrationInstruction,
  buildTaskInstruction,
  changedFileUnion,
  changedFilesByRole,
  integrationRole,
  ownershipMap,
  writeOverlaps
} from './roles';
import type {
  AgentRole,
  TaskStatus,
  TeamBudget,
  TeamMergeReport,
  TeamMessage,
  TeamPorts,
  TeamState,
  TeamPlan,
  TeamTask,
  MergeVerdict
} from './types';

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
  /**
   * The Stop/Pause button's signal, handed to every task turn so an in-flight
   * request ends when the user asks. Absent means the driver has nothing to
   * abort with, and a halt is only noticed between turns.
   */
  turnSignal?: () => AbortSignal | undefined;
  /**
   * Who carries the closing integration turn: `coordinator` (default, may repair)
   * or `reviewer` (reads and reports). Anything else falls back to the coordinator.
   */
  integrationRole?: AgentRole;
}

/**
 * The closing turn's id. It is deliberately not a plan task: the checklist, the
 * per-task retry loop and the persisted resume all describe assigned work, and an
 * unassigned final pass must not look like a task nobody planned.
 */
export const INTEGRATION_TASK_ID = 'integration';
const INTEGRATION_TITLE = 'Integrate the team’s changes as one closing pass';


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

/**
 * What the team has spent of its non-money ceilings, read off the tasks rather
 * than a counter the driver has to keep in sync — so a resumed plan still counts
 * the turns its earlier pass made.
 */
function workUsage(tasks: readonly TeamTask[], elapsedMs: number): WorkUsage {
  return {
    turns: tasks.reduce((sum, task) => sum + task.attempts, 0),
    toolCalls: toolCallsReported(tasks),
    elapsedMs
  };
}

/**
 * Why the user asked the team to take no more turns, or null when they have not.
 * Stop outranks Pause when both were pressed: one ends the run, the other only
 * waits, and the team cannot do both.
 */
function userHalt(ports: TeamPorts): 'cancelled' | 'paused' | null {
  if (ports.isCancellationRequested()) return 'cancelled';
  if (ports.isPauseRequested?.()) return 'paused';
  return null;
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
function summarise(task: TeamTask, outcome: 'passed' | 'unverified' | 'failed'): string {
  const notes = task.lastReport?.notes ?? [];
  if (outcome === 'failed') {
    return `"${task.title}" did not pass after ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}: ${notes.join('; ') || 'no checker could run'}.`;
  }
  if (outcome === 'unverified') {
    // Teammates build on this, so the note says what is actually true: the work
    // is done and nothing disproved it, but nothing proved it either.
    return `"${task.title}" is unverified — nothing checked it (${notes.join('; ') || 'no checker could run'}). Treat it as unproven.`;
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
  /**
   * Set when a turn reported that the user ended it. The halt flags are normally
   * already set by then, but a team must never claim `done` because a host said
   * "stopped" without also saying which button was pressed.
   */
  let endedByUser: 'cancelled' | 'paused' | null = null;
  // The clock starts with the driving, not with the plan: a team stopped on
  // Tuesday and resumed on Friday is not four days out of a time ceiling.
  const clockStart = deps.now();

  while (userHalt(deps.ports) === null) {
    const next = nextRunnable(state.tasks);
    if (!next) break;

    if (deps.tracker.exhausted()) {
      state.status = 'stopped-budget';
      state.error = `Stopped at the spend cap of ${deps.budget.maxCredits}. ${countPending(state.tasks)} task(s) did not run.`;
      break;
    }

    const ceiling = ceilingReached(deps.budget, workUsage(state.tasks, deps.now() - clockStart));
    if (ceiling) {
      state.status = 'stopped-budget';
      state.error = `${ceiling.message} ${countPending(state.tasks)} task(s) did not run.`;
      break;
    }

    if (!checkpointed) {
      await deps.checkpoint(goal);
      checkpointed = true;
    }

    next.status = 'running';
    next.attempts = 0;
    deps.ports.onEvent({ type: 'task:start', id: next.id, assignee: next.assignee });

    let outcome: 'passed' | 'unverified' | 'failed' | 'stopped' = 'failed';
    /** Set when a turn's real cost pushed the team past its cap. */
    let overSpend: number | null = null;
    for (let attempt = 1; attempt <= deps.budget.maxAttemptsPerTask; attempt += 1) {
      if (userHalt(deps.ports) !== null) {
        // The task was set running above. Leaving it `running` in a persisted
        // state would tell the next panel that work is in flight which died
        // here, so it is filed as stopped — or back as pending when it never
        // got a turn at all.
        next.status = next.attempts > 0 ? 'stopped' : 'pending';
        outcome = 'stopped';
        break;
      }

      const estimate = estimateTurn(next);
      // The estimate is a prediction; what this task has already cost is
      // evidence, so a task that runs dearer than predicted is refused on the
      // higher of the two.
      const observed = next.attempts > 0 ? Math.round((next.creditsSpent / next.attempts) * 10) / 10 : 0;
      const reserve = Math.max(estimate, observed);
      if (deps.tracker.spent() + reserve > deps.budget.maxCredits) {
        // Nothing has been attempted yet, so the task goes back to pending rather
        // than staying flagged as running in a persisted state.
        next.status = 'pending';
        state.status = 'stopped-budget';
        state.error = `Stopped before "${next.title}": the next turn is estimated at ${reserve} spend and the team cap is ${deps.budget.maxCredits}.`;
        outcome = 'stopped';
        break;
      }

      // A turn can take minutes, so the ceilings are read again at the point
      // where one more turn would otherwise be paid for.
      const midCeiling = ceilingReached(deps.budget, workUsage(state.tasks, deps.now() - clockStart));
      if (midCeiling) {
        next.status = next.attempts > 0 ? 'stopped' : 'pending';
        state.status = 'stopped-budget';
        state.error = `${midCeiling.message} ${countPending(state.tasks)} task(s) did not run.`;
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
        feedbackText: prior ? buildRepairBrief(unit, prior, next.patchFailures, attempt - 1) : undefined,
        // Without this the Stop button only lands between tasks, so a teammate's
        // paid turn keeps streaming after the user asked for it to end.
        signal: deps.turnSignal?.()
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
      if (typeof turn.toolCalls === 'number') {
        next.toolCalls = (next.toolCalls ?? 0) + turn.toolCalls;
      }
      // The real cost is settled after the turn, from the tokens the provider
      // reported; the estimate before it is only the gate that stops a runaway.
      const settled = deps.tracker.credit(turn.creditsSpent);
      if (!settled.allowed) overSpend = settled.spent;
      state.creditsSpent = deps.tracker.spent();
      deps.ports.onEvent({ type: 'task:verdict', id: next.id, verdict: report.verdict, report });
      deps.ports.onEvent({ type: 'credit', spent: turn.creditsSpent, total: state.creditsSpent });
      deps.persist(state);

      if (turn.aborted) {
        // A turn the user ended and a turn that died are different outcomes: one
        // is a stop to honour, the other a failure to report and repair.
        const byUser = turn.stopped === true || userHalt(deps.ports) !== null;
        next.status = byUser ? 'stopped' : 'failed';
        outcome = byUser ? 'stopped' : 'failed';
        if (byUser) endedByUser = userHalt(deps.ports) ?? 'cancelled';
        deps.ports.onEvent({
          type: 'team:log',
          text: `"${next.title}" was ${byUser ? 'stopped' : 'interrupted'} mid-turn.`
        });
        break;
      }

      if (report.verdict === 'passed') {
        next.status = 'passed';
        outcome = 'passed';
        break;
      }

      if (report.verdict === 'unverified') {
        // Its own status, never rewritten to `passed`: the team advances because
        // nothing was disproved, but this task stays marked unproven everywhere
        // the status travels — panel, summary report, shared note, resumed run.
        next.status = 'unverified';
        outcome = 'unverified';
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

    // The estimate let this turn start; the real cost is the evidence. One turn
    // may overshoot because nobody can refuse a turn not yet run — many may
    // not, so the team stops on the overshoot instead of rediscovering it.
    if (overSpend !== null) {
      state.status = 'stopped-budget';
      state.error = `Stopped at the spend cap of ${deps.budget.maxCredits}: "${next.title}" has taken ${next.creditsSpent} and the team is at ${overSpend}, so no further turn is started. ${countPending(state.tasks)} task(s) did not run.`;
      deps.persist(state);
      break;
    }
  }

  const halt = userHalt(deps.ports) ?? endedByUser;
  if (halt && state.status === 'running') {
    state.status = halt;
    state.error = `${halt === 'paused' ? 'Paused' : 'Cancelled'} with ${countPending(state.tasks)} task(s) left.`;
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
    // Only an unverified step that owned files is worth an alarm: a read-only
    // task has nothing to prove, and saying so on every one of them would train
    // the user to ignore the warning that matters.
    const unproven = state.tasks.filter((task) => task.status === 'unverified' && task.expectedFiles.length > 0);
    state.status = unresolved.length > 0 ? 'failed' : 'done';
    if (unresolved.length > 0) {
      state.error = `${unresolved.length} of ${state.tasks.length} tasks did not complete.`;
    } else if (unproven.length > 0) {
      state.error = `${unproven.length} of ${state.tasks.length} tasks finished unverified — nothing checked them, so they are not claimed as passed.${unverified.length > 0 ? ` (${unverified.join('; ')}).` : ''}`;
    }
  }

  // The closing pass, and only for a run whose assigned work is all settled: a
  // cancelled or budget-stopped team reports what it has, it has no end to merge.
  if (canIntegrate(state, deps)) await integrateRun(goal, state, deps);

  // The merge turn credits itself, so the file list is read after it, not before.
  const touchedFiles = Array.from(
    new Set([...state.tasks.flatMap((t) => t.touchedFiles ?? []), ...(state.mergeReport?.files ?? [])])
  );
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
    openIssues: openIssues.length > 0 ? openIssues : undefined,
    mergeVerdict: state.mergeReport?.verdict,
    mergeConflicts: state.mergeReport?.overlaps.map((overlap) => overlap.note)
  };

  deps.persist(state);
  deps.ports.onEvent({ type: 'team:done', status: state.status });
  return state;
}

/** Whether this run has an end to merge at all. */
function canIntegrate(state: TeamState, deps: TeamDeps): boolean {
  if (deps.ports.isCancellationRequested()) return false;
  // A halted team has no end to merge: it stopped because the user asked, not
  // because the work finished, so an integration turn would spend credits on a
  // run they intend to continue.
  if (userHalt(deps.ports) !== null) return false;
  if (state.status === 'planning' || state.status === 'cancelled' || state.status === 'paused' || state.status === 'stopped-budget') return false;
  if (state.tasks.some((task) => task.status === 'pending' || task.status === 'running')) return false;
  return changedFileUnion(state.tasks).length > 0;
}

/**
 * The closing integration turn: one agent reads the whole change set — the files
 * each role changed, the plan's ownership map, and the diagnostics for every
 * changed file at once — and its verdict decides whether the run ends `done`.
 *
 * Two things it must never do: accept an overlap silently, and claim a merge it
 * could not check. Both are verdicts here, not prose in a reply.
 */
async function integrateRun(goal: string, state: TeamState, deps: TeamDeps): Promise<void> {
  const role = integrationRole(deps.integrationRole);
  const byRole = changedFilesByRole(state.tasks);
  const ownership = ownershipMap(state.tasks);
  const overlaps = writeOverlaps(state.tasks);
  let mergedFiles = changedFileUnion(state.tasks);
  let awaitingReview = [...new Set(state.tasks.flatMap((task) => task.pendingReview ?? []))];
  const notes: string[] = [];

  // Diagnostics arrive through the port a task's own check uses; the only thing
  // wider here is the unit it names — every changed file at once, not one task's.
  const before = await deps.ports.verify({ id: INTEGRATION_TASK_ID, expectedFiles: mergedFiles });

  const estimate = estimateTurn({ expectedFiles: mergedFiles });
  const left = Math.round((deps.budget.maxCredits - deps.tracker.spent()) * 10) / 10;
  const skipped = deps.ports.isCancellationRequested() || left < estimate;

  deps.ports.onEvent({
    type: 'team:log',
    text: skipped
      ? `Integration pass skipped: the closing turn needs about ${estimate} spend and the team has ${left} left.`
      : `Integration: ${role} is checking ${mergedFiles.length} changed file(s) together.`
  });

  let reply = '';
  let creditsSpent = 0;
  let ran = false;
  let checked = before;

  if (!skipped) {
    const unit: TurnUnit = {
      id: INTEGRATION_TASK_ID,
      title: INTEGRATION_TITLE,
      instruction: buildIntegrationInstruction({
        goal,
        role,
        byRole,
        ownership,
        overlaps,
        diagnostics: before.diagnostics,
        awaitingReview
      }),
      expectedFiles: mergedFiles
    };
    const turn = await deps.ports.runTurn({ goal, milestone: unit });
    ran = true;
    reply = trim(turn.reply, REPORT_LIMIT);
    creditsSpent = turn.creditsSpent;
    deps.tracker.credit(turn.creditsSpent);
    deps.ports.onEvent({ type: 'credit', spent: turn.creditsSpent, total: deps.tracker.spent() });

    const extra = [...new Set((turn.touchedFiles ?? []).map(normalizeOwnedPath))]
      .filter((file) => file.length > 0 && !mergedFiles.includes(file));
    if (extra.length > 0) {
      // A repair is part of the merge: it is credited to the role that made it and
      // re-checked, because fixing one pair can break another.
      const mine = byRole.find((entry) => entry.role === role);
      if (mine) {
        mine.taskIds.push(INTEGRATION_TASK_ID);
        mine.files.push(...extra);
      } else {
        byRole.push({ role, taskIds: [INTEGRATION_TASK_ID], files: extra });
      }
      mergedFiles = [...mergedFiles, ...extra];
    }
    awaitingReview = [...new Set([...awaitingReview, ...(turn.pendingReview ?? [])])];
    checked = await deps.ports.verify({ id: INTEGRATION_TASK_ID, expectedFiles: mergedFiles });
    if (turn.aborted) notes.push('the closing turn was interrupted mid-turn, so its repair may be partial.');
  } else {
    notes.push(
      `the closing turn did not run — ${integrationSkipReason(deps)}. This verdict is the whole-team check, not a merge.`
    );
  }

  const diagnostics = checked.diagnostics;
  const errors = diagnostics.filter((line) => line.severity === 'error').length;
  const warnings = diagnostics.filter((line) => line.severity === 'warning').length;

  // The overlaps are listed first: they are the reason this turn exists, and a
  // clean type check does not make an overwritten role's work any less gone.
  for (const overlap of overlaps) notes.push(overlap.note);
  if (errors > 0) notes.push(`${errors} error diagnostic(s) remain across ${mergedFiles.length} changed file(s) after the merge.`);
  if (warnings > 0) notes.push(`${warnings} warning(s) across the merged files.`);
  if (checked.verdict === 'unverified') {
    notes.push(`nothing could check the merged files: ${checked.notes.join('; ') || 'no checker could run'}`);
  }

  const verdict: MergeVerdict =
    errors > 0
      ? 'broken'
      : overlaps.length > 0
        ? 'conflicts'
        : checked.verdict === 'unverified'
          ? 'unverified'
          : warnings > 0
            ? 'warned'
            : 'clean';

  const report: TeamMergeReport = {
    role,
    verdict,
    ran,
    files: mergedFiles,
    byRole,
    overlaps,
    diagnostics,
    errors,
    warnings,
    awaitingReview,
    notes,
    reply,
    creditsSpent,
    at: deps.now()
  };

  state.mergeReport = report;
  state.creditsSpent = deps.tracker.spent();

  // The panel already shows `conflicts`, so an overlap the merge found on disk goes
  // there as well: a collision nobody planned is still a collision the user must see.
  if (overlaps.length > 0) {
    const known = new Set(state.conflicts ?? []);
    state.conflicts = [...(state.conflicts ?? []), ...overlaps.map((overlap) => overlap.note).filter((note) => !known.has(note))];
  }

  // The merge decides the run's final status. A conflict or a surviving error is
  // not a pass, however green every per-task check looked on its own.
  const failure = mergeFailureText(report);
  if (failure) {
    if (report.verdict === 'broken' || report.verdict === 'conflicts') state.status = 'failed';
    state.error = [state.error, failure].filter((text) => text !== undefined && text.length > 0).join(' ');
  }

  const message: TeamMessage = {
    from: role,
    to: 'team',
    kind: report.verdict === 'clean' || report.verdict === 'warned' ? 'finding' : 'blocked',
    text: mergeLine(report),
    at: deps.now()
  };
  state.messages.push(message);
  deps.ports.onEvent({ type: 'team:integration', report });
  deps.ports.onEvent({ type: 'message', message });
  deps.persist(state);
}

/** Why the closing turn never ran, in the words a user reads. */
function integrationSkipReason(deps: TeamDeps): string {
  return deps.ports.isCancellationRequested()
    ? 'the user stopped the team'
    : 'the spend cap left no room for it';
}

/** The one thing a red merge row needs: which file, and what the checker said. */
function firstError(diagnostics: readonly DiagnosticLine[]): string {
  const line = diagnostics.find((entry) => entry.severity === 'error');
  return line ? `${line.path}:${line.line} ${trim(line.message, 160)}` : 'the checker gave no line';
}

/** The sentence that goes into `state.error`, or null when the merge is not a failure. */
function mergeFailureText(report: TeamMergeReport): string | null {
  if (report.verdict === 'broken') {
    return `Integration found ${report.errors} error(s) in the merged files — ${firstError(report.diagnostics)}. Each task passed its own check, but the team does not fit together.`;
  }
  if (report.verdict === 'conflicts') {
    return `Integration found ${report.overlaps.length} file(s) written by more than one role: ${report.overlaps
      .map((overlap) => overlap.file)
      .join(', ')} — the merge report names who overwrote whom.`;
  }
  if (report.verdict === 'unverified') {
    return 'The closing integration pass could not check the merged files, so the merge is not proven.';
  }
  return null;
}

/** The line the timeline and the shared context both show for a merge report. */
function mergeLine(report: TeamMergeReport): string {
  const parts = [`${report.files.length} changed file(s) across ${report.byRole.length} role(s)`];
  if (report.overlaps.length > 0) parts.push(`${report.overlaps.length} overlap(s)`);
  if (report.errors > 0) parts.push(`${report.errors} error(s) after the merge`);
  else if (report.warnings > 0) parts.push(`${report.warnings} warning(s)`);
  return `Integration (${report.role}) verdict ${report.verdict}: ${parts.join(', ')}.`;
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
function postMessage(state: TeamState, task: TeamTask, outcome: 'passed' | 'unverified' | 'failed', deps: TeamDeps): void {
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
