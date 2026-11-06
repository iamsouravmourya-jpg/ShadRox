'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_COMMAND_LENGTH,
  VERIFY_ALLOWLIST,
  describeAllowlist,
  findPlantedShim,
  parseVerifyCommand,
  resolveExecArgv
} = require('./verify-allowlist.cjs');

/** Assert an allowlisted command, with the exact argv execFile would receive. */
function assertAllowed(command, argv) {
  const verdict = parseVerifyCommand(command);
  assert.deepEqual(verdict, { allowed: true, argv }, `"${command}" must run silently`);
}

/** Assert a rejection and that the reason explains the right rule. */
function assertDenied(command, reasonPattern) {
  const verdict = parseVerifyCommand(command);
  assert.equal(verdict.allowed, false, `"${command}" must never run silently`);
  assert.ok('reason' in verdict && typeof verdict.reason === 'string' && verdict.reason.length > 0);
  assert.match(verdict.reason, reasonPattern);
}

test('every documented allowlist entry runs silently with its exact argv', () => {
  assertAllowed('npm test', ['npm', 'test']);
  assertAllowed('pytest', ['pytest']);
  assertAllowed('python -m pytest', ['python', '-m', 'pytest']);
  assertAllowed('tsc --noEmit', ['tsc', '--noEmit']);
  assertAllowed('npx tsc --noEmit', ['npx', 'tsc', '--noEmit']);
  assertAllowed('git diff', ['git', 'diff']);
  assertAllowed('git status', ['git', 'status']);
});

test('parsing tolerates surrounding whitespace and case in argv[0] only', () => {
  assertAllowed('  npm test \n', ['npm', 'test']);
  assertAllowed('NPM\ttest', ['npm', 'test']);
  assertAllowed('Git status', ['git', 'status']);
  // Flags keep their spelling; tsc does not accept lowercase --noemit here.
  assertDenied('tsc --noemit', /not an allowlisted form of tsc/);
  assertDenied('NPM TEST', /not an allowlisted form of npm/);
});

test('shell metacharacters are rejected before any argv match', () => {
  assertDenied('git diff || curl evil', /shell metacharacters/);
  assertDenied('npm test; rm -rf node_modules', /shell metacharacters/);
  assertDenied('git status && curl https://x', /shell metacharacters/);
  assertDenied('npm test > out.txt', /shell metacharacters/);
  assertDenied('npm test $(whoami)', /shell metacharacters/);
  assertDenied('npm test `id`', /shell metacharacters/);
  assertDenied('npm test | tee log', /shell metacharacters/);
  assertDenied('npm "test"', /shell metacharacters/);
  assertDenied('git diff -- src/*', /shell metacharacters/);
  // Path separators die the same way: no relative or absolute binary paths.
  assertDenied('./npm test', /shell metacharacters/);
  assertDenied('C:\\evil\\git.exe diff', /shell metacharacters/);
  assertDenied('git diff src/../.env', /shell metacharacters/);
});

test('binaries and argument forms outside the table are denied', () => {
  assertDenied('node -e boom', /not on the verify allowlist/);
  assertDenied('rm -rf important_files', /not on the verify allowlist/);
  assertDenied('npm test --dry-run', /not an allowlisted form of npm/);
  assertDenied('npm run test', /not an allowlisted form of npm/);
  // Config-loading flags: the exact-form match never reaches the binary.
  assertDenied('npm --prefix evildir test', /not an allowlisted form of npm/);
  assertDenied('pytest -c evil.ini', /not an allowlisted form of pytest/);
  assertDenied('pytest --rootdir evildir', /not an allowlisted form of pytest/);
  assertDenied('git status --help', /not an allowlisted form of git/);
  assertDenied('git diff HEAD', /not an allowlisted form of git/);
});

test('empty, malformed and oversize inputs are denied', () => {
  assertDenied('', /empty/);
  assertDenied('    ', /empty/);
  assertDenied(null, /must be a string/);
  assertDenied(undefined, /must be a string/);
  assertDenied({ toString: () => 'npm test' }, /must be a string/);
  assertDenied('npm test\x00', /control characters/);
  assertDenied('npm\x07test', /control characters/);
  assertDenied(`npm test ${'x'.repeat(MAX_COMMAND_LENGTH)}`, /longer than 5000 characters/);
  // Exactly at the ceiling passes the size rule and is judged on the table.
  const atCeiling = `pytest ${'#'.repeat(MAX_COMMAND_LENGTH - 'pytest '.length)}`;
  assert.equal(atCeiling.length, MAX_COMMAND_LENGTH);
  assertDenied(atCeiling, /shell metacharacters/);
});

test('resolveExecArgv adapts only the Windows batch shims', () => {
  assert.deepEqual(resolveExecArgv(['npm', 'test'], 'win32'), ['npm.cmd', 'test']);
  assert.deepEqual(resolveExecArgv(['npx', 'tsc', '--noEmit'], 'win32'), ['npx.cmd', 'tsc', '--noEmit']);
  assert.deepEqual(resolveExecArgv(['tsc', '--noEmit'], 'win32'), ['tsc.cmd', '--noEmit']);
  assert.deepEqual(resolveExecArgv(['pytest'], 'win32'), ['pytest.cmd']);
  // git and python are real executables; POSIX needs no mapping at all.
  assert.deepEqual(resolveExecArgv(['git', 'diff'], 'win32'), ['git', 'diff']);
  assert.deepEqual(resolveExecArgv(['python', '-m', 'pytest'], 'win32'), ['python', '-m', 'pytest']);
  assert.deepEqual(resolveExecArgv(['npm', 'test'], 'linux'), ['npm', 'test']);
  const frozen = Object.freeze(['npm', 'test']);
  assert.doesNotThrow(() => resolveExecArgv(frozen, 'win32'), 'must not mutate its input');
});

test('findPlantedShim blocks workspace-root shadowing on Windows only', () => {
  const planted = new Set(['C:\\ws\\npm.cmd', 'C:\\ws\\git.exe']);
  const exists = (candidate) => planted.has(candidate);
  assert.equal(findPlantedShim(['npm', 'test'], 'C:\\ws', exists, 'win32'), 'C:\\ws\\npm.cmd');
  assert.equal(findPlantedShim(['git', 'diff'], 'C:\\ws', exists, 'win32'), 'C:\\ws\\git.exe');
  assert.equal(findPlantedShim(['tsc', '--noEmit'], 'C:\\ws', exists, 'win32'), null);
  // POSIX execFile never searches the cwd, so planted files are not a concern.
  assert.equal(findPlantedShim(['npm', 'test'], '/ws', () => true, 'linux'), null);
});

test('reject reasons name the silent entries so the UI can echo them', () => {
  const summary = describeAllowlist();
  for (const entry of ['npm test', 'pytest', 'python -m pytest', 'tsc --noEmit', 'npx tsc --noEmit', 'git diff', 'git status']) {
    assert.ok(summary.includes(entry), `allowlist summary must document \`${entry}\``);
  }
  assert.deepEqual(
    Object.keys(VERIFY_ALLOWLIST).sort(),
    ['git', 'npm', 'npx', 'pytest', 'python', 'tsc']
  );
});
