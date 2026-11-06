import type { DesktopDiagnostic } from './desktop';
import type { FilePatch } from './markdown';

export interface WorkspaceTextFile {
  name: string;
  content: string;
}

export interface ExportEntry {
  file: string;
  name: string;
  kind: 'named' | 'default' | 'type';
}

export interface AutoImportResult {
  patches: FilePatch[];
  resolved: Array<{ file: string; symbol: string; importPath: string }>;
  unresolved: DesktopDiagnostic[];
  notes: string[];
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const IDENTIFIER_RE = new RegExp('^' + IDENTIFIER + '$');

const DECLARATION_RE = new RegExp(
  '^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?' +
    '(const|let|var|function\\*?|class|interface|type|enum)\\s+(' +
    IDENTIFIER +
    ')'
);
const DEFAULT_DECLARATION_RE = new RegExp(
  '^export\\s+default\\s+(?:async\\s+)?(?:function\\*?|abstract\\s+class|class)\\s+(' +
    IDENTIFIER +
    ')'
);
const DEFAULT_NAME_RE = new RegExp(
  '^export\\s+default\\s+(' + IDENTIFIER + ')\\s*;?\\s*$'
);
const BRACED_EXPORT_RE = /^export\s+(type\s+)?\{([^}]*)\}/;
const AS_ALIAS_RE = new RegExp('\\sas\\s+(' + IDENTIFIER + ')\\s*$');
const LEADING_IDENT_RE = new RegExp('^(' + IDENTIFIER + ')');
const TYPE_PREFIX_RE = /^type\s+/;
const DIAGNOSTIC_MESSAGE_RE = /Cannot find name '([A-Za-z_$][\w$]*)'/;
const DIRECTIVE_RE = /^(?:'use client'|"use client"|'use strict'|"use strict");?\s*$/;

function kindRank(kind: ExportEntry['kind']): number {
  if (kind === 'named') return 0;
  if (kind === 'type') return 1;
  return 2;
}

function registerExport(
  found: Map<string, ExportEntry>,
  file: string,
  name: string,
  kind: ExportEntry['kind']
): void {
  if (!IDENTIFIER_RE.test(name) || name === 'default') return;
  const existing = found.get(name);
  if (existing && kindRank(existing.kind) <= kindRank(kind)) return;
  found.set(name, { file, name, kind });
}

export function buildExportIndex(
  files: WorkspaceTextFile[]
): Map<string, ExportEntry[]> {
  const index = new Map<string, ExportEntry[]>();

  for (const file of files) {
    const found = new Map<string, ExportEntry>();

    for (const rawLine of file.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!/^export\b/.test(line)) continue;

      const declaration = line.match(DECLARATION_RE);
      if (declaration) {
        const keyword = declaration[1];
        const name = declaration[2];
        const kind: ExportEntry['kind'] =
          keyword === 'interface' || keyword === 'type' ? 'type' : 'named';
        registerExport(found, file.name, name, kind);
        continue;
      }

      const defaultDeclaration = line.match(DEFAULT_DECLARATION_RE);
      if (defaultDeclaration) {
        registerExport(found, file.name, defaultDeclaration[1], 'default');
        continue;
      }

      const braced = line.match(BRACED_EXPORT_RE);
      if (braced) {
        const typeOnly = Boolean(braced[1]);
        for (const rawSpecifier of braced[2].split(',')) {
          let specifier = rawSpecifier.trim();
          if (!specifier) continue;
          let kind: ExportEntry['kind'] = typeOnly ? 'type' : 'named';
          if (TYPE_PREFIX_RE.test(specifier)) {
            kind = 'type';
            specifier = specifier.replace(TYPE_PREFIX_RE, '');
          }
          const alias = specifier.match(AS_ALIAS_RE);
          const leading = specifier.match(LEADING_IDENT_RE);
          const name = alias ? alias[1] : leading ? leading[1] : null;
          if (name) registerExport(found, file.name, name, kind);
        }
        continue;
      }

      const defaultName = line.match(DEFAULT_NAME_RE);
      if (defaultName) {
        registerExport(found, file.name, defaultName[1], 'default');
      }
    }

    for (const entry of Array.from(found.values())) {
      const existing = index.get(entry.name);
      if (existing) existing.push(entry);
      else index.set(entry.name, [entry]);
    }
  }

  return index;
}

function isImportStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === 'import' || /^import[\s{]/.test(trimmed);
}

