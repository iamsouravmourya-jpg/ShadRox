/**
 * Multi-agent teams: the vocabulary.
 *
 * A team is one coordinator that splits a goal into tasks, plus four specialists
 * that carry them out. It is not a second engine: every task's turn goes through
 * the same `AutonomyPorts` the solo run uses, so an agent team cannot edit a file
 * or run a command that the user could not have done by hand.
 *
 * The rule from `autonomy/types.ts` carries over unchanged: a task is only called
 * done when something checked it, and `unverified` is a verdict this module keeps
 * rather than smooths into a pass.
 */

import type {
  AutonomyPorts,
  PlanError,
  TurnResult,
  Verdict,
  VerificationReport
} from '../autonomy/types';

/** Who can be asked to do work. `coordinator` plans; it never carries a task. */
export type AgentRole = 'coordinator' | 'frontend' | 'backend' | 'tests' | 'reviewer';

/** Live state of one agent, derived from its tasks rather than stored twice. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed';

/**
 * `unverified` and `stopped` are statuses, not annotations: a task that changed
 * files without anything checking them must not read as `passed`, and a task the
 * user interrupted must not read as a failure of the work.
 */
export type TaskStatus = 'pending' | 'running' | 'passed' | 'unverified' | 'failed' | 'blocked' | 'stopped';

export interface AgentSpec {
  id: AgentRole;
  name: string;
  /** One line for the team view. */
  blurb: string;
  /** The standing instruction prefixed to every task this agent runs. */
  brief: string;
}

export interface TeamTask {
  id: string;
  /** One imperative sentence, shown in the task list as-is. */
  title: string;
  /** The instruction handed to the assigned agent. */
  instruction: string;
  /**
   * Repo-relative paths this task is allowed to touch. Empty means the task only
   * investigates and reports; it is then expected to change nothing.
   */
  expectedFiles: string[];
  /** Task ids that must pass first. A cycle makes the whole plan invalid. */
  dependsOn: string[];
  assignee: AgentRole;
  /** Optional proof command. Runs only through the app's approval gate. */
  verifyCommand?: string;
  status: TaskStatus;
  /** How many turns have been spent on this task. */
  attempts: number;
  /** The most recent check, which is what the task is currently known by. */
  lastReport: VerificationReport | null;
  /** The agent's own last reply, trimmed for the view. */
  report: string;
  patchesApplied: number;
  /** Paths the engine refused, with the reason already in the string. */
  patchFailures: string[];
  creditsSpent: number;
  /** Files this task actually changed. Reaches later tasks through the shared context. */
  touchedFiles?: string[];
  /** Files the apply policy held back for the user rather than writing. */
  pendingReview?: string[];
  /** Files this task opened with a tool, so a later task knows what is already known. */
  filesRead?: string[];
  /** The one line the next agents read instead of the raw reply. */
  summary?: string;
}

export interface TeamMessage {
  from: AgentRole;
  /** `'team'` when a finding is shared with everyone rather than one agent. */
  to: AgentRole | 'team';
  kind: 'handoff' | 'finding' | 'blocked';
  text: string;
  at: number;
}

export interface TeamBudget {
  /** Hard ceiling for one team run, in the same credits the meter bills. */
  maxCredits: number;
  /** Members the coordinator may create before the plan is rejected. */
  maxTasks: number;
  maxAttemptsPerTask: number;
}

/**
 * A team is several agents, so it is allowed more room than a single run — but
 * still a small, fixed amount: four tasks of a couple of attempts each is the
 * shape this number was chosen for, not an open tab.
 */
export const DEFAULT_TEAM_BUDGET: TeamBudget = {
  maxCredits: 24,
  maxTasks: 6,
  maxAttemptsPerTask: 2
};

export type TeamStatus = 'planning' | 'running' | 'done' | 'failed' | 'cancelled' | 'stopped-budget';

export interface TeamState {
  id: string;
  goal: string;
  status: TeamStatus;
  tasks: TeamTask[];
  messages: TeamMessage[];
  creditsSpent: number;
  startedAt: number;
  /** Shown verbatim in the panel; the reason a team is not working. */
  error?: string;
  /**
   * The budget this run was started under, persisted so a resumed team keeps the
   * same ceiling instead of silently getting a fresh one.
   */
  budget?: TeamBudget;
  /** Two tasks claiming one file, in the words the card shows. */
  conflicts?: string[];
  /** True once the pre-write checkpoint was taken, so a resume does not take a second one. */
  checkpointed?: boolean;
}

export type TeamEvent =
  | { type: 'team:planned'; tasks: TeamTask[] }
  | { type: 'task:start'; id: string; assignee: AgentRole }
  | { type: 'task:attempt'; id: string; attempt: number }
  | { type: 'task:verdict'; id: string; verdict: Verdict; report: VerificationReport }
  | { type: 'task:done'; id: string; status: TaskStatus }
  /** Changes the apply policy refused to write without the user: they await review. */
  | { type: 'task:review'; id: string; paths: string[] }
  | { type: 'message'; message: TeamMessage }
  | { type: 'credit'; spent: number; total: number }
  | { type: 'team:log'; text: string }
  | { type: 'team:done'; status: TeamStatus };

/**
 * A team needs everything an autonomous run needs except the planner (its plan
 * is built by the coordinator through `createTeamPlan`) — and it emits team
 * events instead of run events.
 */
export type TeamPorts = Omit<AutonomyPorts, 'askPlan' | 'onEvent'> & {
  onEvent: (event: TeamEvent) => void;
};

/** The coordinator's answer: tasks plus every reason they must not run. */
export interface TeamPlan {
  tasks: TeamTask[];
  errors: PlanError[];
}

/** Re-exported so a consumer of the team module needs one types import, not two. */
export type { TurnResult, Verdict, VerificationReport, PlanError };
