/**
 * Project-kind detection and verify-output parsing for the `verify` tool.
 *
 * Detection reads the project's own manifests — package.json scripts plus the
 * lockfile that names the package manager, pytest/cargo/go markers — and picks
 * the commands the project itself defines (typecheck before build before test).
 * Nothing is guessed: a folder with no manifest verifies through compiler
 * diagnostics alone.
 *
 * Parsing turns raw tool output into structured errors ({file, line, msg}) and
 * failed test names for the common runners: tsc (both formats), eslint-style
 * stylish output, pytest, jest/vitest, python tracebacks, cargo and go.
 *
 * Pure functions: the tool layer does the disk reads and command runs.
 */

export interface VerifyError {
  file: string;
  line: number;
  msg: string;
}

export interface VerifyReport {
  ok: boolean;
  errors: VerifyError[];
  failedTests: string[];
  commandsRun: string[];
}

export interface VerifyPlan {
  kind: 'node' | 'python' | 'rust' | 'go' | 'unknown';
  packageManager: string | null;
  commands: string[];
}

const LOCKFILE_MANAGERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn']
];

/** Scripts preferred in this order; only the ones the project actually defines run. */
const SCRIPT_PREFERENCE = ['typecheck', 'type-check', 'tsc', 'build', 'test', 'lint'];

export interface ProjectManifests {
  /** Raw package.json text, or null when absent/unreadable. */
  packageJson: string | null;
  /** Root-level file names (lockfiles, pytest.ini, Cargo.toml, go.mod, ...). */
  rootEntries: string[];
}

export function planVerification(manifests: ProjectManifests): VerifyPlan {
  const entries = new Set(manifests.rootEntries);
  if (manifests.packageJson !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(manifests.packageJson) as { scripts?: Record<string, unknown> };
      if (parsed && typeof parsed.scripts === 'object' && parsed.scripts) scripts = parsed.scripts;
    } catch {
      /* a malformed package.json still means "node project, no scripts" */
    }
    const manager = LOCKFILE_MANAGERS.find(([lockfile]) => entries.has(lockfile))?.[1] ?? 'npm';
    const chosen: string[] = [];
    for (const name of SCRIPT_PREFERENCE) {
      if (typeof scripts[name] === 'string' && (scripts[name] as string).trim()) chosen.push(name);
    }
    // typecheck and build are redundant on most projects; keep at most two
    // commands plus test, so a verify call stays inside one tool round.
    const commands = chosen.slice(0, 3).map((script) => `${manager} run ${script}`);
    return { kind: 'node', packageManager: manager, commands };
  }
  if (entries.has('Cargo.toml')) {
    return { kind: 'rust', packageManager: null, commands: ['cargo check --quiet', 'cargo test --quiet'] };
  }
  if (entries.has('go.mod')) {
    return { kind: 'go', packageManager: null, commands: ['go build ./...', 'go vet ./...'] };
  }
  if (entries.has('pytest.ini') || entries.has('pyproject.toml') || entries.has('setup.cfg') || entries.has('requirements.txt') || entries.has('setup.py')) {
    return { kind: 'python', packageManager: null, commands: ['python -m pytest -x -q'] };
  }
  return { kind: 'unknown', packageManager: null, commands: [] };
}

/** A run_command line that counts as verification when it exits for real. */
export const VERIFY_COMMAND_PATTERN =
  /\b(typecheck|type-check|tsc|vitest|jest|pytest|cargo\s+(check|test|build|clippy)|go\s+(vet|test|build)|npm\s+(run\s+)?(build|test|lint)|pnpm\s+(run\s+)?(build|test|lint|typecheck)|yarn\s+(build|test|lint|typecheck)|bun\s+(run\s+)?(build|test)|eslint|flake8|mypy|ruff)\b/i;

export function isVerifyCommand(command: string): boolean {
  return VERIFY_COMMAND_PATTERN.test(command);
}

const MAX_PARSED_ERRORS = 60;
const MAX_FAILED_TESTS = 30;

/**
 * Structured errors out of raw compiler/runner output. Line numbers are
 * normalized to 1-based, matching what the model sees in read_file.
 */