function importStatementEnd(lines: string[], start: number): number {
  let depth = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth > 0) continue;

    const trimmed = line.trim();
    if (trimmed.endsWith(';')) return i;

    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    const continues =
      trimmed.endsWith(',') ||
      trimmed.endsWith('\\') ||
      /\bfrom$/.test(trimmed) ||
      /^import(?:\s+type)?$/.test(trimmed) ||
      next === 'from' ||
      next.startsWith('from ') ||
      next.startsWith('from{') ||
      next.startsWith('} from') ||
      next.startsWith("'") ||
      next.startsWith('"');

    if (continues) continue;
    return i;
  }

  return lines.length - 1;
}

function hasImportBinding(content: string, name: string): boolean {
  const lines = content.split(/\r?\n/);
  const binding = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

  for (let i = 0; i < lines.length; i++) {
    if (!isImportStart(lines[i])) continue;
    const end = importStatementEnd(lines, i);
    if (binding.test(lines.slice(i, end + 1).join('\n'))) return true;
    i = end;
  }

  return false;
}

function findInsertionLine(lines: string[]): number {
  let insertion = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!isImportStart(lines[i])) continue;
    const end = importStatementEnd(lines, i);
    insertion = end + 1;
    i = end;
  }

  if (insertion > 0) return insertion;

  let start = 0;
  if (lines.length > 0 && lines[0].startsWith('#!')) start = 1;
  while (start < lines.length && DIRECTIVE_RE.test(lines[start].trim())) start++;
  return start;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function relativeModuleSpecifier(fromFile: string, toFile: string): string {
  const fromDirectory = normalizePath(fromFile).split('/').slice(0, -1);
  const target = normalizePath(toFile).split('/');
  const targetBase = target[target.length - 1] ?? '';
  const targetDirectory = target.slice(0, -1);

  let common = 0;
  while (
    common < fromDirectory.length &&
    common < targetDirectory.length &&
    fromDirectory[common] === targetDirectory[common]
  ) {
    common++;
  }

  const parts: string[] = [];
  for (let i = common; i < fromDirectory.length; i++) parts.push('..');
  parts.push(...targetDirectory.slice(common));

  const baseWithoutExtension = targetBase.replace(/\.(?:tsx?|jsx?|mjs)$/, '');
  if (baseWithoutExtension !== 'index') parts.push(baseWithoutExtension);

  let specifier = parts.join('/');
  if (!specifier) specifier = 'index';
  if (!specifier.startsWith('.')) specifier = './' + specifier;
  return specifier;
}

function buildImportStatement(
  symbol: string,
  kind: ExportEntry['kind'],
  specifier: string
): string {
  if (kind === 'default') return `import ${symbol} from '${specifier}';`;
  if (kind === 'type') return `import type { ${symbol} } from '${specifier}';`;
  return `import { ${symbol} } from '${specifier}';`;
}

export function planAutoImportFixes(
  diagnostics: DesktopDiagnostic[],
  files: WorkspaceTextFile[]
): AutoImportResult {
  const patches: FilePatch[] = [];
  const resolved: AutoImportResult['resolved'] = [];
  const unresolved: DesktopDiagnostic[] = [];
  const notes: string[] = [];
  const index = buildExportIndex(files);
  const fileByName = new Map<string, WorkspaceTextFile>();
  for (const file of files) fileByName.set(normalizePath(file.name), file);

  interface FilePlan {
    imports: Map<string, string>;
    resolved: Array<{ file: string; symbol: string; importPath: string }>;
  }
  const plans = new Map<string, FilePlan>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'TS2304') {
      unresolved.push(diagnostic);
      continue;
    }

    const messageMatch = diagnostic.message.match(DIAGNOSTIC_MESSAGE_RE);
    if (!messageMatch) {
      unresolved.push(diagnostic);
      continue;
    }
    const symbol = messageMatch[1];

    const diagnosticFile = fileByName.get(normalizePath(diagnostic.file));
    if (!diagnosticFile) {
      unresolved.push(diagnostic);
      notes.push(`No workspace file found for '${diagnostic.file}'.`);
      continue;
    }

    const candidates = index.get(symbol) ?? [];
    if (candidates.length === 0) {
      unresolved.push(diagnostic);
      notes.push(`No workspace export found for '${symbol}'.`);
      continue;
    }

    const candidateFiles = new Set<string>();
    for (const candidate of candidates) candidateFiles.add(normalizePath(candidate.file));
    if (candidateFiles.size > 1) {
      unresolved.push(diagnostic);
      notes.push(
        `Ambiguous import for '${symbol}': exported by ${Array.from(candidateFiles).join(', ')}.`
      );
      continue;
    }

    const normalizedCandidate = Array.from(candidateFiles)[0];
    if (normalizedCandidate === normalizePath(diagnostic.file)) {
      unresolved.push(diagnostic);
      notes.push(`'${symbol}' is declared in '${diagnostic.file}'; skipping self-import.`);
      continue;
    }

    if (hasImportBinding(diagnosticFile.content, symbol)) {
      notes.push(`'${symbol}' is already imported in '${diagnostic.file}'.`);
      continue;
    }

    let chosen = candidates[0];
    for (const candidate of candidates) {
      if (kindRank(candidate.kind) < kindRank(chosen.kind)) chosen = candidate;
    }

    const importPath = relativeModuleSpecifier(diagnostic.file, chosen.file);
    const statement = buildImportStatement(symbol, chosen.kind, importPath);

    let plan = plans.get(diagnosticFile.name);
    if (!plan) {
      plan = { imports: new Map(), resolved: [] };
      plans.set(diagnosticFile.name, plan);
    }
    if (plan.imports.has(symbol)) continue;

    plan.imports.set(symbol, statement);
    plan.resolved.push({ file: diagnostic.file, symbol, importPath });
  }

  for (const [fileName, plan] of Array.from(plans.entries())) {
    const file = fileByName.get(normalizePath(fileName));
    if (!file) continue;

    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const lines = file.content.split(/\r?\n/);
    const insertion = findInsertionLine(lines);
    const importLines = Array.from(plan.imports.values()).sort();
    const newContent = [
      ...lines.slice(0, insertion),
      ...importLines,
      ...lines.slice(insertion),
    ].join(eol);

    if (newContent === file.content) continue;

    patches.push({ path: file.name, content: newContent });
    resolved.push(...plan.resolved);
  }

  return { patches, resolved, unresolved, notes };
}

