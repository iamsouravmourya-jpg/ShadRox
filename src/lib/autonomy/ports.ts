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

import type { DesktopDiagnostic, ExportedContract } from '../desktop';
import { placeholderDiagnostics } from '../agent/placeholderLint';
import { canonicalPathKey, dedupePaths, isCaseInsensitivePlatform } from '../paths';
import {
  buildNonMutationDiagnostics,
  compareFileHashSnapshots,
  evaluateNativeFileCheckCommand,
  inferMilestoneCategory,
  parseNativeFileCheckCommand,
  shouldSkipDiagnostics,
  verifyToolTelemetry
} from './milestoneVerifier';
import type {
  AutonomyEvent,
  AutonomyPorts,
  CommandOutcome,
  DiagnosticLine,
  FailureFileContext,
  FailureImportContract,
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
  /** Optional file reader so the verifier can inspect written files for placeholder stubs and repair context. */
  readFile?: (path: string) => Promise<string | null>;
  /** Optional type-checker contract extractor for local modules imported by failing files. */
  getExportedContracts?: (paths: string[]) => Promise<ExportedContract[] | null>;
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

const MAX_FAILURE_FILES = 3;
const MAX_NUMBERED_LINES = 140;
const MAX_SOURCE_CHARS = 6000;
const MAX_IMPORTS_PER_FILE = 6;
const MAX_SIGNATURES_PER_IMPORT = 12;

function formatNumberedSource(content: string, errorLines: number[]): string {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  let ranges: Array<[number, number]>;
  if (total <= MAX_NUMBERED_LINES) {
    ranges = [[1, total]];
  } else if (errorLines.length === 0) {
    ranges = [[1, MAX_NUMBERED_LINES]];
  } else {
    const windows = errorLines
      .map((line) => [Math.max(1, line - 18), Math.min(total, line + 18)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const win of windows) {
      const prev = merged[merged.length - 1];
      if (prev && win[0] <= prev[1] + 4) {
        prev[1] = Math.max(prev[1], win[1]);
      } else {
        merged.push([win[0], win[1]]);
      }
    }
    ranges = merged;
  }

  const out: string[] = [];
  let charBudget = MAX_SOURCE_CHARS;
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    if (i > 0) out.push('...');
    for (let ln = start; ln <= end; ln++) {
      const formatted = `${String(ln).padStart(4, ' ')} | ${lines[ln - 1] ?? ''}`;
      if (charBudget - formatted.length - 1 < 0) {
        out.push('... (source truncated)');
        return out.join('\n');
      }
      out.push(formatted);
      charBudget -= formatted.length + 1;
    }
  }
  return out.join('\n');
}

function extractLocalSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = (match[1] || match[2] || '').trim();
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/') || spec.startsWith('~/')) {
      specs.add(spec);
    }
  }
  return [...specs];
}

function resolveWorkspaceImport(importerRel: string, specifier: string, workspaceFiles: readonly string[], caseInsensitive: boolean): string | null {
  const fileMap = new Map<string, string>();
  for (const file of workspaceFiles) {
    const norm = normalizeRelativePath(file);
    fileMap.set(canonicalPathKey(norm, caseInsensitive), norm);
  }

  const importerParts = normalizeRelativePath(importerRel).split('/');
  importerParts.pop();

  let baseCandidates: string[] = [];
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = [...importerParts];
    for (const seg of specifier.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') resolved.pop();
      else resolved.push(seg);
    }
    baseCandidates = [resolved.join('/')];
  } else if (specifier.startsWith('@/')) {
    const sub = specifier.slice(2);
    baseCandidates = [`src/${sub}`, sub];
  } else if (specifier.startsWith('~/')) {
    const sub = specifier.slice(2);
    baseCandidates = [`src/${sub}`, sub];
  }

  const exts = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  const tsAlt: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs']
  };

  for (const base of baseCandidates) {
    const dot = base.lastIndexOf('.');
    const slash = base.lastIndexOf('/');
    const ext = dot > slash ? base.slice(dot).toLowerCase() : '';
    if (ext && tsAlt[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const alt of tsAlt[ext]) {
        const hit = fileMap.get(canonicalPathKey(stem + alt, caseInsensitive));
        if (hit) return hit;
      }
    }
    for (const suffix of exts) {
      const hit = fileMap.get(canonicalPathKey(base + suffix, caseInsensitive));
      if (hit) return hit;
    }
  }
  return null;
}

