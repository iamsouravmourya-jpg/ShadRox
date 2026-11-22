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

// Type-only: erased at compile time, so this file still has no runtime dependencies.
import type { FailureReceipt } from '../repairProof';
import type { RequirementItem } from './requirements';

export type Verdict = 'passed' | 'failed' | 'unverified';

export type MilestoneCategory = 'read_only' | 'file_mutation' | 'command_execution' | 'checkpoint';

export interface ToolExecutionEvent {
  name: string;
  ok: boolean;
  refused?: boolean;
  summary?: string;
}

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

/**
 * `stopped` means a work ceiling (turns, tool calls, wall clock) ended the run
 * with work still pending — not a failure of the work, and not the user's Stop.
 * `cancelled` is the user's Stop; the two must not share a status.
 */
export type RunStatus =
  | 'planning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'stopped'
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

export interface FailureImportContract {
  /** Repo-relative path to the imported local module. */
  path: string;
  /** Exported signatures exposed by the local module. */
  signatures: string[];
}

export interface FailureFileContext {
  /** Repo-relative path to the failing file. */
  path: string;
  /** Line-numbered source lines for exact repair context. */
  numberedSource: string;
  /** Exported type/function signatures from local modules imported by this file. */
  importedContracts: FailureImportContract[];
}

export interface VerificationReport {
  verdict: Verdict;
  diagnostics: DiagnosticLine[];
  command?: CommandOutcome;
  /**
   * Bounded line-numbered source of failing files plus exported signatures of
   * their local imports, attached on failed checks so repair turns fix mismatches
   * immediately instead of repeating the same type error.
   */
  failureContext?: FailureFileContext[];
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
  /** Optional proof command. Main-process allowlisted forms run via execFile; all others require approval. */
  verifyCommand?: string;
  status: MilestoneStatus;
  /** Semantic category governing verification rules (read-only vs file mutation vs command execution). */
  category?: MilestoneCategory;
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
  /** Wall clock, for the panel's elapsed column and for resume. */
  startedAt: number;
  /** The turn's real tool-call count, when the host reported one. */
  toolCalls?: number;
  /**
   * The command-failure receipt the turn's tool loop captured, when one failed.
   * Kept on the attempt so the journal and a resumed run can see the exact
   * evidence (exit code, stderr) behind a failed check, not just the verdict.
   */
  failureProof?: FailureReceipt | null;
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
  maxAttemptsPerMilestone: number;
  maxMilestones: number;
  /**
   * Turns the whole run may take, however they are spread across milestones.
   * The per-milestone attempt cap cannot cover a plan of eight units that each
   * fail twice, so the run needs its own iteration ceiling.
   */
  maxTurns: number;
  /**
   * Tool calls the whole run may make. Enforced only when the host reports real
   * counts (`TurnResult.toolCalls`); a run whose host does not report them is
   * still bounded by `maxTurns`, and no fake number is charged against it.
   */
  maxToolCalls: number;
  /**
   * Wall-clock ceiling for one stretch of running, in ms. A paused or stopped
   * run is not consuming anything, so this measures continuous driving from the
   * moment the loop starts, not the age of the plan.
   */
  maxWallClockMs: number;
}

/**
 * 3 attempts is what the salvageable repair loop used, and it is the reason
 * that loop could not iterate forever. 24 turns is that ceiling applied to the
 * run (8 milestones is the plan cap, and one clean attempt each is the shape of
 * a good plan), and 20 minutes is what a run of that size takes on a slow local
 * model — long enough to finish, short enough that a stall is noticed. 3840 tool
 * calls keeps the original four-full-turns ratio at the current loop size: 60
 * rounds x 16 calls is 960 per tool-heavy turn, so four such turns (3840) no
 * longer exhaust the run cap. Every number here is a work ceiling that stops a
 * runaway loop; none of them is a spend limit.
 */
export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxAttemptsPerMilestone: 3,
  maxMilestones: 8,
  maxTurns: 24,
  maxToolCalls: 3840,
  maxWallClockMs: 20 * 60 * 1000
};

export interface RunState {
  id: string;
  goal: string;
  status: RunStatus;
  milestones: Milestone[];
  startedAt: number;
  /** Shown verbatim in the panel; the reason a run is not running. */
  error?: string;
  /** Pre-run checkpoint, kept so an unrecoverable failure can be undone. */
  checkpointId?: string | null;
  /** True when a failed run restored the workspace to that checkpoint. */
  rolledBack?: boolean;
  /** Extracted multi-part requirements and their verification coverage status. */
  requirements?: RequirementItem[];
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
  title?: string;
  instruction?: string;
  expectedFiles: string[];
  touchedFiles?: string[];
  verifyCommand?: string;
  category?: MilestoneCategory;
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
   * only noticed between units, so a teammate's turn keeps streaming after the
   * user asked for it to end.
   */
  signal?: AbortSignal;
  /** Defaults to `DEFAULT_APPLY_POLICY`; the caller may tighten it per run. */
  applyPolicy?: ApplyPolicyKind;
}

