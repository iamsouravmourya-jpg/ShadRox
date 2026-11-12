/**
 * The autonomous driver: plan, then run milestones until they pass, the budget
 * dies, or the user stops it.
 *
 * Nothing in this file knows what a model, a file, or a terminal is. Every
 * capability arrives through `DriverDeps`, which is what makes the loop testable
 * and what keeps it from inventing its own exec or write path — the app wires the
 * real ones, so patches go through the patch engine, verification through the
 * diagnostics service, and commands through the approval gate whether the loop
 * likes it or not.
 */

import type {
  Attempt,
  AutonomyPorts,
  Milestone,
  PlanError,
  RunBudget,
  RunState,
  VerificationReport,
  Verdict
} from './types';

export interface CreditTracker {
  credit(cost: number): { allowed: boolean; spent: number };
  spent(): number;
  exhausted(): boolean;
}

export interface DriverDeps {
  ports: AutonomyPorts;
  budget: RunBudget;
  /** planner.planFromGoal, adapted to the files the workspace reports right now. */
  planGoal: (goal: string, files: string[], budget: RunBudget) => Promise<{ milestones: Milestone[]; errors: PlanError[] }>;
  validate: (milestones: Milestone[], files: string[], budget: RunBudget) => PlanError[];
  nextRunnable: (milestones: Milestone[]) => Milestone | null;
  /** Milestones that can never run because a dependency failed. */
  findBlocked: (milestones: Milestone[]) => Milestone[];
  tracker: CreditTracker;
  /** feedback.buildRepairFeedback */
  feedbackFor: (milestone: Milestone, report: VerificationReport, patchFailures: string[], attemptIndex: number) => string;
  /** Estimated cost of one more turn, so the budget stops before the spend. */
  estimateTurn: (milestone: Milestone) => number;
  /** Runs once before the first write so Rollback has something to restore. */
  checkpoint: (goal: string) => Promise<string | null> | string | null;
  /** Restores the pre-run checkpoint after a run fails unrecoverably. */
  rollback?: (checkpointId: string) => Promise<boolean> | boolean;
  persist: (state: RunState) => void;
  now: () => number;
  /** Plan and validate, then stop before the first write. */
  dryRun?: boolean;
}

export const MAX_PLAN_REPAIRS = 2;

function newMilestone(source: Milestone): Milestone {
  return { ...source, status: 'pending', attempts: [] };
}

function describeErrors(errors: PlanError[]): string {
  return errors.map((error) => error.message).join('; ');
}

function verdictOf(report: VerificationReport | undefined): Verdict {
  return report?.verdict ?? 'unverified';
}

/**
 * Runs the goal to completion and returns the final state. The loop is
 * sequential on purpose: two milestones editing the same file at once produces a
 * patch that applies against bytes the other one already changed.
 */
