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
import { captureFileHashSnapshot } from './milestoneVerifier';
import { auditRequirementCoverage, extractRequirements } from './requirements';
import { canonicalPathKey, dedupePaths, isCaseInsensitivePlatform } from '../paths';

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

interface ExecutionShared {
  goal: string;
  deps: DriverDeps;
  state: RunState;
  caseInsensitive: boolean;
  clockStart: number;
  unverified: string[];
  checkpointId: string | null;
  checkpointed: boolean;
  wrote: boolean;
  endedByUser: 'cancelled' | 'paused' | null;
}

async function executeMilestoneUnit(
  next: Milestone,
  shared: ExecutionShared,
  options: { maxAttempts?: number; initialReport?: VerificationReport } = {}
): Promise<'passed' | 'unverified' | 'failed' | 'stopped'> {
  const { deps, state, goal } = shared;
  const maxAttempts = options.maxAttempts ?? deps.budget.maxAttemptsPerMilestone;

  if (!shared.checkpointed) {
    shared.checkpointId = (await deps.checkpoint(goal)) ?? null;
    state.checkpointId = shared.checkpointId;
    shared.checkpointed = true;
  }

  next.status = 'running';
  deps.ports.onEvent({ type: 'milestone:start', id: next.id });

  const existingSet = new Set(deps.ports.listFiles().map((file) => canonicalPathKey(file, shared.caseInsensitive)));
  const preExistingExpectedFiles = next.expectedFiles.filter((file) =>
    existingSet.has(canonicalPathKey(file, shared.caseInsensitive))
  );

  let outcome: 'passed' | 'unverified' | 'failed' | 'stopped' = 'failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (userHalt(deps.ports) !== null) {
      next.status = next.attempts.length > 0 ? 'stopped' : 'pending';
      outcome = 'stopped';
      break;
    }

    const midCeiling = workStop(deps, state.milestones, deps.now() - shared.clockStart);
    if (midCeiling) {
      next.status = next.attempts.length > 0 ? 'stopped' : 'pending';
      state.status = 'stopped';
      state.error = `${midCeiling.message} ${remaining(state.milestones)} milestone(s) did not run.`;
      outcome = 'stopped';
      break;
    }

    const startedAt = deps.now();
    deps.ports.onEvent({ type: 'milestone:attempt', id: next.id, attempt });
    const prior = previousFeedback(next) ?? (attempt === 1 ? options.initialReport : undefined);
    const heldBefore = next.pendingReview ?? [];
    const heldNote = heldBefore.length > 0
      ? `Files with changes held for user review (NOT on disk): ${heldBefore.join(', ')}. Their pending content is not applied — work with what is actually on disk, and do not re-propose those same edits.`
      : '';
    const baseFeedback = prior ? deps.feedbackFor(next, prior, lastFailures(next), next.attempts.length) : '';
    const feedbackText = [baseFeedback, heldNote].filter(Boolean).join('\n\n') || undefined;
    const preTurnHashes =
      typeof deps.ports.readFile === 'function' && next.expectedFiles.length > 0
        ? await captureFileHashSnapshot(next.expectedFiles, deps.ports.readFile)
        : undefined;
    const turn = await deps.ports.runTurn({
      goal,
      milestone: next,
      feedback: prior,
      feedbackText,
      signal: deps.turnSignal?.()
    });
    next.touchedFiles = [...new Set([...(next.touchedFiles ?? []), ...(turn.touchedFiles ?? [])])];
    next.pendingReview = [...new Set([...(next.pendingReview ?? []), ...(turn.pendingReview ?? [])])];
    if (turn.pendingReview && turn.pendingReview.length > 0) {
      deps.ports.onEvent({ type: 'milestone:review', id: next.id, paths: turn.pendingReview });
    }
    const snapshotTargets = [...new Set([...next.expectedFiles, ...(turn.touchedFiles ?? [])])];
    const postTurnHashes =
      typeof deps.ports.readFile === 'function' && snapshotTargets.length > 0
        ? await captureFileHashSnapshot(snapshotTargets, deps.ports.readFile)
        : undefined;
    const report = await deps.ports.verify(next, {
      patchesApplied: turn.patchesApplied,
      changedFiles: turn.changedFiles,
      preExistingExpectedFiles,
      ...(preTurnHashes ? { preTurnHashes } : {}),
      ...(postTurnHashes ? { postTurnHashes } : {}),
      ...(turn.toolEvents ? { toolEvents: turn.toolEvents } : {})
    });
    const verdict = verdictOf(report);
    const attemptRecord: Attempt = {
      index: attempt,
      reply: turn.reply,
      patchesApplied: turn.patchesApplied,
      patchFailures: turn.patchFailures,
      verification: report,
      toolCalls: turn.toolCalls,
      failureProof: turn.failureProof ?? undefined,
      startedAt
    };
    next.attempts.push(attemptRecord);
    if (turn.patchesApplied > 0 || (turn.changedFiles ?? 0) > 0) shared.wrote = true;
    deps.ports.onEvent({ type: 'milestone:verdict', id: next.id, verdict, report, attempt });
    deps.persist(state);

    if (turn.aborted) {
      const byUser = turn.stopped === true || userHalt(deps.ports) !== null;
      next.status = byUser ? 'stopped' : 'failed';
      outcome = byUser ? 'stopped' : 'failed';
      if (byUser) shared.endedByUser = userHalt(deps.ports) ?? 'cancelled';
      deps.ports.onEvent({
        type: 'log',
        text: `"${next.title}" ${byUser ? 'was stopped mid-turn' : 'was interrupted mid-turn'}.`
      });
      break;
    }

    if (verdict === 'passed') {
      next.status = 'passed';
      outcome = 'passed';
      if (report.notes.length > 0) {
        deps.ports.onEvent({
          type: 'log',
          text: `"${next.title}" passed (${report.notes.join('; ')}).`
        });
      }
      break;
    }

    if (verdict === 'unverified') {
      next.status = 'unverified';
      shared.unverified.push(`${next.title}: ${report.notes.join('; ') || 'no checker could run'}`);
      outcome = 'unverified';
      deps.ports.onEvent({
        type: 'log',
        text: `"${next.title}" was not verified (${report.notes.join('; ') || 'no checker could run'}).`
      });
      break;
    }

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

    if (attempt >= maxAttempts) {
      next.status = 'failed';
      outcome = 'failed';
      break;
    }

    deps.ports.onEvent({
      type: 'log',
      text: `"${next.title}" failed check ${attempt}/${maxAttempts}.`
    });
  }

  if (outcome !== 'stopped') {
    deps.ports.onEvent({ type: 'milestone:done', id: next.id, status: next.status });
  }
  deps.persist(state);
  return outcome;
}

