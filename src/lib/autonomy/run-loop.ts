/**
 * The autonomous driver: plan, then run milestones until they pass, a work
 * ceiling is reached, or the user stops it.
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
import { ceilingReached, type CeilingStop, workUsageOf } from './budget';

export interface DriverDeps {
  ports: AutonomyPorts;
  budget: RunBudget;
  /** planner.planFromGoal, adapted to the files the workspace reports right now. */
  planGoal: (goal: string, files: string[], budget: RunBudget) => Promise<{ milestones: Milestone[]; errors: PlanError[] }>;
  validate: (milestones: Milestone[], files: string[], budget: RunBudget) => PlanError[];
  nextRunnable: (milestones: Milestone[]) => Milestone | null;
  /** Milestones that can never run because a dependency failed. */
  findBlocked: (milestones: Milestone[]) => Milestone[];
  /** feedback.buildRepairFeedback */
  feedbackFor: (milestone: Milestone, report: VerificationReport, patchFailures: string[], attemptIndex: number) => string;
  /** Runs once before the first write so Rollback has something to restore. */
  checkpoint: (goal: string) => Promise<string | null> | string | null;
  /** Restores the pre-run checkpoint after a run fails unrecoverably. */
  rollback?: (checkpointId: string) => Promise<boolean> | boolean;
  persist: (state: RunState) => void;
  now: () => number;
  /** Plan and validate, then stop before the first write. */
  dryRun?: boolean;
  /**
   * The Stop/Pause button's signal, handed to every turn so an in-flight request
   * ends when the user asks. Absent means the driver has nothing to abort with.
   */
  turnSignal?: () => AbortSignal | undefined;
}

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
 * Why the user asked the driver to take no more turns, or null when they have
 * not. Stop outranks Pause when both were pressed: one ends the run, the other
 * only waits, and the run cannot do both.
 */
