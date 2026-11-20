import assert from 'node:assert/strict';
import test from 'node:test';
import { planVerification, parseVerifyOutput, formatVerifyReport, isVerifyCommand } from './verifyProject';

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

test('a node project picks its package manager from the lockfile', () => {
  assert.equal(planVerification({ packageJson: pkg({ build: 'vite build' }), rootEntries: ['pnpm-lock.yaml'] }).packageManager, 'pnpm');
  assert.equal(planVerification({ packageJson: pkg({ build: 'vite build' }), rootEntries: ['bun.lockb'] }).packageManager, 'bun');
  assert.equal(planVerification({ packageJson: pkg({ build: 'vite build' }), rootEntries: ['yarn.lock'] }).packageManager, 'yarn');
  assert.equal(planVerification({ packageJson: pkg({ build: 'vite build' }), rootEntries: ['package-lock.json'] }).packageManager, 'npm');
});

test('scripts run in preference order: typecheck before build before test, at most three', () => {
  const plan = planVerification({
    packageJson: pkg({ test: 'vitest', build: 'vite build', typecheck: 'tsc --noEmit', lint: 'eslint .' }),
    rootEntries: []
  });
  assert.equal(plan.kind, 'node');
  assert.deepEqual(plan.commands, ['npm run typecheck', 'npm run build', 'npm run test']);
});

test('only the scripts the project actually defines run', () => {
  const plan = planVerification({ packageJson: pkg({ build: 'vite build' }), rootEntries: [] });
  assert.deepEqual(plan.commands, ['npm run build']);
});

test('a malformed package.json is still a node project with no scripts', () => {
  const plan = planVerification({ packageJson: '{not json', rootEntries: [] });
  assert.equal(plan.kind, 'node');
  assert.deepEqual(plan.commands, []);
});

test('rust, go and python projects are detected from their markers', () => {
  assert.equal(planVerification({ packageJson: null, rootEntries: ['Cargo.toml'] }).kind, 'rust');
  assert.deepEqual(planVerification({ packageJson: null, rootEntries: ['go.mod'] }).commands, ['go build ./...', 'go vet ./...']);
  assert.equal(planVerification({ packageJson: null, rootEntries: ['pytest.ini'] }).kind, 'python');
  assert.deepEqual(planVerification({ packageJson: null, rootEntries: ['requirements.txt'] }).commands, ['python -m pytest -x -q']);
});

test('a folder with no manifest verifies through diagnostics alone', () => {
  const plan = planVerification({ packageJson: null, rootEntries: ['index.html', 'styles.css'] });
  assert.equal(plan.kind, 'unknown');
  assert.deepEqual(plan.commands, []);
});

test('isVerifyCommand recognizes build/test/typecheck lines, not arbitrary commands', () => {
  assert.equal(isVerifyCommand('npm run typecheck'), true);
  assert.equal(isVerifyCommand('pnpm build'), true);
  assert.equal(isVerifyCommand('python -m pytest -q'), true);
  assert.equal(isVerifyCommand('cargo test'), true);
  assert.equal(isVerifyCommand('go vet ./...'), true);
  assert.equal(isVerifyCommand('npx tsc --noEmit'), true);
  assert.equal(isVerifyCommand('echo hello'), false);
  assert.equal(isVerifyCommand('rm -rf dist'), false);
});

test('tsc classic and pretty errors parse to file:line:message', () => {
  const classic = parseVerifyOutput("src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.deepEqual(classic.errors[0], { file: 'src/a.ts', line: 12, msg: "TS2322: Type 'string' is not assignable to type 'number'." });
  const pretty = parseVerifyOutput('src/b.ts:7:1 - error TS2304: Cannot find name foo.');
  assert.equal(pretty.errors[0].file, 'src/b.ts');
  assert.equal(pretty.errors[0].line, 7);
});

test('eslint stylish output parses under its file header', () => {
  const text = 'src/a.ts\n  12:5  error  Unexpected var  no-var\n  20:1  warning  Missing semicolon  semi';
  const parsed = parseVerifyOutput(text);
  assert.equal(parsed.errors.length, 1, 'warnings are not errors');
  assert.equal(parsed.errors[0].file, 'src/a.ts');
  assert.equal(parsed.errors[0].line, 12);
});

test('pytest failures and jest failures parse to failed test names', () => {
  const pytest = parseVerifyOutput('FAILED tests/test_x.py::test_case - assert 1 == 2');
  assert.deepEqual(pytest.failedTests, ['tests/test_x.py::test_case']);
  const jest = parseVerifyOutput('FAIL src/a.test.ts\n  ✕ does the thing (3 ms)');
  assert.ok(jest.failedTests.includes('src/a.test.ts'));
  assert.ok(jest.failedTests.includes('does the thing'), 'the timing suffix is stripped');
});

test('cargo and go errors parse', () => {
  assert.equal(parseVerifyOutput('  --> src/main.rs:12:5').errors[0].file, 'src/main.rs');
  assert.equal(parseVerifyOutput('./main.go:9:2: undefined: foo').errors[0].line, 9);
});

test('formatVerifyReport renders ok and failed states with the next step', () => {
  const ok = formatVerifyReport({ ok: true, errors: [], failedTests: [], commandsRun: ['npm run build'] }, 'node');
  assert.match(ok, /verify: OK \(project kind: node\)/);
  assert.match(ok, /"verified": true/);
  const failed = formatVerifyReport({ ok: false, errors: [{ file: 'a.ts', line: 3, msg: 'boom' }], failedTests: ['t1'], commandsRun: ['npm test'] }, 'node');
  assert.match(failed, /verify: FAILED/);
  assert.match(failed, /a\.ts:3 boom/);
  assert.match(failed, /t1/);
  assert.match(failed, /run verify again/);
});