function extractFallbackExportSignatures(source: string): string[] {
  const sigs: string[] = [];
  const lines = source.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('export ')) continue;
    if (/^export\s+default\s+/.test(trimmed)) {
      sigs.push(trimmed.replace(/\s*\{[\s\S]*$/, '').slice(0, 140));
    } else if (/^export\s+(?:async\s+)?function\b/.test(trimmed)) {
      sigs.push(trimmed.replace(/\s*\{[\s\S]*$/, '').slice(0, 140));
    } else if (/^export\s+(?:type|interface|enum|class)\b/.test(trimmed)) {
      sigs.push(trimmed.replace(/\s*\{[\s\S]*$/, ' { ... }').slice(0, 140));
    } else if (/^export\s+(?:const|let)\s+/.test(trimmed)) {
      const decl = trimmed.split(/\s*=\s*/)[0];
      sigs.push(decl.slice(0, 140));
    } else if (/^export\s*\{/.test(trimmed)) {
      sigs.push(trimmed.slice(0, 140));
    }
    if (sigs.length >= MAX_SIGNATURES_PER_IMPORT) break;
  }
  return sigs;
}

async function buildFailureContext(
  errorDiagnostics: readonly DiagnosticLine[],
  host: AutonomyHost,
  caseInsensitive: boolean
): Promise<FailureFileContext[] | undefined> {
  if (errorDiagnostics.length === 0 || typeof host.readFile !== 'function') return undefined;

  const groupedLines = new Map<string, number[]>();
  for (const diag of errorDiagnostics) {
    const list = groupedLines.get(diag.path) ?? [];
    list.push(diag.line);
    if (!groupedLines.has(diag.path) && groupedLines.size >= MAX_FAILURE_FILES) continue;
    groupedLines.set(diag.path, list);
  }

  const workspaceFiles = host.listFiles();
  const fileReads = new Map<string, string>();
  const resolvedImportsByFile = new Map<string, string[]>();
  const allImportPaths: string[] = [];

  for (const filePath of groupedLines.keys()) {
    try {
      const content = await host.readFile(filePath);
      if (typeof content !== 'string') continue;
      fileReads.set(filePath, content);
      const importPaths = extractLocalSpecifiers(content)
        .map((spec) => resolveWorkspaceImport(filePath, spec, workspaceFiles, caseInsensitive))
        .filter((resolved): resolved is string => Boolean(resolved && resolved !== filePath));
      const uniqueImports = dedupePaths(importPaths, caseInsensitive).slice(0, MAX_IMPORTS_PER_FILE);
      resolvedImportsByFile.set(filePath, uniqueImports);
      for (const imp of uniqueImports) {
        if (!allImportPaths.includes(imp)) allImportPaths.push(imp);
      }
    } catch {
      /* unreadable failing file is non-fatal */
    }
  }

  if (fileReads.size === 0) return undefined;

  const contractsByPath = new Map<string, string[]>();
  if (allImportPaths.length > 0 && typeof host.getExportedContracts === 'function') {
    try {
      const contracts = await host.getExportedContracts(allImportPaths);
      if (Array.isArray(contracts)) {
        for (const contract of contracts) {
          const norm = normalizeRelativePath(contract.file);
          const sigs = (contract.exports ?? [])
            .slice(0, MAX_SIGNATURES_PER_IMPORT)
            .map((entry) => entry.signature)
            .filter(Boolean);
          if (sigs.length > 0) {
            contractsByPath.set(canonicalPathKey(norm, caseInsensitive), sigs);
          }
        }
      }
    } catch {
      /* fall back cleanly to lightweight static export extraction */
    }
  }

  for (const impPath of allImportPaths) {
    const key = canonicalPathKey(impPath, caseInsensitive);
    if (contractsByPath.has(key)) continue;
    try {
      const impContent = await host.readFile(impPath);
      if (typeof impContent === 'string') {
        const sigs = extractFallbackExportSignatures(impContent);
        if (sigs.length > 0) contractsByPath.set(key, sigs);
      }
    } catch {
      /* ignore unreadable imported module */
    }
  }

  const contexts: FailureFileContext[] = [];
  for (const [filePath, errLines] of groupedLines.entries()) {
    const content = fileReads.get(filePath);
    if (typeof content !== 'string') continue;
    const numberedSource = formatNumberedSource(content, errLines);
    const importedContracts: FailureImportContract[] = [];
    for (const impPath of resolvedImportsByFile.get(filePath) ?? []) {
      const sigs = contractsByPath.get(canonicalPathKey(impPath, caseInsensitive));
      if (sigs && sigs.length > 0) {
        importedContracts.push({ path: impPath, signatures: sigs });
      }
    }
    contexts.push({ path: filePath, numberedSource, importedContracts });
  }

  return contexts.length > 0 ? contexts : undefined;
}

/**
 * Judge a milestone from diagnostics plus its optional proof command.
 *
 * - an error diagnostic         -> failed, and a green command cannot undo it
 * - placeholder code lint error -> failed, forcing the next attempt to replace stubs
 * - the command exited non-zero -> failed; its exit code and output ride on the
 *   report for the next attempt's repair brief
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

  const category = inferMilestoneCategory(unit);
  const skipDiagnostics = shouldSkipDiagnostics(unit);

  if (!skipDiagnostics) {
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
  } else {
    diagnostics = [];
    notes.push(`skipped TypeScript/linter diagnostics for ${category} milestone.`);
  }
  let command: CommandOutcome | undefined;

  if (unit.verifyCommand) {
    const fileCheckClauses = parseNativeFileCheckCommand(unit.verifyCommand);
    if (fileCheckClauses) {
      const nativeCheck = await evaluateNativeFileCheckCommand(unit.verifyCommand, {
        listFiles: () => host.listFiles(),
        readFile: host.readFile
      });
      if (nativeCheck) {
        notes.push(...nativeCheck.notes);
        command = {
          argv: unit.verifyCommand,
          exitCode: nativeCheck.ok ? 0 : 1,
          stdoutTail: nativeCheck.ok ? nativeCheck.notes.join('\n') : '',
          stderrTail: nativeCheck.ok ? '' : `Missing path(s): ${nativeCheck.missing.join(', ')}`,
          timedOut: false
        };
      }
    } else {
      try {
        const outcome = await host.runCommand(unit.verifyCommand);
        command = { ...outcome, stdoutTail: tail(outcome.stdoutTail), stderrTail: tail(outcome.stderrTail) };
        if (outcome.timedOut) {
          notes.push('the proof command was killed by its time limit, so its result is not a verdict.');
        }
        if (outcome.declinedReason) {
          notes.push(`the proof command was not run: ${outcome.declinedReason}`);
        } else if (outcome.exitCode !== 0) {
          if (outcome.exitCode === null) {
            notes.push('the proof command exited without a code; falling back to scoped typecheck diagnostics.');
          } else {
            notes.push(
              `the proof command exited ${outcome.exitCode} and failed verification.`
            );
          }
        }
      } catch (error) {
        notes.push(`the proof command could not run: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const commandRan = command !== undefined && !command.declinedReason;
  const commandPassed = commandRan && (command.exitCode === 0 || command.exitCode === null) && !command.timedOut;
  const commandFailed = commandRan && (command.timedOut || (command.exitCode !== null && command.exitCode !== 0));
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
    if (targetFiles.length === 0 && category !== 'read_only' && category !== 'checkpoint') {
      notes.push('the milestone named no files, so there was nothing specific to check.');
    }
  }

  // Deterministic read-only & checkpoint category telemetry check: never reject
  // for zero patches or pre-existing diagnostics when skipping diagnostic checks.
  if (skipDiagnostics) {
    const telemetry = verifyToolTelemetry(category, unit, writes);
    if (telemetry.notes.length > 0) notes.push(...telemetry.notes);
    if (commandFailed || (!telemetry.ok && writes?.toolEvents && writes.toolEvents.length > 0 && telemetry.ranRelevantTool)) {
      verdict = 'failed';
    } else {
      verdict = 'passed';
    }
    return { verdict, diagnostics: [], ...(command ? { command } : {}), notes };
  }

  const MODIFICATION_INTENT_PATTERN = /\b(update|edit|modify|refactor|fix|patch|replace|rename|remove|wire|integrate|extend|enhance|improve|style|convert|migrate)\b/i;

  const hashDiff = compareFileHashSnapshots(
    targetFiles,
    writes?.preTurnHashes,
    writes?.postTurnHashes
  );
  const hashProvesMutation = hashDiff.compared && hashDiff.mutatedPaths.length > 0;
  const hashProvesZeroDiff =
    hashDiff.compared && hashDiff.mutatedPaths.length === 0 && hashDiff.missingPaths.length === 0;

  if (writes && writes.patchesApplied === 0 && (writes.changedFiles ?? 0) === 0 && !hashProvesMutation) {
    notes.push('the milestone touched nothing: the turn applied no patches and changed no files.');
    if (verdict === 'passed' && unit.expectedFiles.length > 0) {
      // A clean check is not proof of work: a turn that wrote nothing can only
      // pass when a creation milestone's outputs are already on disk. When the
      // milestone targets pre-existing files or explicitly asks for an edit,
      // zero writes means the requested modification never happened.
      if (typeof host.readFile === 'function') {
        const missing: string[] = [];
        for (const file of unit.expectedFiles) {
          try {
            const content = await host.readFile(file);
            if (content === null) missing.push(file);
          } catch {
            missing.push(file);
          }
        }
        const hasPreExistingTarget = (writes.preExistingExpectedFiles?.length ?? 0) > 0;
        const unitText = `${unit.title ?? ''} ${unit.instruction ?? ''}`;
        const explicitModification = MODIFICATION_INTENT_PATTERN.test(unitText);
        if (missing.length > 0) {
          verdict = 'failed';
          notes.push(`the turn produced no changes and ${missing.length} expected file(s) are absent: ${missing.slice(0, 5).join(', ')}.`);
          diagnostics = [...(diagnostics ?? []), ...buildNonMutationDiagnostics(missing)];
        } else if (hasPreExistingTarget || explicitModification || hashProvesZeroDiff) {
          verdict = 'failed';
          const targets = (writes.preExistingExpectedFiles?.length ? writes.preExistingExpectedFiles : unit.expectedFiles).slice(0, 5);
          notes.push(`the turn produced no changes to existing target file(s): ${targets.join(', ')}.`);
        }
      } else {
        verdict = 'unverified';
        notes.push('the turn changed no files and no file reader is attached, so the milestone cannot be claimed as passed.');
      }
    }
  } else if (hashProvesMutation) {
    notes.push(`SHA-256 verification confirmed byte changes in ${hashDiff.mutatedPaths.slice(0, 5).join(', ')}.`);
  }

  const failureContext =
    verdict === 'failed' && hasError
      ? await buildFailureContext(errorDiagnostics, host, caseInsensitive)
      : undefined;

  return { verdict, diagnostics: diagnostics ?? [], command, ...(failureContext ? { failureContext } : {}), notes };
}

/**
 * Collects deduplicated workspace-relative error/warning diagnostics across the
 * entire project, or returns `null` when no type checker is attached.
 */
export async function collectWorkspaceDiagnostics(
  host: AutonomyHost,
  rootPath: string
): Promise<DiagnosticLine[] | null> {
  const caseInsensitive = isCaseInsensitivePlatform() || isWindowsPathStyle(normalizeRelativePath(rootPath));
  const raw = await host.getDiagnostics(undefined);
  if (raw === null) return null;

  const seen = new Set<string>();
  const lines: DiagnosticLine[] = [];
  for (const diagnostic of raw) {
    const relative = toWorkspaceRelative(diagnostic.file, rootPath) || normalizeRelativePath(diagnostic.file);
    const line = toDiagnosticLine(diagnostic, relative);
    if (!line) continue;
    const key = canonicalPathKey(relative, caseInsensitive);
    const dedupeKey = `${line.severity}:${key}:${line.line}:${line.column}:${line.message}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(line);
  }
  return lines;
}

/**
 * Runs a full workspace diagnostics check across all workspace files (not only a
 * single milestone's expectedFiles) so cross-file breakage outside the milestone
 * list is caught before a run declares victory.
 */
export async function verifyWorkspaceDiagnostics(
  host: AutonomyHost,
  rootPath: string
): Promise<VerificationReport> {
  const caseInsensitive = isCaseInsensitivePlatform() || isWindowsPathStyle(normalizeRelativePath(rootPath));
  let lines: DiagnosticLine[] | null = null;
  try {
    lines = await collectWorkspaceDiagnostics(host, rootPath);
  } catch (error) {
    return {
      verdict: 'unverified',
      diagnostics: [],
      notes: [`the type service did not answer during workspace verification: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  if (lines === null) {
    return {
      verdict: 'unverified',
      diagnostics: [],
      notes: ['no type checker is attached to this workspace, so workspace-wide verification could not run.']
    };
  }

  const errorDiagnostics = lines.filter((line) => line.severity === 'error');
  if (errorDiagnostics.length > 0) {
    const first = errorDiagnostics[0];
    const failureContext = await buildFailureContext(errorDiagnostics, host, caseInsensitive);
    return {
      verdict: 'failed',
      diagnostics: lines,
      ...(failureContext ? { failureContext } : {}),
      notes: [`${errorDiagnostics.length} workspace-wide error diagnostic(s) found (${first.path}:${first.line} ${first.message})`]
    };
  }

  return { verdict: 'passed', diagnostics: lines, notes: [] };
}

/** Wrap the app's capabilities into the engine's ports contract. */
export function createAutonomyPorts(host: AutonomyHost, options: AutonomyPortsOptions): AutonomyPorts {
  return {
    runTurn: (request) => host.runTurn(request),
    verify: (unit, writes) => verifyMilestone(unit, host, options.rootPath, writes),
    verifyWorkspace: () => verifyWorkspaceDiagnostics(host, options.rootPath),
    captureBaselineDiagnostics: () => collectWorkspaceDiagnostics(host, options.rootPath).catch(() => null),
    listFiles: () => host.listFiles(),
    ...(host.readFile ? { readFile: (path) => host.readFile!(path) } : {}),
    askPlan: (prompt) => host.askPlan(prompt),
    onEvent: options.onEvent,
    isCancellationRequested: options.isCancellationRequested,
    ...(options.isPauseRequested ? { isPauseRequested: options.isPauseRequested } : {})
  };
}