export function parseVerifyOutput(text: string): { errors: VerifyError[]; failedTests: string[] } {
  const errors: VerifyError[] = [];
  const failedTests: string[] = [];
  const pushError = (file: string, line: number, msg: string): void => {
    if (errors.length >= MAX_PARSED_ERRORS) return;
    const clean = file.replace(/\\/g, '/').trim();
    if (!clean) return;
    errors.push({ file: clean, line: Math.max(1, line), msg: msg.trim().slice(0, 300) });
  };
  const pushTest = (name: string): void => {
    const clean = name.trim();
    if (clean && failedTests.length < MAX_FAILED_TESTS && !failedTests.includes(clean)) failedTests.push(clean);
  };

  // tsc classic: src/a.ts(12,5): error TS2322: Type 'string' is not assignable...
  for (const match of text.matchAll(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+:.*)$/gm)) {
    pushError(match[1], Number(match[2]), match[4]);
  }
  // tsc pretty / esbuild: src/a.ts:12:5 - error TS2322: ...
  for (const match of text.matchAll(/^(.+?):(\d+):(\d+)\s*-\s*error\s+(.*)$/gm)) {
    pushError(match[1], Number(match[2]), match[3]);
  }
  // eslint stylish: a file header line, then "  12:5  error  message  rule".
  let currentFile = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^([A-Za-z]:[\\/][^\s].*|\/[^\s].*|[^\s][^\s]*\.[cm]?[jt]sx?)\s*$/);
    if (header) {
      currentFile = header[1];
      continue;
    }
    const stylish = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.*)$/);
    if (stylish && currentFile && stylish[3] === 'error') {
      pushError(currentFile, Number(stylish[1]), stylish[4]);
    }
  }
  // go: ./main.go:12:5: message
  for (const match of text.matchAll(/^(\.?\/?[^\s:]+\.go):(\d+):(\d+):\s*(.*)$/gm)) {
    pushError(match[1], Number(match[2]), match[4]);
  }
  // cargo: "  --> src/main.rs:12:5"
  for (const match of text.matchAll(/^\s*-->\s*([^:\s]+):(\d+):(\d+)/gm)) {
    pushError(match[1], Number(match[2]), 'cargo error');
  }
  // python traceback: File "app.py", line 12
  for (const match of text.matchAll(/File "([^"]+)", line (\d+)/g)) {
    pushError(match[1], Number(match[2]), 'traceback frame');
  }
  // pytest: FAILED tests/test_x.py::test_case - assert ...
  for (const match of text.matchAll(/^FAILED\s+(\S+)/gm)) pushTest(match[1]);
  for (const match of text.matchAll(/^(\S+\.py):(\d+):\s*(.*)$/gm)) pushError(match[1], Number(match[2]), match[3]);
  // jest / vitest: "FAIL src/a.test.ts" and "✕ does the thing (3 ms)"
  for (const match of text.matchAll(/^\s*(?:FAIL|✕|×)\s+(\S.*)$/gm)) {
    const name = match[1].trim();
    if (/FAIL/.test(match[0])) pushTest(name);
    else pushTest(name.replace(/\s*\(\d+\s*ms\)\s*$/, ''));
  }

  return { errors, failedTests };
}

/** The structured text a verify outcome carries; the model and the UI both read it. */
export function formatVerifyReport(report: VerifyReport, kind: VerifyPlan['kind']): string {
  const lines = [
    `verify: ${report.ok ? 'OK' : 'FAILED'} (project kind: ${kind})`,
    `commands run: ${report.commandsRun.length > 0 ? report.commandsRun.join(' && ') : '(none — no project manifest; compiler diagnostics only)'}`
  ];
  if (report.errors.length > 0) {
    lines.push(`errors (${report.errors.length}):`);
    for (const error of report.errors.slice(0, 40)) lines.push(`  ${error.file}:${error.line} ${error.msg}`);
  }
  if (report.failedTests.length > 0) {
    lines.push(`failed tests (${report.failedTests.length}):`);
    for (const test of report.failedTests.slice(0, 20)) lines.push(`  ${test}`);
  }
  if (report.ok) lines.push('All checks passed. You may call finish with "verified": true.');
  else lines.push('Fix the errors above, then run verify again before finishing.');
  return lines.join('\n');
}