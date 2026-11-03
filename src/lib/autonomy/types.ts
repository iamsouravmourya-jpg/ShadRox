/**
 * Autonomous run: the vocabulary every module in this directory agrees on.
 *
 * This file is deliberately the only thing with no dependencies — the planner,
 * the verifier, the budget and the panel are all written against it, so they can
 * be built in parallel without agreeing on anything else.
 *
 * The rule that shapes the whole design: a run may only claim a milestone is
 * done when something actually checked it. The previous engine in `autonomous/`
 * hardcoded `{ valid: true }` into its own verdict and shipped a machine that
 * wrecked files while believing it had verified them. `unverified` therefore
 * exists as a verdict and is never rewritten into `passed` — a milestone may
 * still advance the plan on an unverified check, but the verdict, the panel and
 * the run summary all keep saying it was not proven.
 */

export type Verdict = 'passed' | 'failed' | 'unverified';

/**
 * `unverified` is a *status*, not just a verdict: a unit that advanced the plan
 * without anything proving it must stay visibly unverified in the checklist, in
 * the summary and in a resumed run. `stopped` means the user ended it mid-turn —
 * which is not a failure of the work, and must not be reported as one.
 */
export type MilestoneStatus = 'pending' | 'running' | 'passed' | 'unverified' | 'failed' | 'blocked' | 'stopped';

/**
 * How a turn's file changes reach the workspace.
 * `review` sends every change to the review card, like a chat reply does.
 * `auto` writes only the changes that cannot lose the user's work: a brand-new
 * file, or an edit to a file the turn actually read and did not gut.
 */
export type ApplyPolicyKind = 'review' | 'auto';

/**
 * `auto` is the default because a run that needs a click per file is not a run —
 * but the rule it applies is the conservative one, so a deletion or an overwrite
 * of a file the turn never opened still waits for the user.
 */
export const DEFAULT_APPLY_POLICY: ApplyPolicyKind = 'auto';

export type RunStatus =
  | 'planning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'stopped-budget'
  | 'cancelled'
  | 'failed';

export interface DiagnosticLine {
  /** Repo-relative path, exactly as the workspace reports it. */
  path: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface CommandOutcome {
  /** The single argv the approval gate was shown before running. */
  argv: string;
  exitCode: number | null;
  /** Truncated by whoever ran it — the report is shown to a human, not parsed. */
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  /** Set instead of running: the user declined, or no terminal is available. */
  declinedReason?: string;
}

export interface VerificationReport {
  verdict: Verdict;
  diagnostics: DiagnosticLine[];
  command?: CommandOutcome;
  /**
   * Every reason this verdict might not mean what it appears to — a skipped
   * command, a workspace with no type checker, a milestone that touched nothing.
   * A `passed` with notes is still shown with the notes.
   */
  notes: string[];
}

export interface Milestone {
  id: string;
  /** One imperative sentence, shown in the checklist as-is. */
  title: string;
  /** The instruction handed to the model for this milestone. */
  instruction: string;
  /**
   * Repo-relative paths this milestone is allowed to touch. This is confinement,
   * not a hint: a patch outside it is reported, not applied silently.
   */
  expectedFiles: string[];
  /** Milestone ids that must pass first. A cycle makes the whole plan invalid. */
  dependsOn: string[];
  /** Optional proof command. Runs only through the app's approval gate. */
  verifyCommand?: string;
  status: MilestoneStatus;
  attempts: Attempt[];
  /** Files the turn actually changed, newest first as the turn emitted them. */
  touchedFiles?: string[];
  /** Files held back for the user to accept; they were deliberately not written. */
  pendingReview?: string[];
}

export interface Attempt {
  /** 1-based, so the panel can say "attempt 2 of 3" without arithmetic. */
  index: number;
  reply: string;
  patchesApplied: number;
  /** Paths the engine refused, with the reason already in the string. */
  patchFailures: string[];
  verification?: VerificationReport;
  creditsSpent: number;
  /** Wall clock, for the panel's elapsed column and for resume. */
  startedAt: number;
}

export interface PlanError {
  /** The milestone at fault, or null for a whole-plan problem. */
  milestoneId: string | null;
  reason:
    | 'empty'
    | 'too-many'
    | 'duplicate-id'
    | 'blank-field'
    | 'unknown-dependency'
    | 'unknown-assignee'
    | 'cycle'
    | 'bad-path'
    | 'unparseable';
  /** Written for a human: the panel shows it verbatim. */
  message: string;
}

export interface RunBudget {
  /**
   * Hard ceiling for one run, in the same credits the meter bills. The operator
   * owns this number; the loop stops at it rather than asking mid-flight.
   */
  maxCredits: number;
  maxAttemptsPerMilestone: number;
  maxMilestones: number;
}

/**
 * 20 credits is a quarter of a Starter month (800) and roughly 20 applied edits;
 * 3 attempts is what the salvageable repair loop used, and it is the reason that
 * loop could not burn a key forever.
 */
export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxCredits: 20,
  maxAttemptsPerMilestone: 3,
  maxMilestones: 8
};