// ── Command failure classification ─────────────────────────────────────────────
// Heuristics adapted from aider (https://github.com/Aider-AI/aider, MIT License):
// aider/exceptions.py keeps an ordered table of failure signatures where each row
// carries a machine-readable name, a one-line human description and a `retry` flag
// ("will running it again possibly help?"), and aider/run_cmd.py collapses any
// OS-level launch failure into that table instead of guessing. Same shape here:
// first matching rule wins, retryable maps to aider's `retry`, and the unclassified
// tail is an explicit `unknown` rather than a silent pass.

export type CommandFailureClass =
  | 'missing-dependency'
  | 'test-assertion'
  | 'syntax'
  | 'permission'
  | 'network'
  | 'not-found'
  | 'timeout'
  | 'none'
  | 'unknown';

export interface CommandFailureInput {
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface CommandFailureClassification {
  /** Machine-readable bucket; safe to switch on. */
  class: CommandFailureClass;
  /** One line for a human, and the first line the repair prompt should read. */
  explanation: string;
  /** aider's `retry`: does simply running the same command again have a chance? */
  retryable: boolean;
  /** What the repair prompt should be told to look at, in priority order. */
  repairHints: string[];
  /** Rule id that matched, for tests and debugging. */
  rule: string;
  /** The output line that carried the signature, trimmed and clipped. */
  detail: string;
  command: string;
  exitCode: number | null;
}

interface FailureRule {
  id: string;
  class: CommandFailureClass;
  explanation: string;
  retryable: boolean;
  repairHints: string[];
  /** Exit codes the shell reserves for this failure. */
  codes?: number[];
  /** Matched case-insensitively against merged output; first hit wins. */
  patterns?: RegExp[];
}

const MAX_FAILURE_TEXT_LENGTH = 20000;
const MAX_FAILURE_DETAIL_LENGTH = 240;
const MAX_FAILURE_COMMAND_LENGTH = 240;

/**
 * Ordered signature table. Keep the specific signatures ahead of the generic
 * ones: a test run that died on an unresolvable import is a dependency problem,
 * not an assertion problem, so `missing-dependency` is matched first.
 */
const FAILURE_RULES: FailureRule[] = [
  {
    id: 'dependency',
    class: 'missing-dependency',
    explanation: 'A required module or package is not installed, so nothing else could run.',
    retryable: false,
    repairHints: [
      'install the exact package named in the error',
      'check package.json/pyproject against the lockfile before changing code',
      'confirm the import specifier matches the installed package name'
    ],
    patterns: [
      /cannot find module/i,
      /cannot find package/i,
      /modulenotfounderror/i,
      /err_module_not_found/i,
      /importerror:/i,
      /no module named/i,
      /no matching distribution found/i,
      /unable to locate package/i,
      /could not find artifact/i,
      /is not installed/i,
      /please install\b/i,
      /npm err!.*404 not found/i,
      /tl;dr: run `npm install/i
    ]
  },
  {
    id: 'permission',
    class: 'permission',
    explanation: 'The operating system refused the access the command asked for.',
    retryable: false,
    repairHints: [
      'the fix is permissions or a path, not the code under test',
      'prefer a user-writable path over asking for elevation',
      'check file ownership and the executable bit before retrying'
    ],
    codes: [126],
    patterns: [
      /\bepERM\b/i,
      /\beacces\b/i,
      /permission denied/i,
      /operation not permitted/i,
      /access is denied/i,
      /allowed only for superuser/i,
      /must be run as (?:root|administrator)/i,
      /\b401 unauthorized\b/i,
      /\b403 forbidden\b/i
    ]
  },
  {
    id: 'not-found',
    class: 'not-found',
    explanation: 'The shell could not find the command or file it was asked to run.',
    retryable: false,
    repairHints: [
      'use the tool name that is actually on PATH (or the project script)',
      'check the path separator and working directory in the command',
      'install or link the missing executable instead of editing code'
    ],
    codes: [127],
    patterns: [
      /command not found/i,
      /not found: command/i,
      /is not recognized as the name of a cmdlet/i,
      /is not an internal or external command/i,
      /unrecognized command/i,
      // POSIX shell shape only: `gcc: fatal error: stdio.h: No such file or
      // directory` and `cannot open shared object file` are a missing toolchain,
      // not a mistyped command.
      /^[\w./-]+: no such file or directory/im,
      /can't open file/i,
      /executable file not found/i,
      /unknown command\b/i
    ]
  },
  {
    id: 'network',
    class: 'network',
    explanation: 'A network call failed: the host or registry could not be reached.',
    retryable: true,
    repairHints: [
      'treat this as environmental; do not "fix" code for a connection failure',
      'retry once, then check proxy/DNS and whether the service is up',
      'verify the URL and port in the failing request'
    ],
    patterns: [
      /\beconnrefused\b/i,
      /\beconnreset\b/i,
      /\beconnaborted\b/i,
      /\benotfound\b.*\b(dns|getaddrinfo)\b/i,
      /\beai_again\b/i,
      /getaddrinfo/i,
      /socket hang up/i,
      /could not connect/i,
      /failed to connect to/i,
      /network is unreachable/i,
      /temporary failure in name resolution/i,
      /\bssl certificate\b/i,
      /self[- ]signed cert/i,
      /\bproxy (?:url|connection|authentication)\b/i,
      /\berror 6 \(couldnt resolve host\)/i
    ]
  },
  {
    id: 'timeout',
    class: 'timeout',
    explanation: 'The command ran out of time and was terminated.',
    retryable: true,
    repairHints: [
      'raise the timeout or narrow the work before changing code',
      'look for a hang: an interactive prompt, a watch mode, or a blocking server',
      'check memory limits if the process was killed rather than expired'
    ],
    codes: [124, 137, 143],
    patterns: [
      /timed out/i,
      /timeout of \d+ms exceeded/i,
      /(?:exceeded|reached) .*timeout/i,
      /\b(killed|out of memory|oom-killer)\b/i
    ]
  },
  {
    id: 'syntax',
    class: 'syntax',
    explanation: 'A file could not be parsed; the source is not valid for its language.',
    retryable: false,
    repairHints: [
      'repair the reported file and line first; nothing else runs until it parses',
      'check the delimiter or token named in the error',
      'verify the file was saved as the language its extension declares'
    ],
    patterns: [
      /syntaxerror/i,
      /syntax error/i,
      /invalid syntax/i,
      /unexpected token/i,
      /unexpected end of (?:input|file)/i,
      /unexpected eof/i,
      /unexpected \S+ while parsing/i,
      /parseerror/i,
      /indentationerror/i,
      /\berror ts1\d{3}\b/i,
      // Parser positions speak in `expected <token>, found <token>`; an
      // assertion says `expected <value> to be <value>`, so require the token
      // shape here and leave the value shape to the test rule below.
      /\bexpected declaration\b/i,
      /\bexpected ['"]?[\w;,.(){}[\]]{1,12}['"]?,? found\b/i
    ]
  },
  {
    id: 'test-assertion',
    class: 'test-assertion',
    explanation: 'The suite ran and at least one assertion failed.',
    retryable: false,
    repairHints: [
      'read the named failing test and the expected-vs-actual line before editing',
      'decide whether the assertion or the implementation is the stale one',
      'rerun only the failed test file to keep the loop short'
    ],
    patterns: [
      /assertionerror/i,
      /assertion failed/i,
      /\bexpected\b[\s\S]{0,80}\bto (?:be|equal|deeply? equal|throw|match)\b/i,
      /\btests?:.*\d+ failed/i,
      /\b\d+ failed\b[,)]/i,
      /^\s*(?:-+\s+)?(?:FAIL|FAILED)\b/mi,
      /\bnot ok \d+/i,
      /there (?:was|were) \d+ failure/i,
      /\bfailing tests?\b/i,
      /\btest failed\b/i
    ]
  }
];

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

function failureText(input: CommandFailureInput): string {
  const merged = [String(input.stdout ?? ''), String(input.stderr ?? '')].join('\n');
  const cleaned = stripAnsi(merged).replace(/\r/g, '');
  if (cleaned.length <= MAX_FAILURE_TEXT_LENGTH) return cleaned;
  // Tail matters more than head: the reason a command failed is printed last.
  return cleaned.slice(-MAX_FAILURE_TEXT_LENGTH);
}

function lineAt(text: string, index: number): string {
  // A pattern may start its match on whitespace (`^\s*FAIL`), which would
  // otherwise quote an empty line. Land on real content first.
  let at = index;
  while (at < text.length && /[\s]/.test(text[at]) && text[at] !== '\n') at += 1;
  if (text[at] === '\n') at += 1;
  const lineStart = text.lastIndexOf('\n', at > 0 ? at - 1 : 0) + 1;
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  return line.length <= MAX_FAILURE_DETAIL_LENGTH ? line : `${line.slice(0, MAX_FAILURE_DETAIL_LENGTH)}…`;
}

interface RuleMatch {
  matched: boolean;
  detail: string;
}

/**
 * Does any signature fire, and which line should be quoted back? The LAST line a
 * pattern matched, because tools print a generic code first and the real message
 * last; a signature that matches but spans no readable line still counts.
 */
function matchRule(text: string, patterns: RegExp[]): RuleMatch {
  if (!text) return { matched: false, detail: '' };
  let matched = false;
  for (const pattern of patterns) {
    if (!pattern.test(text)) continue;
    matched = true;
    const scan = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    let index = -1;
    for (const match of text.matchAll(scan)) index = match.index;
    if (index < 0) continue;
    const detail = lineAt(text, index);
    if (detail) return { matched: true, detail };
  }
  return { matched, detail: '' };
}

function normalizeExitCode(exitCode: number | null | undefined): number | null {
  return typeof exitCode === 'number' && Number.isFinite(exitCode) ? Math.trunc(exitCode) : null;
}

/**
 * Turns a finished command plus its output into a machine-readable failure class,
 * a one-line human explanation and the hints a repair prompt should be given.
 * Never throws and always answers: unrecognised output is an explicit `unknown`.
 */
export function classifyCommandFailure(input: CommandFailureInput): CommandFailureClassification {
  const command = String(input?.command ?? '').slice(0, MAX_FAILURE_COMMAND_LENGTH);
  const exitCode = normalizeExitCode(input?.exitCode);
  const text = failureText(input ?? { command: '', exitCode });

  if (exitCode === 0) {
    return {
      class: 'none',
      explanation: 'The command exited 0; there is no failure to explain.',
      retryable: false,
      repairHints: [],
      rule: 'success',
      detail: '',
      command,
      exitCode
    };
  }

  for (const rule of FAILURE_RULES) {
    const codeMatched = rule.codes ? rule.codes.includes(exitCode ?? NaN) : false;
    const hit = matchRule(text, rule.patterns ?? []);
    if (!codeMatched && !hit.matched) continue;
    return {
      class: rule.class,
      explanation: rule.explanation,
      retryable: rule.retryable,
      repairHints: [...rule.repairHints],
      rule: rule.id,
      detail: hit.detail,
      command,
      exitCode
    };
  }

  return {
    class: 'unknown',
    explanation: `Nothing matched a known failure signature (exit ${exitCode === null ? 'unknown' : exitCode}).`,
    retryable: false,
    repairHints: [
      'read the raw output tail; the cause is not a recognised signature',
      'ask for the command to be rerun with more verbose output'
    ],
    rule: 'unknown',
    detail: text.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, MAX_FAILURE_DETAIL_LENGTH) ?? '',
    command,
    exitCode
  };
}

/** One compact line for a status bar: `class · detail (exit N)`. */
export function formatCommandFailureLine(classification: CommandFailureClassification): string {
  const tail = classification.exitCode === null ? '' : ` (exit ${classification.exitCode})`;
  const detail = classification.detail ? ` · ${classification.detail}` : '';
  return `${classification.class}${detail}${tail}`;
}
