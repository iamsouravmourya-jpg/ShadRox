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

test('pretty tsc keeps error message and Next.js / Vite / module resolution errors parse cleanly', () => {
  const pretty = parseVerifyOutput("src/b.ts:7:1 - error TS2304: Cannot find name 'foo'.");
  assert.equal(pretty.errors[0].msg, "TS2304: Cannot find name 'foo'.");

  const nextErr = parseVerifyOutput('./src/app/page.tsx:14:9\nType error: Property \'title\' does not exist on type \'{}\'.');
  assert.equal(nextErr.errors[0].file, './src/app/page.tsx');
  assert.equal(nextErr.errors[0].line, 14);
  assert.match(nextErr.errors[0].msg, /Type error: Property 'title'/);

  const viteErr = parseVerifyOutput('file: src/App.tsx:22:3');
  assert.equal(viteErr.errors[0].file, 'src/App.tsx');
  assert.equal(viteErr.errors[0].line, 22);

  const missingMod = parseVerifyOutput("Error: Cannot find module './missing'\nModule not found: Can't resolve 'lucide-react' in 'src/components'");
  assert.ok(missingMod.errors.some((e) => e.msg.includes("Cannot find module './missing'")));
  assert.ok(missingMod.errors.some((e) => e.file === 'src/components' && e.msg.includes("Cannot resolve module 'lucide-react'")));
});

test('formatVerifyReport omits raw internal agent directives when includeAgentDirective is false', () => {
  const ok = formatVerifyReport(
    { ok: true, errors: [], failedTests: [], commandsRun: ['npm run build'] },
    'node',
    { includeAgentDirective: false }
  );
  assert.match(ok, /verify: OK/);
  assert.doesNotMatch(ok, /You may call finish/);

  const failed = formatVerifyReport(
    { ok: false, errors: [{ file: 'a.ts', line: 3, msg: 'boom' }], failedTests: [], commandsRun: ['npm test'] },
    'node',
    { includeAgentDirective: false }
  );
  assert.match(failed, /verify: FAILED/);
  assert.doesNotMatch(failed, /run verify again before finishing/);
});

test('nonInteractive planVerification converts watch-mode vitest/jest to single-run commands while leaving explicit run intact', () => {
  const vitestWatch = planVerification(
    { packageJson: pkg({ typecheck: 'tsc --noEmit', test: 'vitest' }), rootEntries: [] },
    { nonInteractive: true }
  );
  assert.deepEqual(vitestWatch.commands, ['npm run typecheck', 'npm run test -- --run']);

  const vitestRun = planVerification(
    { packageJson: pkg({ test: 'vitest run' }), rootEntries: [] },
    { nonInteractive: true }
  );
  assert.deepEqual(vitestRun.commands, ['npm run test']);

  const pnpmJestWatch = planVerification(
    { packageJson: pkg({ test: 'jest --watch' }), rootEntries: ['pnpm-lock.yaml'] },
    { nonInteractive: true }
  );
  assert.deepEqual(pnpmJestWatch.commands, ['pnpm run test --watchAll=false']);
});

test('parseVerifyOutput prioritizes modifiedFiles errors even after 65+ pre-existing untouched errors', () => {
  const preExisting = Array.from(
    { length: 65 },
    (_, idx) => `src/legacy-${idx}.ts(${idx + 1},1): error TS2322: Old error ${idx}.`
  );
  const output = [...preExisting, "src/edited.ts(14,2): error TS2304: Cannot find name 'streak'."].join('\n');
  const parsed = parseVerifyOutput(output, { modifiedFiles: new Set(['src/edited.ts']) });
  assert.ok(
    parsed.errors.some((err) => err.file === 'src/edited.ts' && err.line === 14),
    'modified-file error must never be dropped behind 60 untouched errors'
  );
});

test('planVerification detects Java Maven/Gradle and .NET projects and validates their commands', () => {
  const maven = planVerification({ packageJson: null, rootEntries: ['pom.xml'] });
  assert.equal(maven.kind, 'java');
  assert.deepEqual(maven.commands, ['mvn test -B -q']);

  const gradle = planVerification({ packageJson: null, rootEntries: ['build.gradle.kts'] });
  assert.equal(gradle.kind, 'java');
  assert.deepEqual(gradle.commands, ['gradle test --console=plain']);

  const dotnet = planVerification({ packageJson: null, rootEntries: ['App.csproj'] });
  assert.equal(dotnet.kind, 'dotnet');
  assert.deepEqual(dotnet.commands, ['dotnet test --nologo']);

  assert.equal(isVerifyCommand('mvn test -B -q'), true);
  assert.equal(isVerifyCommand('dotnet test --nologo'), true);
  assert.equal(isVerifyCommand('gradle test'), true);
});

test('parseVerifyOutput parses mypy, ruff, eslint compact, maven, dotnet, and gcc errors cleanly', () => {
  const out = [
    'src/worker.py:18: error: Incompatible return value type  [return-value]',
    'src/linted.py:4:9: F401 unused import',
    'src/compact.ts: line 12, col 3, Error - Unexpected debugger statement. (no-debugger)',
    '[ERROR] /repo/src/Main.java:[27,10] cannot find symbol',
    'Program.cs(14,21): error CS0103: The name Foo does not exist',
    'native/core.cpp:42:5: error: use of undeclared identifier bar'
  ].join('\n');
  const parsed = parseVerifyOutput(out);
  assert.ok(parsed.errors.some((e) => e.file === 'src/worker.py' && e.line === 18));
  assert.ok(parsed.errors.some((e) => e.file === 'src/linted.py' && e.line === 4 && e.msg.includes('F401')));
  assert.ok(parsed.errors.some((e) => e.file === 'src/compact.ts' && e.line === 12));
  assert.ok(parsed.errors.some((e) => e.file.endsWith('src/Main.java') && e.line === 27));
  assert.ok(parsed.errors.some((e) => e.file === 'Program.cs' && e.line === 14 && e.msg.includes('CS0103')));
  assert.ok(parsed.errors.some((e) => e.file === 'native/core.cpp' && e.line === 42));
});