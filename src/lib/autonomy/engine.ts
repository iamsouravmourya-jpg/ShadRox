/**
 * The seam the app drives.
 *
 * `run-loop.ts` is the engine; this file supplies the concrete `DriverDeps` it
 * asks for by composing the planner, the DAG scheduler, the repair brief and
 * the budget — and nothing else. The behavioural ports (how a
 * turn calls the model, how a change is verified, how files are listed, how the
 * run is cancelled) arrive from the caller, so this factory stays free of the
 * app's chat, file and terminal machinery and remains testable with fakes.
 */

import { findBlocked, nextRunnable } from './dag';
import { buildRepairBrief } from './feedback';
import { createPlanGoal, validatePlan } from './plan';
import { runAutonomous, type DriverDeps } from './run-loop';
import { DEFAULT_RUN_BUDGET, type AutonomyPorts, type RunBudget, type RunState } from './types';

export interface AutonomyEngineOptions {
  /** The app's behavioural ports: turn, verify, files, events, cancellation. */
  ports: AutonomyPorts;
  /** One model call that returns the raw plan text. */
  askPlan: (prompt: string) => Promise<string>;
  /** Snapshot the workspace once, before the first write, for rollback. */
  checkpoint: (goal: string) => Promise<string | null> | string | null;
  /** Restore that snapshot when a run fails unrecoverably. */
  rollback?: (checkpointId: string) => Promise<boolean> | boolean;
  /** Persist run state after every verdict so a crash loses nothing. */
  persist: (state: RunState) => void;
  budget?: RunBudget;
  /** Continue a persisted run instead of planning a new one. */
  resumeFrom?: RunState;
  /** Plan and validate, then stop without writing. */
  dryRun?: boolean;
  now?: () => number;
  /** The Stop/Pause signal handed to each turn so an in-flight request can end. */
  turnSignal?: () => AbortSignal | undefined;
}

/** Compose the engine's driver dependencies from the app-provided pieces. */
export function createDriverDeps(options: AutonomyEngineOptions): DriverDeps {
  return {
    ports: options.ports,
    budget: options.budget ?? DEFAULT_RUN_BUDGET,
    planGoal: createPlanGoal(options.askPlan),
    validate: validatePlan,
    nextRunnable,
    findBlocked,
    feedbackFor: buildRepairBrief,
    checkpoint: options.checkpoint,
    rollback: options.rollback,
    persist: options.persist,
    now: options.now ?? Date.now,
    dryRun: options.dryRun,
    turnSignal: options.turnSignal
  };
}

/** Run a goal to completion (or to budget/stop) and return the final state. */
export function runGoal(goal: string, options: AutonomyEngineOptions): Promise<RunState> {
  return runAutonomous(goal, createDriverDeps(options), options.resumeFrom);
}
