/**
 * The ports adapter: the one place the autonomous engine is allowed to touch the
 * app.
 *
 * The run-loop asks for five capabilities (run a turn, verify a milestone, list
 * files, ask for a plan, run a proof command). This file wraps them into
 * `AutonomyPorts` and owns the one piece of real logic in between — turning the
 * language service's diagnostics into the engine's `VerificationReport`, with
 * the "unverified" verdict used honestly: when a milestone named no files, or
 * when no checker could run, the report says so instead of claiming a pass.
 */

import type { DesktopDiagnostic } from '../desktop';
import type {
  AutonomyEvent,
  AutonomyPorts,
  CommandOutcome,
  DiagnosticLine,
  TurnRequest,
  TurnResult,
  VerifiableUnit,
  VerificationReport,
  Verdict
} from './types';

/** Everything the adapter needs from the app, injected so it stays testable. */
export interface AutonomyHost {
  /** Send one milestone instruction through the real chat path and apply its patches. */
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  /**
   * A fresh workspace-wide diagnostics request (absolute file paths).
   *
   * `null` means no checker is attached at all — no folder open, no language
   * service. It must not be written as `[]`, because an empty array is a real
   * answer ("checked, found nothing"), and an empty answer would let a milestone
   * with no working checker be reported as passed.
   */
  getDiagnostics: () => Promise<DesktopDiagnostic[] | null>;
  /** Workspace-relative paths on disk right now. */
  listFiles: () => string[];
  /** One model call that returns raw text (used for planning). */
  askPlan: (prompt: string) => Promise<string>;
  /** Run the milestone's proof command through the app's approval gate. */
  runCommand: (argv: string) => Promise<CommandOutcome>;
}

export interface AutonomyPortsOptions {
  /** Workspace root, used to make diagnostic paths repo-relative. */
  rootPath: string;
  onEvent: (event: AutonomyEvent) => void;
  isCancellationRequested: () => boolean;
  /** The panel's Pause button, when the caller has one. */
  isPauseRequested?: () => boolean;
}

/** Normalize to forward slashes with no leading `./` — the form the planner emits. */
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/** Turn an absolute path into a workspace-relative one; falls back to the normalized absolute. */
export function toWorkspaceRelative(absolutePath: string, rootPath: string): string {
  const file = normalizeRelativePath(absolutePath).replace(/\/+$/, '');
  const root = normalizeRelativePath(rootPath).replace(/\/+$/, '');
  if (!root) return file;
  if (file === root) return '';
  if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file;
}

/** Map one desktop diagnostic into the engine's line shape, dropping hints. */
export function toDiagnosticLine(diagnostic: DesktopDiagnostic, relativePath: string): DiagnosticLine | null {
  if (diagnostic.severity === 'info') return null;
  return {
    path: relativePath,
    line: diagnostic.line + 1,
    column: diagnostic.character + 1,
    message: diagnostic.message,
    severity: diagnostic.severity
  };
}

/**
 * The error diagnostics for a milestone's files.
 *
 * `null` means nothing was checked: either the workspace has no checker, or the
 * milestone named no files. Both are the same to a user — no evidence — so both
 * come back null rather than as an empty list that reads like a clean bill.
 */
export function collectMilestoneDiagnostics(
  unit: VerifiableUnit,
  diagnostics: DesktopDiagnostic[] | null,
  rootPath: string
): DiagnosticLine[] | null {
  if (diagnostics === null || unit.expectedFiles.length === 0) return null;
  const wanted = new Set(unit.expectedFiles.map(normalizeRelativePath));
  const lines: DiagnosticLine[] = [];
  for (const diagnostic of diagnostics) {
    const relative = toWorkspaceRelative(diagnostic.file, rootPath);
    if (!wanted.has(relative)) continue;
    const line = toDiagnosticLine(diagnostic, relative);
    if (line) lines.push(line);
  }
  return lines;
}

/** Truncate a captured stream to a readable tail for the report. */
function tail(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

/**
 * Judge a milestone from diagnostics plus its optional proof command.
 *
 * - an error diagnostic         -> failed, and a green command cannot undo it
 * - the command exited non-zero -> failed
 * - a clean check or green cmd  -> passed
 * - the command was declined    -> the diagnostics verdict stands, with a note
 * - nothing checked it          -> unverified, never a silent pass
 */
export async function verifyMilestone(
  unit: VerifiableUnit,
  host: AutonomyHost,
  rootPath: string
): Promise<VerificationReport> {
  const notes: string[] = [];
  let diagnostics: DiagnosticLine[] | null = null;

  try {
    const answer = await host.getDiagnostics();
    if (answer === null) notes.push('no type checker is attached to this workspace, so nothing was actually checked.');
    diagnostics = collectMilestoneDiagnostics(unit, answer, rootPath);
  } catch (error) {
    notes.push(`the type service did not answer: ${error instanceof Error ? error.message : String(error)}`);
    diagnostics = null;
  }

  let command: CommandOutcome | undefined;

  if (unit.verifyCommand) {
    try {
      const outcome = await host.runCommand(unit.verifyCommand);
      command = { ...outcome, stdoutTail: tail(outcome.stdoutTail), stderrTail: tail(outcome.stderrTail) };
      if (outcome.timedOut) {
        notes.push('the proof command was killed by its time limit, so its result is not a verdict.');
      }
      if (outcome.declinedReason) {
        notes.push(`the proof command was not run: ${outcome.declinedReason}`);
      } else if (outcome.exitCode !== 0) {
        notes.push(`the proof command exited ${outcome.exitCode === null ? 'without a code' : outcome.exitCode}.`);
      }
    } catch (error) {
      notes.push(`the proof command could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const commandRan = command !== undefined && !command.declinedReason;
  // A command killed by its time limit proved nothing, whatever exit code the
  // runner reported for it, so it can never carry a milestone to `passed`.
  const commandPassed = commandRan && command.exitCode === 0 && !command.timedOut;
  const commandFailed = commandRan && (command.exitCode !== 0 || command.timedOut);
  const hasError = diagnostics?.some((line) => line.severity === 'error') ?? false;

  // A failure is sticky: a green command never erases a type error the same
  // milestone introduced, and a declined command never turns a failure green.
  let verdict: Verdict;
  if (hasError || commandFailed) {
    verdict = 'failed';
  } else if (diagnostics !== null || commandPassed) {
    verdict = 'passed';
  } else {
    verdict = 'unverified';
    if (unit.expectedFiles.length === 0) {
      notes.push('the milestone named no files, so there was nothing specific to check.');
    }
  }

  return { verdict, diagnostics: diagnostics ?? [], command, notes };
}

/** Wrap the app's capabilities into the engine's ports contract. */
export function createAutonomyPorts(host: AutonomyHost, options: AutonomyPortsOptions): AutonomyPorts {
  return {
    runTurn: (request) => host.runTurn(request),
    verify: (unit) => verifyMilestone(unit, host, options.rootPath),
    listFiles: () => host.listFiles(),
    askPlan: (prompt) => host.askPlan(prompt),
    onEvent: options.onEvent,
    isCancellationRequested: options.isCancellationRequested,
    ...(options.isPauseRequested ? { isPauseRequested: options.isPauseRequested } : {})
  };
}
