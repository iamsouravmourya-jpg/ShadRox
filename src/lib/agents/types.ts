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
  DiagnosticLine,
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
  /** Hard ceiling for one team run, in the same spend units the run budget counts. */
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

/** ─── The closing integration turn ─────────────────────────────────────────
 *
 * When the last task settles, the team has changed files no single task owns:
 * Frontend renamed a prop Backend had already written against, and every task
 * passed its own check because each one only looked at its own files. One final
 * turn, run by the coordinator, reads the whole change set — the per-role files,
 * the ownership map and the diagnostics for all of them together — and says out
 * loud what the per-task verdicts could not.
 */

/** One role's contribution to the merge: which of its tasks wrote which files. */
export interface RoleChangedFiles {
  role: AgentRole;
  /** Task ids of that role which actually wrote something, in plan order. */
  taskIds: string[];
  /** Repo-relative, normalised, in first-write order. */
  files: string[];
}

/** Two roles writing one file. Never accepted silently, so it is always named. */
export interface MergeOverlap {
  file: string;
  /** Roles that wrote it, plan order, deduplicated. */
  roles: AgentRole[];
  /** Task ids that wrote it, plan order. */
  taskIds: string[];
  /** One sentence for the merge report and the timeline. */
  note: string;
}

/**
 * `clean` — nothing contradicts anything. `warned` — only warnings. `conflicts`
 * — two roles wrote one file, whatever the checker says. `broken` — an error
 * diagnostic survives the merge. `unverified` — nothing could check the merged
 * files, so the merge is not proven; like the task verdict, it is never smoothed
 * into a pass. A conflict is its own verdict: two agents overwriting each other
 * is a finding even when the last write type-checks.
 */
export type MergeVerdict = 'clean' | 'warned' | 'conflicts' | 'broken' | 'unverified';

export interface TeamMergeReport {
  /** The role that carried the closing turn. */
  role: AgentRole;
  verdict: MergeVerdict;
  /** False when the turn was skipped (cancel, or no credits left) but judged anyway. */
  ran: boolean;
  /** Union of every file the team changed, in first-write order. */
  files: string[];
  byRole: RoleChangedFiles[];
  overlaps: MergeOverlap[];
  /** Diagnostics for `files` after the merge turn, errors first. */
  diagnostics: DiagnosticLine[];
  errors: number;
  warnings: number;
  /** Files the apply policy still holds back, so the merge never claims them as landed. */
  awaitingReview: string[];
  /** Every reason behind the verdict, one line each, shown as-is. */
  notes: string[];
  /** The closing turn's own reply, trimmed for the view. */
  reply: string;
  creditsSpent: number;
  at: number;
}

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
  /** What the closing integration turn found, once it has run. */
  mergeReport?: TeamMergeReport;
  /** Structured executive summary report generated upon team run completion. */
  summaryReport?: {
    overview: string;
    filesModified: string[];
    tasksCompleted: number;
    totalTasks: number;
    testsPassed?: number;
    testsRun?: number;
    durationMs?: number;
    openIssues?: string[];
    /** The merge verdict, when a closing turn ran. Never smoothed to a pass. */
    mergeVerdict?: MergeVerdict;
    /** Files two roles wrote, one sentence each. */
    mergeConflicts?: string[];
  };
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
  /** The closing integration turn's structured merge report, before `team:done`. */
  | { type: 'team:integration'; report: TeamMergeReport }
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
export type { DiagnosticLine, TurnResult, Verdict, VerificationReport, PlanError };
