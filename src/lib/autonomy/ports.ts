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
import { placeholderDiagnostics } from '../agent/placeholderLint';
import { canonicalPathKey, dedupePaths, isCaseInsensitivePlatform } from '../paths';
import type {
  AutonomyEvent,
  AutonomyPorts,
  CommandOutcome,
  DiagnosticLine,
  TurnRequest,
  TurnResult,
  TurnWrites,
  VerifiableUnit,
  VerificationReport,
  Verdict
} from './types';

/** Everything the adapter needs from the app, injected so it stays testable. */
export interface AutonomyHost {
  /** Send one milestone instruction through the real chat path and apply its patches. */
  runTurn: (request: TurnRequest) => Promise<TurnResult>;
  /**
   * A fresh workspace-wide or targeted diagnostics request (absolute file paths).
   *
   * `null` means no checker is attached at all — no folder open, no language
   * service. It must not be written as `[]`, because an empty array is a real
   * answer ("checked, found nothing"), and an empty answer would let a milestone
   * with no working checker be reported as passed.
   */
  getDiagnostics: (files?: string[]) => Promise<DesktopDiagnostic[] | null>;
  /** Workspace-relative paths on disk right now. */
  listFiles: () => string[];
  /** One model call that returns raw text (used for planning). */
  askPlan: (prompt: string) => Promise<string>;
  /** Run the milestone's proof command through the app's approval gate. */
  runCommand: (argv: string) => Promise<CommandOutcome>;
  /** Optional file reader so the verifier can inspect written files for placeholder stubs. */
  readFile?: (path: string) => Promise<string | null>;
  /** Optional workspace dependency/tsconfig manifest summary injected into sub-agents. */
  getWorkspaceManifest?: () => Promise<string | null>;
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

function isWindowsPathStyle(value: string): boolean {
  return /^[a-z]:\//i.test(value);
}

/** Turn an absolute path into a workspace-relative one; falls back to the normalized absolute. */
export function toWorkspaceRelative(absolutePath: string, rootPath: string): string {
  const file = normalizeRelativePath(absolutePath).replace(/\/+$/, '');
  const root = normalizeRelativePath(rootPath).replace(/\/+$/, '');
  if (!root) return file;
  const caseInsensitive = isCaseInsensitivePlatform() || isWindowsPathStyle(file) || isWindowsPathStyle(root);
  const fileCmp = caseInsensitive ? file.toLowerCase() : file;
  const rootCmp = caseInsensitive ? root.toLowerCase() : root;
  if (fileCmp === rootCmp) return '';
  if (fileCmp.startsWith(`${rootCmp}/`)) return file.slice(root.length + 1);
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
 * milestone named/touched no files. Both are the same to a user — no evidence —
 * so both come back null rather than as an empty list that reads like a clean bill.
 */
export function collectMilestoneDiagnostics(
  unit: VerifiableUnit,
  diagnostics: DesktopDiagnostic[] | null,
  rootPath: string
): DiagnosticLine[] | null {
  const caseInsensitive = isCaseInsensitivePlatform() || isWindowsPathStyle(normalizeRelativePath(rootPath));
  const targetFiles = dedupePaths([...unit.expectedFiles, ...(unit.touchedFiles ?? [])], caseInsensitive);
  if (diagnostics === null || targetFiles.length === 0) return null;

  const wanted = new Map<string, string>();
  for (const file of targetFiles) {
    wanted.set(canonicalPathKey(file, caseInsensitive), normalizeRelativePath(file));
  }

  const seen = new Set<string>();
  const lines: DiagnosticLine[] = [];
  for (const diagnostic of diagnostics) {
    const relative = toWorkspaceRelative(diagnostic.file, rootPath);
    const key = canonicalPathKey(relative, caseInsensitive);
    const canonicalPath = wanted.get(key);
    if (!canonicalPath) continue;
    const line = toDiagnosticLine(diagnostic, canonicalPath);
    if (!line) continue;
    const dedupeKey = `${line.severity}:${key}:${line.line}:${line.column}:${line.message}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(line);
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
 * - placeholder code lint error -> failed, forcing the next attempt to replace stubs
 * - the command exited non-zero -> diagnostic evidence, not a verdict: its exit
 *   code and output ride on the report for the next attempt's repair brief, but
 *   the compiler diagnostics decide. A fresh workspace's planner-invented
 *   `npm test`/`tsc` often fails before deps or scripts exist, and that alone
 *   must not kill the task (and block every dependent).
 * - the command timed out       -> failed: it proved nothing and burned its budget
 * - a clean check or green cmd  -> passed
 * - the command was declined    -> the diagnostics verdict stands, with a note
 * - nothing checked it          -> unverified, never a silent pass
 */
export async function verifyMilestone(
  unit: VerifiableUnit,
  host: AutonomyHost,
  rootPath: string,
  writes?: TurnWrites
): Promise<VerificationReport> {
  const notes: string[] = [];
  let diagnostics: DiagnosticLine[] | null = null;
  const caseInsensitive = isCaseInsensitivePlatform() || isWindowsPathStyle(normalizeRelativePath(rootPath));
  const targetFiles = dedupePaths([...unit.expectedFiles, ...(unit.touchedFiles ?? [])], caseInsensitive);

  try {
    const answer = await host.getDiagnostics(targetFiles.length > 0 ? targetFiles : undefined);
    if (answer === null) notes.push('no type checker is attached to this workspace, so nothing was actually checked.');
    diagnostics = collectMilestoneDiagnostics(unit, answer, rootPath);
  } catch (error) {
    notes.push(`the type service did not answer: ${error instanceof Error ? error.message : String(error)}`);
    diagnostics = null;
  }

  // Zero-placeholder enforcement on written/expected source files.
  if (targetFiles.length > 0 && typeof host.readFile === 'function') {
    const placeholderLines: DiagnosticLine[] = [];
    for (const file of targetFiles) {
      try {
        const content = await host.readFile(file);
        if (typeof content === 'string') {
          placeholderLines.push(...placeholderDiagnostics(file, content));
        }
      } catch {
        /* ignore unreadable or missing files during static placeholder inspection */
      }
    }
    if (placeholderLines.length > 0) {
      diagnostics = [...(diagnostics ?? []), ...placeholderLines];
    }
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
        notes.push(
          `the proof command exited ${outcome.exitCode === null ? 'without a code' : outcome.exitCode}; its output is attached as diagnostic evidence, not a verdict.`
        );
      }
    } catch (error) {
      notes.push(`the proof command could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const commandRan = command !== undefined && !command.declinedReason;
  const commandPassed = commandRan && command.exitCode === 0 && !command.timedOut;
  const commandFailed = commandRan && command.timedOut;
  const errorDiagnostics = diagnostics?.filter((line) => line.severity === 'error') ?? [];
  const hasError = errorDiagnostics.length > 0;

  let verdict: Verdict;
  if (hasError || commandFailed) {
    verdict = 'failed';
    if (hasError) {
      const first = errorDiagnostics[0];
      notes.push(`${errorDiagnostics.length} error diagnostic(s) found (${first.path}:${first.line} ${first.message})`);
    }
  } else if (diagnostics !== null || commandPassed) {
    verdict = 'passed';
  } else {
    verdict = 'unverified';
    if (targetFiles.length === 0) {
      notes.push('the milestone named no files, so there was nothing specific to check.');
    }
  }

  if (writes && writes.patchesApplied === 0 && (writes.changedFiles ?? 0) === 0) {
    notes.push('the milestone touched nothing: the turn applied no patches and changed no files.');
    if (verdict === 'passed' && unit.expectedFiles.length > 0) {
      // A clean check is not proof of work: a turn that wrote nothing can only
      // pass when the files the milestone was meant to produce already exist
      // on disk. Anything less is a no-op being laundered into a pass.
      if (typeof host.readFile === 'function') {
        const missing: string[] = [];
        for (const file of unit.expectedFiles) {
          try {
            await host.readFile(file);
          } catch {
            missing.push(file);
          }
        }
        if (missing.length > 0) {
          verdict = 'failed';
          notes.push(`the turn produced no changes and ${missing.length} expected file(s) are absent: ${missing.slice(0, 5).join(', ')}.`);
        }
      } else {
        verdict = 'unverified';
        notes.push('the turn changed no files and no file reader is attached, so the milestone cannot be claimed as passed.');
      }
    }
  }

  return { verdict, diagnostics: diagnostics ?? [], command, notes };
}

/** Wrap the app's capabilities into the engine's ports contract. */
export function createAutonomyPorts(host: AutonomyHost, options: AutonomyPortsOptions): AutonomyPorts {
  return {
    runTurn: (request) => host.runTurn(request),
    verify: (unit, writes) => verifyMilestone(unit, host, options.rootPath, writes),
    listFiles: () => host.listFiles(),
    askPlan: (prompt) => host.askPlan(prompt),
    onEvent: options.onEvent,
    isCancellationRequested: options.isCancellationRequested,
    ...(options.isPauseRequested ? { isPauseRequested: options.isPauseRequested } : {})
  };
}