export async function runAutonomous(
  goal: string,
  deps: DriverDeps,
  resumeFrom?: RunState
): Promise<RunState> {
  const files = deps.ports.listFiles();
  const resuming = Boolean(resumeFrom && resumeFrom.milestones.length > 0);
  const state: RunState = resuming
    ? {
        ...structuredClone(resumeFrom as RunState),
        status: 'running',
        error: undefined,
        rolledBack: undefined,
        checkpointId: undefined,
        // A milestone left mid-flight by a crash or a stop is runnable again.
        milestones: (resumeFrom as RunState).milestones.map((milestone) => ({
          ...milestone,
          status: milestone.status === 'running' ? 'pending' : milestone.status
        }))
      }
    : {
        id: `run-${deps.now()}`,
        goal,
        status: 'planning',
        milestones: [],
        creditsSpent: 0,
        startedAt: deps.now()
      };
  // The tracker is seeded with the persisted spend by the engine, so a resumed
  // run can never treat an already-spent budget as fresh.
  state.creditsSpent = deps.tracker.spent();
  deps.persist(state);

  if (resuming) {
    deps.ports.onEvent({ type: 'log', text: `Resuming: ${goal}` });
    deps.ports.onEvent({ type: 'plan:created', milestones: state.milestones });
  } else {
    deps.ports.onEvent({ type: 'log', text: `Planning: ${goal}` });

    const planned = await deps.planGoal(goal, files, deps.budget);
    if (planned.errors.length > 0) {
      state.status = 'failed';
      state.error = describeErrors(planned.errors);
      deps.ports.onEvent({ type: 'run:done', status: 'failed' });
      deps.persist(state);
      return state;
    }

    const milestones = planned.milestones.map(newMilestone);
    const invalid = deps.validate(milestones, files, deps.budget);
    if (invalid.length > 0) {
      state.status = 'failed';
      state.error = describeErrors(invalid);
      deps.ports.onEvent({ type: 'run:done', status: 'failed' });
      deps.persist(state);
      return state;
    }

    state.milestones = milestones;
    state.status = 'running';
    deps.ports.onEvent({ type: 'plan:created', milestones });
    deps.persist(state);
  }

  if (deps.dryRun) {
    state.status = 'ready';
    deps.persist(state);
    deps.ports.onEvent({ type: 'run:done', status: state.status });
    return state;
  }

  let checkpointed = false;
  let checkpointId: string | null = null;
  let wrote = false;
  const unverified: string[] = [];

  while (!deps.ports.isCancellationRequested()) {
    const next = deps.nextRunnable(state.milestones);
    if (!next) break;

    if (deps.tracker.exhausted()) {
      state.status = 'stopped-budget';
      state.error = `Stopped at the spend cap of ${deps.budget.maxCredits}. ${remaining(state.milestones)} milestone(s) did not run.`;
      break;
    }

    if (!checkpointed) {
      checkpointId = (await deps.checkpoint(goal)) ?? null;
      state.checkpointId = checkpointId;
      checkpointed = true;
    }

    next.status = 'running';
    deps.ports.onEvent({ type: 'milestone:start', id: next.id });

    let outcome: 'passed' | 'failed' | 'blocked' | 'stopped' = 'failed';
    for (let attempt = 1; attempt <= deps.budget.maxAttemptsPerMilestone; attempt += 1) {
      if (deps.ports.isCancellationRequested()) break;

      const estimate = deps.estimateTurn(next);
      if (deps.tracker.spent() + estimate > deps.budget.maxCredits) {
        // Nothing has been attempted yet, so the milestone goes back to pending
        // rather than staying flagged as running in a persisted state.
        next.status = 'pending';
        state.status = 'stopped-budget';
        state.error = `Stopped before "${next.title}": the next turn is estimated at ${estimate} spend and the cap is ${deps.budget.maxCredits}.`;
        outcome = 'stopped';
        break;
      }

      const startedAt = deps.now();
      deps.ports.onEvent({ type: 'milestone:attempt', id: next.id, attempt });
      const prior = previousFeedback(next);
      const turn = await deps.ports.runTurn({
        goal,
        milestone: next,
        feedback: prior,
        feedbackText: prior ? deps.feedbackFor(next, prior, lastFailures(next), next.attempts.length) : undefined
      });
      next.touchedFiles = [...new Set([...(next.touchedFiles ?? []), ...(turn.touchedFiles ?? [])])];
      next.pendingReview = [...new Set([...(next.pendingReview ?? []), ...(turn.pendingReview ?? [])])];
      if (turn.pendingReview && turn.pendingReview.length > 0) {
        deps.ports.onEvent({ type: 'milestone:review', id: next.id, paths: turn.pendingReview });
      }
      const report = await deps.ports.verify(next);
      const verdict = verdictOf(report);
      const attemptRecord: Attempt = {
        index: attempt,
        reply: turn.reply,
        patchesApplied: turn.patchesApplied,
        patchFailures: turn.patchFailures,
        verification: report,
        creditsSpent: turn.creditsSpent,
        startedAt
      };
      next.attempts.push(attemptRecord);
      if (turn.patchesApplied > 0) wrote = true;
      // The real cost is settled after the turn, from the tokens the provider
      // reported; the estimate before it is only the gate that stops a runaway.
      deps.tracker.credit(turn.creditsSpent);
      state.creditsSpent = deps.tracker.spent();
      deps.ports.onEvent({ type: 'credit', spent: turn.creditsSpent, total: state.creditsSpent });
      deps.ports.onEvent({ type: 'milestone:verdict', id: next.id, verdict, report });
      deps.persist(state);

      if (turn.aborted) {
        next.status = 'failed';
        outcome = 'failed';
        deps.ports.onEvent({ type: 'log', text: `"${next.title}" was interrupted mid-turn.` });
        break;
      }

      if (verdict === 'passed') {
        next.status = 'passed';
        outcome = 'passed';
        break;
      }

      if (verdict === 'unverified') {
        // The run advances — nothing was disproved — but the verdict itself is
        // never rewritten, so the panel and this summary both keep saying so.
        next.status = 'passed';
        unverified.push(`${next.title}: ${report.notes.join('; ') || 'no checker could run'}`);
        outcome = 'passed';
        deps.ports.onEvent({
          type: 'log',
          text: `"${next.title}" was not verified (${report.notes.join('; ') || 'no checker could run'}).`
        });
        break;
      }

      if (attempt >= deps.budget.maxAttemptsPerMilestone) {
        next.status = 'failed';
        outcome = 'failed';
        break;
      }

      // The next attempt composes its brief from this report at the top of the
      // loop, so nothing is re-derived here.
      deps.ports.onEvent({
        type: 'log',
        text: `"${next.title}" failed check ${attempt}/${deps.budget.maxAttemptsPerMilestone}.`
      });
    }

    if (outcome === 'stopped') {
      deps.persist(state);
      break;
    }
    deps.ports.onEvent({ type: 'milestone:done', id: next.id, status: next.status });
    deps.persist(state);
  }

  if (deps.ports.isCancellationRequested() && state.status === 'running') {
    state.status = 'cancelled';
    state.error = `Cancelled with ${remaining(state.milestones)} milestone(s) left.`;
  }

  for (const blocked of deps.findBlocked(state.milestones)) {
    if (blocked.status === 'pending') {
      blocked.status = 'blocked';
      deps.ports.onEvent({ type: 'milestone:done', id: blocked.id, status: 'blocked' });
    }
  }

  state.creditsSpent = deps.tracker.spent();
  if (state.status === 'running') {
    const unresolved = state.milestones.filter((m) => m.status === 'failed' || m.status === 'blocked');
    state.status = unresolved.length > 0 ? 'failed' : 'done';
    if (unresolved.length > 0) {
      state.error = `${unresolved.length} of ${state.milestones.length} milestones did not complete.`;
    } else if (unverified.length > 0) {
      state.error = `${unverified.length} milestone(s) finished without a check that could prove them — ${unverified.join('; ')}.`;
    }
  }

  // An unrecoverable failure must not leave a half-applied workspace behind.
  // Only runs that actually wrote, and only the failure state (not a user stop),
  // are rolled back; restoring the checkpoint is the transactional-safe outcome.
  if (state.status === 'failed' && wrote && checkpointId && deps.rollback) {
    try {
      state.rolledBack = await deps.rollback(checkpointId);
    } catch {
      state.rolledBack = false;
    }
    const note = state.rolledBack
      ? 'Rolled the workspace back to the pre-run checkpoint.'
      : 'Automatic rollback failed — restore the pre-run checkpoint from the timeline.';
    state.error = [state.error, note].filter(Boolean).join(' ');
    deps.ports.onEvent({ type: 'log', text: note });
  }

  deps.persist(state);
  deps.ports.onEvent({ type: 'run:done', status: state.status });
  return state;
}

function remaining(milestones: Milestone[]): number {
  return milestones.filter((milestone) => milestone.status === 'pending').length;
}

/** The last attempt's report, which is what the model needs to see to repair. */
function previousFeedback(milestone: Milestone): VerificationReport | undefined {
  const last = milestone.attempts[milestone.attempts.length - 1];
  if (!last || last.verification?.verdict !== 'failed') return undefined;
  return last.verification;
}

/** Refused patches from the attempt that just failed, for the repair brief. */
function lastFailures(milestone: Milestone): string[] {
  const last = milestone.attempts[milestone.attempts.length - 1];
  return last ? last.patchFailures : [];
}
