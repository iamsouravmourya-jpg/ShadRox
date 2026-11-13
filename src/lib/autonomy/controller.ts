/**
 * The run controller: the small stateful holder the UI drives.
 *
 * The run-loop is a pure function and the panel is React state; something has to
 * own the current run, the Stop flag and the listener list between them. That is
 * all this is. It does not know how a run executes — `execute` arrives injected,
 * so the controller is testable with a fake and the app wires the real engine.
 */

import type { AutonomyEvent, RunState } from './types';

export type RunStateListener = (state: RunState | null, event?: AutonomyEvent) => void;

export interface RunExecutorHelpers {
  /** True once the user has hit Stop; the run-loop checks this between milestones. */
  isCancellationRequested: () => boolean;
  /**
   * True once the user has hit Pause. Kept apart from Stop on purpose: a paused
   * run is expected to continue, a stopped one is finished, and the panel says
   * different things about each.
   */
  isPauseRequested: () => boolean;
  /**
   * Aborted the moment the user Stops or Pauses, so the turn in flight ends
   * instead of finishing a paid request nobody asked for any more.
   */
  turnSignal: () => AbortSignal;
  /** Every event the run emits, forwarded to subscribers as it happens. */
  onEvent: (event: AutonomyEvent) => void;
}

export interface RunStartOptions {
  /** Plan and validate only; nothing is written. */
  dryRun?: boolean;
  /** Continue a persisted run instead of planning from the goal. */
  resumeFrom?: RunState;
}

export interface RunControllerOptions {
  execute: (goal: string, helpers: RunExecutorHelpers, options?: RunStartOptions) => Promise<RunState>;
  /** Called with the final state of every run, so the caller can persist it. */
  persist?: (state: RunState) => void;
  /** The last run for the active workspace, restored on construction. */
  restore?: () => RunState | null;
}

export interface RunController {
  /** Starts a run, or continues one when `resumeFrom` is given. Returns null if one is already in flight. */
  start: (goal: string, options?: RunStartOptions) => Promise<RunState | null>;
  /** Asks the in-flight run to end at the next milestone boundary. */
  stop: () => void;
  /**
   * Asks the in-flight run to pause at the next boundary and ends the turn that
   * is running. The state it leaves is resumable by `start(goal, { resumeFrom })`.
   */
  pause: () => void;
  getState: () => RunState | null;
  isRunning: () => boolean;
  /** Subscribe to state/event updates; returns an unsubscribe function. */
  subscribe: (listener: RunStateListener) => () => void;
}

export function createRunController(options: RunControllerOptions): RunController {
  let state: RunState | null = options.restore?.() ?? null;
  let running = false;
  let cancelled = false;
  let paused = false;
  let turnAbort: AbortController | null = null;
  const listeners = new Set<RunStateListener>();

  const notify = (event?: AutonomyEvent): void => {
    for (const listener of listeners) listener(state, event);
  };

  const endTheTurnInFlight = (): void => {
    turnAbort?.abort();
  };

  return {
    async start(goal: string, startOptions?: RunStartOptions): Promise<RunState | null> {
      if (running) return null;
      running = true;
      cancelled = false;
      paused = false;
      const abort = new AbortController();
      turnAbort = abort;
      try {
        const final = await options.execute(goal, {
          isCancellationRequested: () => cancelled,
          isPauseRequested: () => paused,
          turnSignal: () => abort.signal,
          onEvent: (event) => {
            notify(event);
          }
        }, startOptions);
        state = final;
        options.persist?.(final);
        notify();
        return final;
      } finally {
        turnAbort = null;
        running = false;
      }
    },
    stop(): void {
      cancelled = true;
      // Stop means the same thing to the loop and to the request in flight, but
      // only the second one is still costing the user.
      endTheTurnInFlight();
    },
    pause(): void {
      paused = true;
      endTheTurnInFlight();
    },
    getState: () => state,
    isRunning: () => running,
    subscribe(listener: RunStateListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
