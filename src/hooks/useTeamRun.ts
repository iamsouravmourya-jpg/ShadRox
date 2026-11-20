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
import { MAX_LOG_LINES } from '../lib/autonomy/events';
import type { AutonomyHost } from '../lib/autonomy/ports';
import {
  extractErrorMessage,
  isRateLimitError,
  rateLimitPacingDelayMs,
  withCoordinatorBackoff
} from '../lib/agents/coordinatorResilience';
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
  /** Active BYOK provider id and free-tier hint for rate-limit pacing. */
  provider?: string;
  isFreeTier?: boolean;
}

export interface TeamRun {
  state: TeamState | null;
  log: string[];
  isRunning: boolean;
  start: (goal: string) => void;
  stop: () => void;
  /**
   * Halts the in-flight team at the next task boundary and ends the turn in
   * flight. The run is not resumed — a team plans once — but it leaves an
   * honest `paused` state instead of a `running` one nobody is driving.
   */
  pause: () => void;
  /** Forgets the last run. */
  dismiss: () => void;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

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
  const providerRef = useRef(options.provider);
  const freeTierRef = useRef(options.isFreeTier);
  hostRef.current = options.host;
  rootRef.current = options.rootPath;
  checkpointRef.current = options.onCheckpoint;
  eventRef.current = options.onEvent;
  budgetRef.current = options.budget ?? DEFAULT_TEAM_BUDGET;
  providerRef.current = options.provider;
  freeTierRef.current = options.isFreeTier;

  const busy = useRef(false);
  const cancelled = useRef(false);
  const paused = useRef(false);
  /** The turn in flight, so Stop/Pause can end it rather than only the next one. */
  const turnAbort = useRef<AbortController | null>(null);

  const appendLog = useCallback((text: string) => {
    setLog((previous) => [...previous, text].slice(-MAX_LOG_LINES));
  }, []);

  const start = useCallback((goal: string) => {
    const trimmed = goal.trim();
    const root = rootRef.current;
    if (!trimmed || !root || busy.current) return;

    busy.current = true;
    cancelled.current = false;
    paused.current = false;
    const abort = new AbortController();
    turnAbort.current = abort;
    setLog([]);
    setRunning(true);

    const budget = budgetRef.current;
    const ports = createTeamPorts(hostRef.current, {
      rootPath: root,
      onEvent: (event) => {
        eventRef.current?.(event);
        const line = describeTeamEvent(event);
        if (line) appendLog(line);
      },
      isCancellationRequested: () => cancelled.current,
      isPauseRequested: () => paused.current
    });

    let recentRateLimit = false;
    let turnsStarted = 0;

    void (async () => {
      const startedAt = Date.now();
      let latestState: TeamState | null = null;
      try {
        const workspaceManifest = (await hostRef.current.getWorkspaceManifest?.()) ?? undefined;

        const resilientAskPlan = (prompt: string) =>
          withCoordinatorBackoff(
            () => hostRef.current.askPlan(prompt),
            {
              signal: abort.signal,
              onRetry: ({ attempt, delayMs, reason }) => {
                if (isRateLimitError(reason)) recentRateLimit = true;
                appendLog(`Coordinator retry ${attempt} in ${(delayMs / 1000).toFixed(1)}s (${reason.slice(0, 120)})`);
              }
            }
          );

        const finalState = await runTeam(trimmed, {
          ports,
          budget,
          workspaceManifest,
          planTeam: createTeamPlan(resilientAskPlan),
          validate: validateTeamPlan,
          checkpoint: (goalText) => checkpointRef.current(goalText),
          persist: (live) => {
            const snapshot = structuredClone(live);
            latestState = snapshot;
            setState(snapshot);
          },
          beforeTurn: async ({ phase }) => {
            if (phase === 'plan') return;
            turnsStarted += 1;
            if (turnsStarted === 1) return;
            const delayMs = rateLimitPacingDelayMs({
              isFreeTier: freeTierRef.current,
              recentRateLimit,
              provider: providerRef.current
            });
            if (delayMs > 0) {
              appendLog(`Rate-limit pacing: waiting ${(delayMs / 1000).toFixed(1)}s before next turn`);
              await wait(delayMs, abort.signal);
            }
          },
          turnSignal: () => turnAbort.current?.signal,
          now: () => Date.now()
        });
        latestState = finalState;
      } catch (error) {
        const reason = extractErrorMessage(error);
        if (isRateLimitError(error)) recentRateLimit = true;
        appendLog(`Agent team failed: ${reason}`);
        setState((prev) => {
          const base = latestState ?? prev ?? {
            id: `team-${startedAt}`,
            goal: trimmed,
            status: 'failed' as const,
            tasks: [],
            messages: [],
            startedAt
          };
          const failedTasks = base.tasks.map((task) =>
            task.status === 'running' ? { ...task, status: 'failed' as const } : task
          );
          const passed = failedTasks.filter((task) => task.status === 'passed').length;
          return {
            ...base,
            tasks: failedTasks,
            status: 'failed',
            error: reason,
            summaryReport: base.summaryReport ?? {
              overview: `Agent team failed: ${reason}`,
              filesModified: [],
              tasksCompleted: passed,
              totalTasks: failedTasks.length,
              durationMs: Math.max(0, Date.now() - base.startedAt),
              openIssues: [reason]
            }
          };
        });
      } finally {
        busy.current = false;
        turnAbort.current = null;
        setRunning(false);
      }
    })();
  }, [appendLog]);

  const stop = useCallback(() => {
    cancelled.current = true;
    // Stop means the same thing to the driver and to the request in flight.
    turnAbort.current?.abort();
  }, []);

  const pause = useCallback(() => {
    paused.current = true;
    turnAbort.current?.abort();
  }, []);

  const dismiss = useCallback(() => {
    setState(null);
    setLog([]);
  }, []);

  return { state, log, isRunning: running, start, stop, pause, dismiss };
}
