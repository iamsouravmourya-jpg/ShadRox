/**
 * The React face of a team run: the panel's `start`/`stop` and the live state.
 *
 * It is the counterpart to `useAutonomyRun`, and deliberately smaller: a team is
 * one shot at a goal, not something that resumes across reloads, so there is no
 * store and no controller to restore. Everything else is the same wiring — the
 * app's single `AutonomyHost` reaches the team through `createTeamPorts`, so a
 * team task is run and checked by the same code a solo run uses.
 */

import { useCallback, useRef, useState } from 'react';
import { createCreditTracker } from '../lib/autonomy/budget';
import { MAX_LOG_LINES } from '../lib/autonomy/events';
import type { AutonomyHost } from '../lib/autonomy/ports';
import { describeTeamEvent } from '../lib/agents/events';
import { createTeamPlan, validateTeamPlan } from '../lib/agents/plan';
import { createTeamPorts } from '../lib/agents/ports';
import { runTeam } from '../lib/agents/team-run';
import { DEFAULT_TEAM_BUDGET, type TeamBudget, type TeamEvent, type TeamState } from '../lib/agents/types';

export interface UseTeamRunOptions {
  /** The app's real capabilities, wrapped by `ports`. */
  host: AutonomyHost;
  /** Workspace root; a team cannot run without one. */
  rootPath: string | null;
  /** Snapshot the workspace once, before the first write, for rollback. */
  onCheckpoint: (goal: string) => Promise<void> | void;
  budget?: TeamBudget;
  /** Every event, for callers that want to toast or track beyond the log. */
  onEvent?: (event: TeamEvent) => void;
}

export interface TeamRun {
  state: TeamState | null;
  log: string[];
  isRunning: boolean;
  start: (goal: string) => void;
  stop: () => void;
  /** Forgets the last run. */
  dismiss: () => void;
}

export function useTeamRun(options: UseTeamRunOptions): TeamRun {
  const [state, setState] = useState<TeamState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  // Live refs so an in-flight run always reads the current host and budget
  // without the callbacks being rebuilt on every render.
  const hostRef = useRef(options.host);
  const rootRef = useRef(options.rootPath);
  const checkpointRef = useRef(options.onCheckpoint);
  const eventRef = useRef(options.onEvent);
  const budgetRef = useRef(options.budget ?? DEFAULT_TEAM_BUDGET);
  hostRef.current = options.host;
  rootRef.current = options.rootPath;
  checkpointRef.current = options.onCheckpoint;
  eventRef.current = options.onEvent;
  budgetRef.current = options.budget ?? DEFAULT_TEAM_BUDGET;

  const busy = useRef(false);
  const cancelled = useRef(false);

  const start = useCallback((goal: string) => {
    const trimmed = goal.trim();
    const root = rootRef.current;
    if (!trimmed || !root || busy.current) return;

    busy.current = true;
    cancelled.current = false;
    setLog([]);
    setRunning(true);

    const budget = budgetRef.current;
    const ports = createTeamPorts(hostRef.current, {
      rootPath: root,
      onEvent: (event) => {
        eventRef.current?.(event);
        const line = describeTeamEvent(event);
        if (line) setLog((previous) => [...previous, line].slice(-MAX_LOG_LINES));
      },
      isCancellationRequested: () => cancelled.current
    });

    void runTeam(trimmed, {
      ports,
      budget,
      planTeam: createTeamPlan((prompt) => hostRef.current.askPlan(prompt)),
      validate: validateTeamPlan,
      tracker: createCreditTracker({ maxCredits: budget.maxCredits }),
      checkpoint: (goalText) => checkpointRef.current(goalText),
      // Snapshotted after every verdict so the panel always shows the live plan.
      persist: (live) => setState(structuredClone(live)),
      now: () => Date.now()
    }).finally(() => {
      busy.current = false;
      setRunning(false);
    });
  }, []);

  const stop = useCallback(() => {
    cancelled.current = true;
  }, []);

  const dismiss = useCallback(() => {
    setState(null);
    setLog([]);
  }, []);

  return { state, log, isRunning: running, start, stop, dismiss };
}