export interface RunState {
  id: string;
  goal: string;
  status: RunStatus;
  milestones: Milestone[];
  creditsSpent: number;
  startedAt: number;
  /** Shown verbatim in the panel; the reason a run is not running. */
  error?: string;
  /** The pre-run checkpoint, kept so an unrecoverable failure can be undone. */
  checkpointId?: string | null;
  /** True when a failed run restored the workspace to that checkpoint. */
  rolledBack?: boolean;
}

/**
 * The slice of a milestone a turn actually needs. A team task carries the same
 * fields, so the run-loop and the multi-agent team drive one turn contract
 * instead of each inventing its own copy of it.
 */
export interface TurnUnit extends VerifiableUnit {
  title: string;
  instruction: string;
}

/** The slice a verifier needs: which unit, what to check, and how. */
export interface VerifiableUnit {
  id: string;
  expectedFiles: string[];
  verifyCommand?: string;
}

/** One turn of the model, told through the app's real chat path. */
export interface TurnRequest {
  goal: string;
  milestone: TurnUnit;
  /** What the previous attempt got wrong, in the report's own words. */
  feedback?: VerificationReport;
  /**
   * The rendered repair brief from `feedback.ts`, sent instead of re-deriving it
   * at the call site — the app's chat path takes one instruction string, so the
   * loop hands it the text the verifier already composed.
   */
  feedbackText?: string;
  /**
   * Ends the in-flight model call when the user hits Stop. Without it, Stop is
   * only noticed between units, so a teammate's paid turn keeps streaming after
   * the user asked for it to end.
   */
  signal?: AbortSignal;
  /** Defaults to `DEFAULT_APPLY_POLICY`; the caller may tighten it per run. */
  applyPolicy?: ApplyPolicyKind;
}

export interface TurnResult {
  reply: string;
  patchesApplied: number;
  patchFailures: string[];
  creditsSpent: number;
  /** The user hit Stop, or the model call died. The loop does not retry either. */
  aborted: boolean;
  /**
   * True only when `aborted` was caused by the Stop button. A failed provider
   * call and a user's decision are different outcomes and must not share a
   * status: one is a failure to report, the other is a stop to honour.
   */
  stopped?: boolean;
  /** Files the turn read with a tool. Feeds the shared context of later units. */
  filesRead?: string[];
  /** Files the turn changed. */
  touchedFiles?: string[];
  /** Files the apply policy held back for the user instead of writing. */
  pendingReview?: string[];
  /** Set when a stop landed before any change was extracted: nothing was written. */
  wroteNothing?: boolean;
}

/**
 * Everything the loop needs from the app, injected so the loop is testable with
 * fakes and so no module in here can invent its own exec or file-write path.
 */
export interface AutonomyPorts {
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  verify: (unit: VerifiableUnit) => Promise<VerificationReport>;
  /** Repo-relative paths that exist right now, for plan validation and confinement. */
  listFiles: () => string[];
  /** Ask the model for the plan; returns its raw text answer. */
  askPlan: (prompt: string) => Promise<string>;
  onEvent: (event: AutonomyEvent) => void;
  /**
   * Set by the panel's Stop button. Checked between units, and also mirrored
   * into `TurnRequest.signal` so Stop ends the request that is in flight rather
   * than paying for the rest of it.
   */
  isCancellationRequested: () => boolean;
}

export type AutonomyEvent =
  | { type: 'plan:created'; milestones: Milestone[] }
  | { type: 'milestone:start'; id: string }
  | { type: 'milestone:attempt'; id: string; attempt: number }
  | { type: 'milestone:verdict'; id: string; verdict: Verdict; report: VerificationReport }
  | { type: 'milestone:done'; id: string; status: MilestoneStatus }
  /** Changes the apply policy refused to write without the user. */
  | { type: 'milestone:review'; id: string; paths: string[] }
  | { type: 'credit'; spent: number; total: number }
  | { type: 'log'; text: string }
  | { type: 'run:done'; status: RunStatus };