function uniqueDerivedId(prefix: string, milestones: readonly Milestone[]): string {
  const existing = new Set(milestones.map((m) => m.id));
  if (!existing.has(prefix)) return prefix;
  let suffix = milestones.length + 1;
  while (existing.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
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
  const caseInsensitive = isCaseInsensitivePlatform() || /^[a-z]:/i.test(files[0] ?? '');
  const resuming = Boolean(resumeFrom && resumeFrom.milestones.length > 0);
  const initialRequirements =
    resuming && resumeFrom?.requirements && resumeFrom.requirements.length > 0
      ? structuredClone(resumeFrom.requirements)
      : extractRequirements(goal);

  const state: RunState = resuming
    ? {
        ...structuredClone(resumeFrom as RunState),
        status: 'running',
        error: undefined,
        rolledBack: undefined,
        checkpointId: undefined,
        requirements: initialRequirements,
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
        startedAt: deps.now(),
        requirements: initialRequirements
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

  const shared: ExecutionShared = {
    goal,
    deps,
    state,
    caseInsensitive,
    clockStart: deps.now(),
    unverified: [],
    checkpointId: null,
    checkpointed: false,
    wrote: false,
    endedByUser: null
  };

  while (userHalt(deps.ports) === null) {
    const next = deps.nextRunnable(state.milestones);
    if (!next) break;

    const ceiling = workStop(deps, state.milestones, deps.now() - shared.clockStart);
    if (ceiling) {
      state.status = 'stopped';
      state.error = `${ceiling.message} ${remaining(state.milestones)} milestone(s) did not run.`;
      break;
    }

    const outcome = await executeMilestoneUnit(next, shared);
    if (outcome === 'stopped') break;
  }

  // Requirement coverage audit + bounded catch-up pass for multi-part mega-prompts.
  state.requirements = auditRequirementCoverage(
    state.requirements ?? extractRequirements(goal),
    state.milestones,
    state.milestones.flatMap((m) => m.touchedFiles ?? []),
    caseInsensitive
  );

  if (
    state.status === 'running' &&
    userHalt(deps.ports) === null &&
    shared.endedByUser === null &&
    state.requirements.length > 1 &&
    state.milestones.every((m) => m.status !== 'failed' && m.status !== 'blocked')
  ) {
    const pendingReqs = state.requirements.filter((req) => req.status === 'pending');
    if (
      pendingReqs.length > 0 &&
      !workStop(deps, state.milestones, deps.now() - shared.clockStart)
    ) {
      const catchupTargets = dedupePaths(
        pendingReqs.flatMap((req) => req.explicitPaths),
        caseInsensitive
      );
      const catchup: Milestone = {
        id: uniqueDerivedId('m-catchup', state.milestones),
        title: `Cover remaining requirement(s): ${pendingReqs.map((r) => r.id).join(', ')}`,
        instruction: [
          'Complete and verify all remaining prompt requirements listed below that were not yet evidenced by touched files:',
          ...pendingReqs.map((r) => `- [${r.id}] ${r.text}${r.evidence ? ` (${r.evidence})` : ''}`)
        ].join('\n'),
        expectedFiles: catchupTargets,
        dependsOn: [],
        status: 'pending',
        attempts: []
      };
      deps.ports.onEvent({
        type: 'log',
        text: `Requirement coverage audit found ${pendingReqs.length} pending requirement(s); running targeted catch-up.`
      });
      state.milestones.push(catchup);
      await executeMilestoneUnit(catchup, shared, {
        maxAttempts: Math.min(2, deps.budget.maxAttemptsPerMilestone)
      });
      state.requirements = auditRequirementCoverage(
        state.requirements,
        state.milestones,
        state.milestones.flatMap((m) => m.touchedFiles ?? []),
        caseInsensitive
      );
    }
  }

  // Workspace-wide verification gate: catches cross-file breakage outside milestone lists.
  if (
    state.status === 'running' &&
    userHalt(deps.ports) === null &&
    shared.endedByUser === null &&
    typeof deps.ports.verifyWorkspace === 'function' &&
    state.milestones.every((m) => m.status !== 'failed' && m.status !== 'blocked')
  ) {
    let wsReport = await deps.ports.verifyWorkspace();
    if (wsReport.verdict === 'failed') {
      const errorFiles = dedupePaths(
        wsReport.diagnostics.filter((d) => d.severity === 'error').map((d) => d.path),
        caseInsensitive
      );
      if (!workStop(deps, state.milestones, deps.now() - shared.clockStart)) {
        const repairMilestone: Milestone = {
          id: uniqueDerivedId('m-ws-repair', state.milestones),
          title: 'Repair workspace-wide verification errors',
          instruction: [
            'Final workspace-wide verification detected errors outside individual milestones.',
            'Fix every diagnostic listed below without regressing completed work:',
            ...wsReport.diagnostics
              .filter((d) => d.severity === 'error')
              .slice(0, 12)
              .map((d) => `- ${d.path}:${d.line}:${d.column} ${d.message}`)
          ].join('\n'),
          expectedFiles: errorFiles,
          dependsOn: [],
          status: 'pending',
          attempts: []
        };
        deps.ports.onEvent({
          type: 'log',
          text: `Workspace verification found error(s); running repair pass across ${errorFiles.join(', ') || 'affected files'}.`
        });
        state.milestones.push(repairMilestone);
        await executeMilestoneUnit(repairMilestone, shared, {
          maxAttempts: Math.min(2, deps.budget.maxAttemptsPerMilestone),
          initialReport: wsReport
        });
        wsReport = await deps.ports.verifyWorkspace();
      }
      if (wsReport.verdict === 'failed' && state.status === 'running') {
        state.status = 'failed';
        state.error = wsReport.notes[0] ?? 'Workspace-wide verification failed after milestone completion.';
        deps.ports.onEvent({ type: 'log', text: state.error });
      }
    }
  }

  const halt = userHalt(deps.ports) ?? shared.endedByUser;
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
    const unproven = state.milestones.filter((m) => m.status === 'unverified' && m.expectedFiles.length > 0);
    state.status = unresolved.length > 0 ? 'failed' : 'done';
    if (unresolved.length > 0) {
      state.error = `${unresolved.length} of ${state.milestones.length} milestones did not complete.`;
    } else if (unproven.length > 0) {
      state.error = `${unproven.length} of ${state.milestones.length} milestones finished unverified — nothing checked them, so they are not claimed as passed.${shared.unverified.length > 0 ? ` (${shared.unverified.join('; ')}).` : ''}`;
    } else if (state.requirements.length > 1) {
      const stillPending = state.requirements.filter((r) => r.status === 'pending');
      if (stillPending.length > 0) {
        state.error = `${stillPending.length} of ${state.requirements.length} prompt requirement(s) lack completion evidence (${stillPending.map((r) => r.id).join(', ')}).`;
      }
    }
  }

  // Final requirement audit across settled milestones (captures catch-up/repair touches too).
  state.requirements = auditRequirementCoverage(
    state.requirements,
    state.milestones,
    state.milestones.flatMap((m) => m.touchedFiles ?? []),
    caseInsensitive
  );

  // An unrecoverable failure must not leave a half-applied workspace behind.
  // Only runs that actually wrote, and only the failure state (not a user stop),
  // are rolled back; restoring the checkpoint is the transactional-safe outcome.
  if (state.status === 'failed' && shared.wrote && shared.checkpointId && deps.rollback) {
    try {
      state.rolledBack = await deps.rollback(shared.checkpointId);
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