export interface TurnResult {
  reply: string;
  patchesApplied: number;
  patchFailures: string[];
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
  /**
   * Tool calls this turn actually made, counted by the host from its own tool
   * loop. Left undefined when the host cannot say: the run's tool-call ceiling
   * then has nothing to count, rather than counting a guess.
   */
  toolCalls?: number;
  /**
   * Successful workspace-mutating tool calls this turn (delete_file,
   * run_command, external MCP writes), as the tool loop counted them. Patches
   * are not included — `patchesApplied` already counts those. Undefined when
   * the host cannot say; the loop then falls back to patch evidence alone.
   */
  changedFiles?: number;
  /**
   * The latest command-failure receipt the turn's tool loop captured. The chat
   * path shows it on the reply card; the run keeps it on the attempt so a
   * failed check carries the real exit code and stderr behind it.
   */
  failureProof?: FailureReceipt | null;
  /** Structured telemetry of tools invoked during the turn. */
  toolEvents?: ToolExecutionEvent[];
}

/**
 * What one turn actually wrote, handed to the verifier alongside the unit.
 * A milestone whose turn applied no patches and changed no files may still
 * pass a clean check — but the report must say it touched nothing, because a
 * green typecheck of bytes nobody edited is not proof the milestone was done.
 */
export interface TurnWrites {
  patchesApplied: number;
  /** Non-patch workspace mutations, when the host reports them. */
  changedFiles?: number;
  /** Expected files that already existed before the milestone ran. */
  preExistingExpectedFiles?: string[];
  /** SHA-256 content snapshots captured before the turn for target files (null when absent). */
  preTurnHashes?: Record<string, string | null>;
  /** SHA-256 content snapshots captured after the turn for target/touched files (null when absent). */
  postTurnHashes?: Record<string, string | null>;
  /** Structured telemetry of tool calls executed during the turn. */
  toolEvents?: ToolExecutionEvent[];
}

/**
 * Everything the loop needs from the app, injected so the loop is testable with
 * fakes and so no module in here can invent its own exec or file-write path.
 */
export interface AutonomyPorts {
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  /**
   * Check one unit. `writes` is what the turn that just ran actually wrote, so
   * a zero-write pass can be annotated honestly; omitting it keeps the old
   * diagnostics-plus-command verdict with no write evidence either way.
   */
  verify: (unit: VerifiableUnit, writes?: TurnWrites) => Promise<VerificationReport>;
  /** Repo-relative paths that exist right now, for plan validation and confinement. */
  listFiles: () => string[];
  /** Optional file reader used for pre/post turn SHA-256 verification snapshots. */
  readFile?: (path: string) => Promise<string | null>;
  /** Ask the model for the plan; returns its raw text answer. */
  askPlan: (prompt: string) => Promise<string>;
  onEvent: (event: AutonomyEvent) => void;
  /**
   * Set by the panel's Stop button. Checked between units, and mirrored into
   * `TurnRequest.signal` so Stop ends the request in flight rather than letting
   * it run to completion.
   */
  isCancellationRequested: () => boolean;
  /**
   * Set by the panel's Pause button. A paused run keeps its plan and its
   * progress and is expected to continue; a stopped one is finished — the two
   * are not the same flag. Optional because a caller with no pause control
   * leaves the run with nothing to honour.
   */
  isPauseRequested?: () => boolean;
  /**
   * Optional workspace-wide diagnostics check used during final integration to
   * catch cross-file type breakages outside individual milestone lists.
   */
  verifyWorkspace?: () => Promise<VerificationReport>;
}

export type AutonomyEvent =
  | { type: 'plan:created'; milestones: Milestone[] }
  | { type: 'milestone:start'; id: string }
  | { type: 'milestone:attempt'; id: string; attempt: number }
  | { type: 'milestone:verdict'; id: string; verdict: Verdict; report: VerificationReport; attempt?: number }
  | { type: 'milestone:done'; id: string; status: MilestoneStatus }
  /** Changes the apply policy refused to write without the user. */
  | { type: 'milestone:review'; id: string; paths: string[] }
  | { type: 'log'; text: string }
  | { type: 'run:done'; status: RunStatus };
