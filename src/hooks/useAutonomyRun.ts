/**
 * The React face of a run: the panel's `start`/`stop` and the live state.
 *
 * It owns nothing the engine needs to know about — the controller, the ports
 * and the store are all pure modules underneath. This hook only connects them to
 * component state and keeps the log, so a re-render can never reach into a run
 * that is already in flight. The log itself comes from the journal, so what a
 * run said survives the reload that erased it from the panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRunController, type RunController } from '../lib/autonomy/controller';
import { runGoal } from '../lib/autonomy/engine';
import { MAX_LOG_LINES, describeEvent } from '../lib/autonomy/events';
import { browserRunJournal, type RunJournal } from '../lib/autonomy/journal';
import { createAutonomyPorts, type AutonomyHost } from '../lib/autonomy/ports';
import type { RunStore } from '../lib/autonomy/runStore';
import {
  DEFAULT_RUN_BUDGET,
  type AutonomyEvent,
  type RunBudget,
  type RunState
} from '../lib/autonomy/types';

export interface UseAutonomyRunOptions {
  /** The app's real capabilities, wrapped by `ports`. */
  host: AutonomyHost;
  /** Workspace root; a run is keyed to it and rebuilt when it changes. */
  rootPath: string | null;
  store: RunStore;
  /** Snapshot the workspace once, before the first write, for rollback. */
  onCheckpoint: (goal: string) => Promise<string | null> | string | null;
  /** Restore that snapshot when a run fails unrecoverably. */
  onRollback?: (checkpointId: string) => Promise<boolean> | boolean;
  budget?: RunBudget;
  /** Every event, for callers that want to toast or track beyond the log. */
  onEvent?: (event: AutonomyEvent) => void;
  /**
   * Where the run's lines are kept after a reload. Defaults to the workspace's
   * browser journal; a caller with no durable storage passes a forgetful one.
   */
  journal?: RunJournal;
}

export interface AutonomyRun {
  state: RunState | null;
  log: string[];
  isRunning: boolean;
  start: (goal: string, options?: { dryRun?: boolean }) => void;
  /** Continue the restored run from its persisted milestones. */
  resume: () => void;
  stop: () => void;
  /**
   * Halts the in-flight run at the next boundary and ends the turn it is paying
   * for. Unlike `stop`, the state it leaves is resumable.
   */
  pause: () => void;
  /** Forgets the last run (restored or finished) and its persisted copy. */
  dismiss: () => void;
}

export function useAutonomyRun(options: UseAutonomyRunOptions): AutonomyRun {
  const [state, setState] = useState<RunState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  // Live refs so the controller, created once per workspace, always reads the
  // current host, store and budget without being rebuilt on every render.
  const hostRef = useRef(options.host);
  const rootRef = useRef(options.rootPath);
  const storeRef = useRef(options.store);
  const checkpointRef = useRef(options.onCheckpoint);
  const rollbackRef = useRef(options.onRollback);
  const eventRef = useRef(options.onEvent);
  const budgetRef = useRef(options.budget ?? DEFAULT_RUN_BUDGET);
  hostRef.current = options.host;
  rootRef.current = options.rootPath;
  storeRef.current = options.store;
  checkpointRef.current = options.onCheckpoint;
  rollbackRef.current = options.onRollback;
  eventRef.current = options.onEvent;
  budgetRef.current = options.budget ?? DEFAULT_RUN_BUDGET;

  // One journal per workspace: two folders do not share one history.
  const journal = useMemo(
    () => options.journal ?? browserRunJournal(options.rootPath),
    [options.journal, options.rootPath]
  );
  /** The id the engine gave the run, so its lines stay its own across a resume. */
  const runIdRef = useRef<string | null>(null);

  const controller: RunController = useMemo(
    () =>
      createRunController({
        execute: async (goal, helpers, startOptions) => {
          const ports = createAutonomyPorts(hostRef.current, {
            rootPath: rootRef.current ?? '',
            onEvent: (event) => {
              helpers.onEvent(event);
              eventRef.current?.(event);
              const line = describeEvent(event);
              if (line) {
                journal.append(line, runIdRef.current ?? undefined);
                setLog((previous) => [...previous, line].slice(-MAX_LOG_LINES));
              }
            },
            isCancellationRequested: helpers.isCancellationRequested,
            isPauseRequested: helpers.isPauseRequested
          });

          return runGoal(goal, {
            ports,
            askPlan: (prompt) => hostRef.current.askPlan(prompt),
            checkpoint: (goalText) => checkpointRef.current(goalText),
            rollback: rollbackRef.current
              ? (checkpointId) => rollbackRef.current?.(checkpointId) ?? false
              : undefined,
            // Persist after every verdict, not just at the end, so a crash or a
            // reload loses at most the milestone in flight.
            persist: (live) => {
              runIdRef.current = live.id;
              setState(structuredClone(live));
              const root = rootRef.current;
              if (root) storeRef.current.save(root, live);
            },
            budget: budgetRef.current,
            resumeFrom: startOptions?.resumeFrom,
            dryRun: startOptions?.dryRun,
            turnSignal: helpers.turnSignal
          });
        },
        persist: (final) => {
          const root = rootRef.current;
          if (root) storeRef.current.save(root, final);
        },
        restore: () => {
          const root = rootRef.current;
          return root ? storeRef.current.load(root) : null;
        }
      }),
    // A new workspace means a new run; rebuilding is what makes restore correct.
    [options.rootPath, journal]
  );

  useEffect(() => {
    const restored = controller.getState();
    // A run restored after a reload brings its own journal with it: the lines
    // the panel lost are the ones the disk kept.
    runIdRef.current = restored?.id ?? null;
    setState(restored);
    setLog(restored ? journal.lines(restored.id).slice(-MAX_LOG_LINES) : []);
    setRunning(false);
  }, [controller, journal]);

  const start = useCallback(
    (goal: string, startOptions?: { dryRun?: boolean }) => {
      const trimmed = goal.trim();
      if (!trimmed || !rootRef.current || controller.isRunning()) return;
      // The engine's first persist sets this before any event is announced.
      runIdRef.current = null;
      setLog([]);
      setRunning(true);
      void controller.start(trimmed, startOptions).finally(() => setRunning(false));
    },
    [controller]
  );

  const resume = useCallback(() => {
    const current = controller.getState();
    if (!current || !rootRef.current || controller.isRunning()) return;
    // Continuing shows the run's own history rather than an empty log: the
    // lines the paused panel lost are the ones the journal kept.
    setLog(journal.lines(current.id).slice(-MAX_LOG_LINES));
    setRunning(true);
    void controller
      .start(current.goal, { resumeFrom: current })
      .finally(() => setRunning(false));
  }, [controller, journal]);

  const stop = useCallback(() => {
    controller.stop();
  }, [controller]);

  const pause = useCallback(() => {
    controller.pause();
  }, [controller]);

  const dismiss = useCallback(() => {
    const root = rootRef.current;
    if (root) storeRef.current.clear(root);
    setState(null);
    setLog([]);
  }, []);

  return { state, log, isRunning: running, start, resume, stop, pause, dismiss };
}