function userHalt(ports: AutonomyPorts): 'cancelled' | 'paused' | null {
  if (ports.isCancellationRequested()) return 'cancelled';
  if (ports.isPauseRequested?.()) return 'paused';
  return null;
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
        // A milestone left mid-flight by a crash, a Stop or a Pause is runnable
        // again. Leaving it `stopped` would make `nextRunnable` skip it forever,
        // and the resumed pass would then report `done` with work still owing —
        // which is exactly the dishonesty this loop exists to avoid.
        milestones: (resumeFrom as RunState).milestones.map((milestone) => ({
          ...milestone,
          status:
            milestone.status === 'running' || milestone.status === 'stopped' || milestone.status === 'blocked'
              ? 'pending'
              : milestone.status
        }))
      }
    : {
        id: `run-${deps.now()}`,
        goal,
        status: 'planning',
        milestones: [],
        startedAt: deps.now()
      };
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
  /**
   * Set when a turn reported that the user ended it. The halt flags are normally
   * already set at that moment, but a run must never claim `done` because a host
   * said "stopped" without also saying which button was pressed.
   */
  let endedByUser: 'cancelled' | 'paused' | null = null;
  const unverified: string[] = [];
  // The clock starts here, not at `state.startedAt`: a run that was stopped on
  // Tuesday and resumed on Friday is not four days out of a time budget.
  const clockStart = deps.now();

  while (userHalt(deps.ports) === null) {
    const next = deps.nextRunnable(state.milestones);
    if (!next) break;

    const ceiling = workStop(deps, state.milestones, deps.now() - clockStart);
    if (ceiling) {
      state.status = 'stopped';
      state.error = `${ceiling.message} ${remaining(state.milestones)} milestone(s) did not run.`;
      break;
    }

    if (!checkpointed) {
      checkpointId = (await deps.checkpoint(goal)) ?? null;
      state.checkpointId = checkpointId;
      checkpointed = true;
    }

    next.status = 'running';
    deps.ports.onEvent({ type: 'milestone:start', id: next.id });

    let outcome: 'passed' | 'unverified' | 'failed' | 'blocked' | 'stopped' = 'failed';
    for (let attempt = 1; attempt <= deps.budget.maxAttemptsPerMilestone; attempt += 1) {
      if (userHalt(deps.ports) !== null) {
        // The unit was set running above. Leaving it `running` in a persisted
        // state would tell the next panel that work is in flight which died
        // here, so it is filed as stopped — or back as pending when it never
        // got a turn at all.
        next.status = next.attempts.length > 0 ? 'stopped' : 'pending';
        outcome = 'stopped';
        break;
      }

      // A turn can take minutes, so the clock and the iteration caps are read
      // again at the point where one more turn would otherwise start.
      const midCeiling = workStop(deps, state.milestones, deps.now() - clockStart);
      if (midCeiling) {
        next.status = next.attempts.length > 0 ? 'stopped' : 'pending';
        state.status = 'stopped';
        state.error = `${midCeiling.message} ${remaining(state.milestones)} milestone(s) did not run.`;
        outcome = 'stopped';
        break;
      }

      const startedAt = deps.now();
      deps.ports.onEvent({ type: 'milestone:attempt', id: next.id, attempt });
      const prior = previousFeedback(next);
      // Held changes are not on disk. A repair turn must know that, or it
      // "fixes" imports against content only the review queue has seen.
      const heldBefore = next.pendingReview ?? [];
      const heldNote = heldBefore.length > 0
        ? `Files with changes held for user review (NOT on disk): ${heldBefore.join(', ')}. Their pending content is not applied — work with what is actually on disk, and do not re-propose those same edits.`
        : '';
      const baseFeedback = prior ? deps.feedbackFor(next, prior, lastFailures(next), next.attempts.length) : '';
      const feedbackText = [baseFeedback, heldNote].filter(Boolean).join('\n\n') || undefined;
      const turn = await deps.ports.runTurn({
        goal,
        milestone: next,
        feedback: prior,
        feedbackText,
        // Without this the Stop button only lands between units, so a turn
        // keeps streaming after the user asked for it to end.
        signal: deps.turnSignal?.()
      });
      next.touchedFiles = [...new Set([...(next.touchedFiles ?? []), ...(turn.touchedFiles ?? [])])];
      next.pendingReview = [...new Set([...(next.pendingReview ?? []), ...(turn.pendingReview ?? [])])];
      if (turn.pendingReview && turn.pendingReview.length > 0) {
        deps.ports.onEvent({ type: 'milestone:review', id: next.id, paths: turn.pendingReview });
      }
      // The verifier is told what this turn actually wrote, so a milestone
      // that passed a clean check without touching a byte says so in its notes.
      const report = await deps.ports.verify(next, {
        patchesApplied: turn.patchesApplied,
        changedFiles: turn.changedFiles
      });
      const verdict = verdictOf(report);
      const attemptRecord: Attempt = {
        index: attempt,
        reply: turn.reply,
        patchesApplied: turn.patchesApplied,
        patchFailures: turn.patchFailures,
        verification: report,
        toolCalls: turn.toolCalls,
        // The command-failure receipt travels with the attempt: the journal
        // and a resumed run can see the real evidence behind a failed check.
        failureProof: turn.failureProof ?? undefined,
        startedAt
      };
      next.attempts.push(attemptRecord);
      // Patches are not the only way a turn writes: delete_file, run_command
      // and external MCP tools mutate the workspace without applying a patch,
      // and a run that damaged disk through them must still roll back.
      if (turn.patchesApplied > 0 || (turn.changedFiles ?? 0) > 0) wrote = true;
      deps.ports.onEvent({ type: 'milestone:verdict', id: next.id, verdict, report, attempt });
      deps.persist(state);

      if (turn.aborted) {
        // A turn the user ended and a turn that died are different outcomes:
        // one is a stop to honour, the other a failure to report and repair.
        const byUser = turn.stopped === true || userHalt(deps.ports) !== null;
        next.status = byUser ? 'stopped' : 'failed';
        outcome = byUser ? 'stopped' : 'failed';
        if (byUser) endedByUser = userHalt(deps.ports) ?? 'cancelled';
        deps.ports.onEvent({
          type: 'log',
          text: `"${next.title}" ${byUser ? 'was stopped mid-turn' : 'was interrupted mid-turn'}.`
        });
        break;
      }

      if (verdict === 'passed') {
        next.status = 'passed';
        outcome = 'passed';
        // A passed with caveats is still shown with the caveats: the verdict
        // event alone reads as a bare "passed", so the notes (a touched-nothing
        // milestone, a declined proof command) reach the panel log and journal.
        if (report.notes.length > 0) {
          deps.ports.onEvent({
            type: 'log',
            text: `"${next.title}" passed (${report.notes.join('; ')}).`
          });
        }
        break;
      }

      if (verdict === 'unverified') {
        // The plan advances — nothing was disproved — but the milestone is not
        // recorded as passed. `unverified` is its own status all the way into the
        // panel, the summary and a resumed run, because a step nobody proved is
        // not a step that succeeded.
        next.status = 'unverified';
        unverified.push(`${next.title}: ${report.notes.join('; ') || 'no checker could run'}`);
        outcome = 'unverified';
        deps.ports.onEvent({
          type: 'log',
          text: `"${next.title}" was not verified (${report.notes.join('; ') || 'no checker could run'}).`
        });
        break;
      }

      // A failed check whose cause sits in the review queue cannot be repaired
      // by another turn: the bytes are not on disk and only the user can
      // accept them. Pause with the work intact instead of burning the attempt
      // ceiling and then rolling back everything the run already landed.
      const held = next.pendingReview ?? [];
      if (held.length > 0 && reviewExplainsFailure(next, report, held)) {
        next.status = 'stopped';
        outcome = 'stopped';
        state.status = 'paused';
        state.error = `"${next.title}" is waiting for your review: ${held.join(', ')}. Accept the held changes, then resume the run.`;
        deps.ports.onEvent({
          type: 'log',
          text: `"${next.title}" paused — ${held.length} file(s) await review before its check can pass.`
        });
        deps.ports.onEvent({ type: 'milestone:done', id: next.id, status: 'stopped' });
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

  const halt = userHalt(deps.ports) ?? endedByUser;
  if (halt && state.status === 'running') {
    state.status = halt;
    state.error = `${halt === 'paused' ? 'Paused' : 'Cancelled'} with ${remaining(state.milestones)} milestone(s) left.`;
  }

  for (const blocked of deps.findBlocked(state.milestones)) {
    if (blocked.status === 'pending') {
      blocked.status = 'blocked';
      deps.ports.onEvent({ type: 'milestone:done', id: blocked.id, status: 'blocked' });
    }
  }

  if (state.status === 'running') {
    const unresolved = state.milestones.filter((m) => m.status === 'failed' || m.status === 'blocked');
    // Counted from the milestone list, not the local log, so a run that resumes
    // still reports the steps an earlier pass left unproven.
    // An unverified step only raises the alarm when it owned files: a read-only
    // milestone has nothing to prove, and flagging every one of them would make
    // the warning that matters — an unproven edit — noise.
    const unproven = state.milestones.filter((m) => m.status === 'unverified' && m.expectedFiles.length > 0);
    state.status = unresolved.length > 0 ? 'failed' : 'done';
    if (unresolved.length > 0) {
      state.error = `${unresolved.length} of ${state.milestones.length} milestones did not complete.`;
    } else if (unproven.length > 0) {
      state.error = `${unproven.length} of ${state.milestones.length} milestones finished unverified — nothing checked them, so they are not claimed as passed.${unverified.length > 0 ? ` (${unverified.join('; ')}).` : ''}`;
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

/**
 * Which work ceiling this run has reached, if any.
 *
 * Read off the attempts in the milestone list rather than a counter the loop
 * keeps: a resumed run then starts with the turns its earlier pass already made
 * still counted against the cap, which is what a cap is for.
 */
function workStop(deps: DriverDeps, milestones: Milestone[], elapsedMs: number): CeilingStop | null {
  return ceilingReached(deps.budget, workUsageOf(milestones.flatMap((milestone) => milestone.attempts), elapsedMs));
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

/**
 * True when the failed check plausibly judges files whose changes are held:
 * either the milestone expected a file that is sitting in review, or a checker
 * error points straight at one. Without this link a genuine type error would
 * pause the run for an unrelated held file.
 */
function reviewExplainsFailure(milestone: Milestone, report: VerificationReport, held: string[]): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const heldSet = new Set(held.map(normalize));
  return (
    milestone.expectedFiles.some((file) => heldSet.has(normalize(file))) ||
    report.diagnostics.some((line) => heldSet.has(normalize(line.path)))
  );
}
