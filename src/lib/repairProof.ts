/**
 * Self-Healing Proof Engine (Phase 3D Signature Flagship Feature)
 * Automatically captures runtime failure contexts (stack traces, exit codes, DOM assertions, diffs)
 * into immutable failure receipts and coordinates atomic self-healing repair proposals.
 */

export type FailureSource = 'test' | 'preview' | 'verify' | 'compiler' | 'terminal';

export type RepairProofStatus =
  | 'captured'
  | 'repair_proposed'
  | 'repair_applied'
  | 'verified_healed'
  | 'healing_failed'
  | 'rejected';

export interface FailureReceipt {
  id: string;
  source: FailureSource;
  target: string;
  timestamp: number;
  exitCode: number | null;
  errorMessage: string;
  stackTrace?: string;
  diagnostics?: Array<{ file: string; line: number; message: string; severity?: string }>;
  consoleErrors?: string[];
  /**
   * Stopped debugger frame plus bounded locals, captured by the debugger UI
   * when a session pauses on an exception. Renderer-side evidence only: the
   * main process already bounded it, and `buildRepairBrief` bounds it again.
   */
  runtime?: {
    frames: Array<{ name: string; file?: string; line?: number; column?: number }>;
    scopes?: Array<{ name: string; variables: Array<{ name: string; value: string; type?: string }> }>;
  };
  relevantFiles: string[];
  diffSummary?: string;
  checkpointId?: string;
  status: RepairProofStatus;
  repairPatch?: string;
  healedAt?: number;
  verificationEvidence?: string;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const TEST_BINARIES = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test', 'ava', 'tap']);
const COMPILER_BINARIES = new Set(['tsc', 'eslint', 'stylelint']);
/** Flags whose next token is a value, not the verb/script of the command. */
const FLAGS_WITH_VALUE = new Set(['--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '-F']);
const SHELL_PREFIXES = new Set(['sudo', 'env', 'time', 'exec', 'command', 'nohup']);

/** Splits a one-line shell command into words, honoring simple quoting. */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function stripShellPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || SHELL_PREFIXES.has(token)) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function commandSegments(command: string): string[][] {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => stripShellPrefixes(tokenizeSegment(segment)));
}

function binaryName(token: string | undefined): string {
  if (!token) return '';
  const withoutQuotes = token.replace(/^["']|["']$/g, '');
  const parts = withoutQuotes.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}

function sourceForScript(script: string | undefined): FailureSource | null {
  if (!script) return null;
  const name = script.toLowerCase();
  if (name === 'test' || name === 'tests' || name.startsWith('test:') || name.startsWith('test-')) return 'test';
  if (name === 'typecheck' || name === 'type-check' || name.startsWith('typecheck:') || name.startsWith('build') || name.startsWith('lint') || name.startsWith('compile')) return 'compiler';
  return null;
}

function positionalArgs(tokens: string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positional.push(token);
  }
  return positional;
}

function sourceForBinary(binary: string, args: string[]): FailureSource | null {
  if (!binary) return null;
  if (binary === 'node' || binary === 'nodejs') {
    return args.some((arg) => arg === '--test' || arg.startsWith('--test-')) ? 'test' : null;
  }
  if (binary === 'deno') {
    const verb = args.find((arg) => !arg.startsWith('-'));
    if (verb === 'test') return 'test';
    if (verb === 'check' || verb === 'lint') return 'compiler';
    return null;
  }
  if (binary === 'python' || binary === 'python3' || binary === 'py') {
    const moduleIndex = args.indexOf('-m');
    if (moduleIndex < 0) return null;
    const module = binaryName(args[moduleIndex + 1]);
    if (module === 'pytest' || module === 'unittest' || module === 'nose2') return 'test';
    if (module === 'mypy' || module === 'py_compile' || module === 'compileall') return 'compiler';
    return null;
  }
  if (binary === 'playwright') return args.includes('test') ? 'test' : null;
  if (TEST_BINARIES.has(binary)) return 'test';
  if (COMPILER_BINARIES.has(binary)) return 'compiler';
  if (binary === 'cargo' || binary === 'go' || binary === 'dotnet') {
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (sub === 'test' || sub === 'bench') return 'test';
    if (sub === 'build' || sub === 'check' || sub === 'clippy' || sub === 'vet') return 'compiler';
    return null;
  }
  if (binary === 'vite' || binary === 'next' || binary === 'nuxt' || binary === 'webpack') {
    return args.includes('build') || args.includes('bundle') ? 'compiler' : null;
  }
  return null;
}

function sourceForSegment(tokens: string[]): FailureSource | null {
  const head = binaryName(tokens[0]);
  if (!head) return null;

  if (PACKAGE_RUNNERS.has(head)) {
    const positional = tokens.slice(1).filter((token) => !token.startsWith('-'));
    if (positional.length === 0) return null;
    return sourceForBinary(binaryName(positional[0]), positional.slice(1));
  }

  if (PACKAGE_MANAGERS.has(head)) {
    const positional = positionalArgs(tokens.slice(1));
    const verb = positional[0];
    if (!verb) return null;
    if (verb === 'test' || verb === 't') return 'test';
    if (verb === 'run' || verb === 'run-script') return sourceForScript(positional[1]);
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      if (positional.length < 2) return null;
      return sourceForBinary(binaryName(positional[1]), positional.slice(2));
    }
    // Yarn/pnpm scripts can be invoked without `run` (`yarn build`).
    return sourceForScript(verb);
  }

  return sourceForBinary(head, tokens.slice(1));
}

/**
 * Classifies a command the agent wants to run, so a failed receipt names the
 * right kind of check instead of calling everything 'terminal'.
 *
 * Test runners win over compilers when one command does both (`npm run build &&
 * npm test`): the strongest signal of "this proves behaviour" is the test run.
 */
export function failureSourceForCommand(command: string): FailureSource {
  const sources = commandSegments(command).map(sourceForSegment);
  if (sources.includes('test')) return 'test';
  if (sources.includes('compiler')) return 'compiler';
  return 'terminal';
}

export function createFailureReceipt(params: {
  source: FailureSource;
  target: string;
  errorMessage: string;
  exitCode?: number | null;
  stackTrace?: string;
  diagnostics?: Array<{ file: string; line: number; message: string; severity?: string }>;
  consoleErrors?: string[];
  relevantFiles?: string[];
  diffSummary?: string;
  checkpointId?: string;
}): FailureReceipt {
  return {
    id: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: params.source,
    target: params.target,
    timestamp: Date.now(),
    exitCode: params.exitCode ?? null,
    errorMessage: params.errorMessage.trim(),
    stackTrace: params.stackTrace?.trim(),
    diagnostics: params.diagnostics ? [...params.diagnostics] : [],
    consoleErrors: params.consoleErrors ? [...params.consoleErrors] : [],
    relevantFiles: params.relevantFiles ? Array.from(new Set(params.relevantFiles)) : [],
    diffSummary: params.diffSummary,
    checkpointId: params.checkpointId,
    status: 'captured'
  };
}

/**
 * Bounds for runtime evidence in a repair brief. Deliberately tighter than the
 * debugger UI: a prompt needs the first frames and a handful of locals, not a
 * whole heap dump.
 */
const RUNTIME_FRAME_LIMIT = 20;
const RUNTIME_SCOPE_LIMIT = 3;
const RUNTIME_VARIABLE_LIMIT = 30;
const RUNTIME_VALUE_CHARS = 200;

/**
 * A debuggee value can contain anything, including text that imitates the
 * untrusted-data fence. Neutralise the markers so a value can never close the
 * boundary early, then flatten to one line.
 */
function clipRuntimeText(value: string, max: number): string {
  const escaped = String(value ?? '')
    .replace(/--- (BEGIN|END) DATA ---/g, '-- $1 DATA --')
    .replace(/\[\[SHADROX_UNTRUSTED_DATA_(BEGIN|END)\]\]/g, '[[SHADROX_UNTRUSTED_DATA_$1_ESCAPED]]')
    .replace(/\s+/g, ' ')
    .trim();
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`;
}

function formatRuntime(runtime: NonNullable<FailureReceipt['runtime']>): string | null {
  const frames = runtime.frames ?? [];
  if (frames.length === 0) return null;
  const lines: string[] = ['FRAMES:'];
  frames.slice(0, RUNTIME_FRAME_LIMIT).forEach((frame, index) => {
    const location = [
      frame.file ? clipRuntimeText(frame.file, RUNTIME_VALUE_CHARS) : '(external)',
      frame.line ?? null,
      frame.column ?? null
    ]
      .filter((part) => part !== null)
      .join(':');
    lines.push(`  #${index} ${clipRuntimeText(frame.name, RUNTIME_VALUE_CHARS)} (${location})`);
  });

  const scopes = (runtime.scopes ?? []).slice(0, RUNTIME_SCOPE_LIMIT);
  if (scopes.length > 0) {
    lines.push('SCOPES (stopped frame):');
    for (const scope of scopes) {
      lines.push(`  ${clipRuntimeText(scope.name, RUNTIME_VALUE_CHARS)}`);
      for (const variable of (scope.variables ?? []).slice(0, RUNTIME_VARIABLE_LIMIT)) {
        const name = clipRuntimeText(variable.name, RUNTIME_VALUE_CHARS);
        const value = clipRuntimeText(variable.value, RUNTIME_VALUE_CHARS);
        const type = variable.type ? ` [${clipRuntimeText(variable.type, 100)}]` : '';
        lines.push(`    ${name} = ${value}${type}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Builds an untrusted-data wrapped repair brief prompt for the agent
 */
export function buildRepairBrief(receipt: FailureReceipt): string {
  const sections: string[] = [];

  sections.push(`[SELF-HEALING PROOF RECEIPT: ${receipt.id}]`);
  sections.push(`SOURCE: ${receipt.source.toUpperCase()} (${receipt.target})`);
  if (receipt.exitCode !== null) {
    sections.push(`EXIT CODE: ${receipt.exitCode}`);
  }
  sections.push(`PRIMARY ERROR:\n${receipt.errorMessage}`);

  if (receipt.stackTrace) {
    sections.push(`STACK TRACE (UNTRUSTED-DATA):\n--- BEGIN DATA ---\n${receipt.stackTrace.slice(0, 2048)}\n--- END DATA ---`);
  }

  if (receipt.diagnostics && receipt.diagnostics.length > 0) {
    const diagLines = receipt.diagnostics
      .slice(0, 10)
      .map((d) => `  ${d.file}:${d.line} - [${d.severity || 'error'}] ${d.message}`)
      .join('\n');
    sections.push(`COMPILER DIAGNOSTICS:\n${diagLines}`);
  }

  if (receipt.consoleErrors && receipt.consoleErrors.length > 0) {
    const errorLines = receipt.consoleErrors.slice(0, 5).join('\n');
    sections.push(`CONSOLE ERRORS (UNTRUSTED-DATA):\n--- BEGIN DATA ---\n${errorLines}\n--- END DATA ---`);
  }

  if (receipt.runtime) {
    const runtime = formatRuntime(receipt.runtime);
    if (runtime) {
      sections.push(`RUNTIME STATE AT FAILURE (UNTRUSTED-DATA):\n--- BEGIN DATA ---\n${runtime}\n--- END DATA ---`);
    }
  }

  if (receipt.relevantFiles.length > 0) {
    sections.push(`AFFECTED FILES:\n${receipt.relevantFiles.join(', ')}`);
  }

  if (receipt.diffSummary) {
    sections.push(`RECENT DIFF SUMMARY:\n${receipt.diffSummary.slice(0, 1024)}`);
  }

  sections.push(`INSTRUCTION: Analyze the exact root cause above. Propose a surgical patch to heal the failure without altering unrelated code.`);

  return sections.join('\n\n');
}

/**
 * Attaches a proposed patch to the receipt
 */
export function proposeRepair(receipt: FailureReceipt, patch: string): FailureReceipt {
  if (receipt.status !== 'captured' && receipt.status !== 'healing_failed') {
    throw new Error(`Cannot propose repair for receipt with status ${receipt.status}`);
  }
  return {
    ...receipt,
    status: 'repair_proposed',
    repairPatch: patch
  };
}

/**
 * Verifies whether the repair healed the failure
 */
export function verifyHealing(
  receipt: FailureReceipt,
  outcome: {
    clean: boolean;
    exitCode?: number | null;
    evidenceMessage?: string;
  }
): FailureReceipt {
  if (receipt.status !== 'repair_proposed' && receipt.status !== 'repair_applied') {
    throw new Error(`Cannot verify healing for receipt in status ${receipt.status}`);
  }

  if (outcome.clean) {
    return {
      ...receipt,
      status: 'verified_healed',
      healedAt: Date.now(),
      verificationEvidence: outcome.evidenceMessage || 'All verification checks passed cleanly.'
    };
  }

  return {
    ...receipt,
    status: 'healing_failed',
    verificationEvidence: outcome.evidenceMessage || `Healing verification failed with exit code ${outcome.exitCode}`
  };
}
