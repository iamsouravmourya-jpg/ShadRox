/**
 * Integrity of the benchmark template itself.
 *
 * A case is only worth keeping when the untouched fixture fails its assertions
 * and the golden reply passes them, through the same plan / verify / stage /
 * commit rail the app uses. That is what this suite proves, for every case
 * folder, without a model or a key. It also proves the loader refuses the two
 * shapes that would silently make a case unbreakable: no assertions at all, and
 * an id that does not match its own folder.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BENCHMARK_KINDS, loadAllCases, loadCase, listCaseDirs } from './case';
import { CASES_ROOT } from './cli';
import { gradeBaseline, gradeCase } from './runner';

const cases = await loadAllCases(CASES_ROOT);

test('the suite covers every kind of job the router claims to calibrate', () => {
  const kinds = cases.map((loaded) => loaded.definition.kind).sort();
  for (const kind of BENCHMARK_KINDS) {
    assert.ok(kinds.includes(kind), `no ${kind} case under benchmark/cases (found: ${kinds.join(', ')})`);
  }
});

test('every case folder is named exactly like the case inside it', () => {
  for (const loaded of cases) {
    assert.equal(path.basename(loaded.dir), loaded.definition.id, 'a mismatch makes --case lie about what it ran');
  }
});

for (const loaded of cases) {
  const { definition } = loaded;

  test(`${definition.id}: the untouched fixture already fails its own assertions`, async () => {
    const baseline = await gradeBaseline(loaded);
    assert.equal(
      baseline.passed,
      false,
      `${definition.id} asserts nothing: the fixture passes it before any patch (${JSON.stringify(
        baseline.checks.filter((row) => !row.ok).map((row) => row.name)
      )} were the only refusals, and they were not)`
    );
    assert.equal(baseline.applied.written, 0, 'a baseline run must not write to disk');
  });

  test(`${definition.id}: the golden reply satisfies every assertion`, async () => {
    const run = await gradeCase(loaded);
    assert.equal(run.applied.failures.length, 0, `the rail refused the golden reply: ${run.applied.failures.join('; ')}`);
    assert.deepEqual(
      run.checks.filter((row) => !row.ok).map((row) => `${row.name}: ${row.details ?? 'failed'}`),
      [],
      `${definition.id} did not land its own case`
    );
    assert.ok(run.passed, `${definition.id} failed even though every row above passed`);
    assert.ok(run.applied.written > 0, `${definition.id} wrote nothing, so its assertions prove nothing`);
    assert.equal(run.outcome.verified, true, 'a graded run always knows whether its evidence held');
    assert.equal(run.outcome.passed, true);
  });
}

/**
 * The ledger keys its ranking on `taskType`, which `classifyTaskType` derives
 * from evidence: a run that executed a command is filed under `test` no matter
 * which template folder it came from. This pins that reading, because a case
 * folder's `kind` is what a person searches by and the record is what the
 * router learns from, and the two must not silently drift apart.
 */
test('the case kinds are exactly the task types the router calibrates', () => {
  assert.deepEqual([...BENCHMARK_KINDS].sort(), ['bugfix', 'feature', 'refactor', 'test']);
});

test('a graded run is filed under the evidence it produced', async () => {
  for (const loaded of cases) {
    const run = await gradeCase(loaded);
    assert.equal(
      run.outcome.taskType,
      loaded.definition.commands.length > 0 ? 'test' : loaded.definition.kind,
      `${loaded.definition.id} classified ${run.outcome.taskType} from ${run.testRuns.length} command run(s)`
    );
    assert.equal(run.outcome.verified, loaded.definition.commands.length > 0 || loaded.definition.checks.length > 0);
  }
});

test('a case that asserts nothing is refused before it can pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-benchmark-'));
  try {
    const dir = path.join(root, 'hollow-case');
    await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
    await fs.writeFile(path.join(dir, 'fixture', 'a.mjs'), 'export const a = 1;\n', 'utf8');
    await fs.writeFile(path.join(dir, 'prompt.md'), 'Do something.\n', 'utf8');
    await fs.writeFile(path.join(dir, 'reply.md'), 'Done.\n', 'utf8');
    await fs.writeFile(
      path.join(dir, 'case.json'),
      JSON.stringify({ id: 'hollow-case', kind: 'bugfix', title: 'Nothing at all', checks: [], commands: [] }),
      'utf8'
    );
    await assert.rejects(loadCase(dir), /asserts nothing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a reply that names a file outside the fixture is refused by the rail', async () => {
  const loaded = cases[0];
  const run = await gradeCase(loaded, {
    reply: '```ts path=../outside.mjs\nexport const nope = 1;\n```',
    prompt: loaded.prompt
  });
  assert.equal(loaded.definition.kind, 'bugfix');
  assert.ok(run.applied.failures.length > 0 || run.applied.written === 0, 'an escaping path must never land');
  assert.equal(run.passed, false, 'a reply that landed nothing cannot pass the case');
});

test('every declared command is an argv list, never a shell string', () => {
  for (const loaded of cases) {
    for (const command of loaded.definition.commands) {
      assert.ok(Array.isArray(command.argv) && command.argv.length > 0, `${command.name} has no argv`);
      assert.ok(!/[;&|`$()]/.test(command.argv.join(' ')), `${command.name} looks like shell text, not argv`);
    }
  }
});

test('the cases root is the folder the template documents', async () => {
  const dirs = await listCaseDirs(CASES_ROOT);
  assert.equal(dirs.length, cases.length, 'every folder with a case.json is loaded, and only those');
  assert.ok(dirs.length >= BENCHMARK_KINDS.length, 'the template needs at least one case per kind');
});
