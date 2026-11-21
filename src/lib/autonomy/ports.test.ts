import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopDiagnostic } from '../desktop';
import { buildRepairBrief } from './feedback';
import {
  collectMilestoneDiagnostics,
  createAutonomyPorts,
  normalizeRelativePath,
  toDiagnosticLine,
  toWorkspaceRelative,
  verifyMilestone,
  type AutonomyHost
} from './ports';
import type { AutonomyEvent, CommandOutcome, Milestone } from './types';

const ROOT = '/ws';

function diag(overrides: Partial<DesktopDiagnostic> = {}): DesktopDiagnostic {
  return {
    file: '/ws/src/a.ts',
    line: 0,
    character: 0,
    endLine: 0,
    endCharacter: 1,
    severity: 'error',
    code: 'TS2304',
    message: "Cannot find name 'x'.",
    ...overrides
  };
}

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    title: 'add a thing',
    instruction: 'create src/a.ts',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    status: 'running',
    attempts: [],
    ...overrides
  };
}

function okCommand(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { argv: 'npm test', exitCode: 0, stdoutTail: 'ok', stderrTail: '', timedOut: false, ...overrides };
}

function host(overrides: Partial<AutonomyHost> = {}): AutonomyHost {
  return {
    runTurn: async () => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: false }),
    getDiagnostics: async () => [],
    listFiles: () => [],
    askPlan: async () => '[]',
    runCommand: async () => okCommand(),
    ...overrides
  };
}

test('normalizeRelativePath uses forward slashes, drops a leading ./ and collapses doubled slashes', () => {
  assert.equal(normalizeRelativePath('src\\lib\\a.ts'), 'src/lib/a.ts');
  assert.equal(normalizeRelativePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelativePath('src//lib///a.ts'), 'src/lib/a.ts');
});

test('toWorkspaceRelative strips the root, leaves outsiders alone, and survives an empty root', () => {
  assert.equal(toWorkspaceRelative('/ws/src/a.ts', ROOT), 'src/a.ts');
  assert.equal(toWorkspaceRelative('C:\\ws\\src\\a.ts', 'C:\\ws'), 'src/a.ts');
  assert.equal(toWorkspaceRelative(ROOT, ROOT), '', 'the root itself is the empty relative path');
  assert.equal(toWorkspaceRelative('/other/src/a.ts', ROOT), '/other/src/a.ts', 'an outside path is not mangled');
  assert.equal(toWorkspaceRelative('/ws/src/a.ts', ''), '/ws/src/a.ts');
});

test('toDiagnosticLine converts 0-based positions to 1-based and drops info-level noise', () => {
  const line = toDiagnosticLine(diag({ line: 4, character: 9 }), 'src/a.ts');
  assert.deepEqual(line, { path: 'src/a.ts', line: 5, column: 10, message: "Cannot find name 'x'.", severity: 'error' });
  assert.equal(toDiagnosticLine(diag({ severity: 'info' }), 'src/a.ts'), null);
});

test('collectMilestoneDiagnostics keeps only a milestone\'s own files, and returns null when it names none', () => {
  const diagnostics = [
    diag({ file: '/ws/src/a.ts' }),
    diag({ file: '/ws/src/b.ts' }),
    diag({ file: '/elsewhere/c.ts' }),
    diag({ file: '/ws/src/a.ts', severity: 'warning', line: 2 })
  ];
  const lines = collectMilestoneDiagnostics(milestone(), diagnostics, ROOT);
  assert.equal(lines?.length, 2, 'b.ts and the outside file are filtered out');
  assert.ok(lines?.every((entry) => entry.path === 'src/a.ts'));
  assert.equal(collectMilestoneDiagnostics(milestone({ expectedFiles: [] }), diagnostics, ROOT), null);
});

test('verifyMilestone: a clean check passes, an error fails, and naming nothing is unverified', async () => {
  const clean = await verifyMilestone(milestone(), host(), ROOT);
  assert.equal(clean.verdict, 'passed');
  assert.deepEqual(clean.diagnostics, []);

  const failed = await verifyMilestone(milestone(), host({ getDiagnostics: async () => [diag()] }), ROOT);
  assert.equal(failed.verdict, 'failed');
  assert.equal(failed.diagnostics[0]?.line, 1);

  const nothing = await verifyMilestone(milestone({ expectedFiles: [] }), host(), ROOT);
  assert.equal(nothing.verdict, 'unverified');
  assert.match(nothing.notes.join(' '), /named no files/);
});

test('verifyMilestone: the proof command decides when diagnostics cannot', async () => {
  const noFiles = milestone({ expectedFiles: [], verifyCommand: 'npm test' });
  const greenWithNoFiles = await verifyMilestone(noFiles, host(), ROOT);
  assert.equal(greenWithNoFiles.verdict, 'passed', 'a green command is proof even with nothing to type-check');

  // BUG-03: a red command with clean diagnostics is diagnostic evidence, not a
  // failure verdict — a fresh workspace's `npm test` fails before deps exist.
  const red = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ runCommand: async () => okCommand({ exitCode: 1, stderrTail: 'boom' }) }),
    ROOT
  );
  assert.equal(red.verdict, 'passed', 'clean compiler diagnostics decide; the red command alone does not fail the task');
  assert.match(red.notes.join(' '), /exited 1/);
  assert.equal(red.command?.exitCode, 1);
  assert.equal(red.command?.stderrTail, 'boom', 'the failure output stays on the report for the next attempt');
});

test('verifyMilestone: a red command with error diagnostics still fails, output captured for repair', async () => {
  const report = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({
      getDiagnostics: async () => [diag()],
      runCommand: async () => okCommand({ exitCode: 1, stdoutTail: '1 failing test', stderrTail: 'AssertionError: expected 2' })
    }),
    ROOT
  );
  assert.equal(report.verdict, 'failed', 'compiler diagnostics errors remain fatal');
  assert.equal(report.command?.exitCode, 1);
  assert.equal(report.command?.stdoutTail, '1 failing test');
  assert.equal(report.command?.stderrTail, 'AssertionError: expected 2');
  // The repair brief the next attempt reads must carry the command's evidence.
  const brief = buildRepairBrief({ ...milestone(), verifyCommand: 'npm test' }, report, [], 1);
  assert.match(brief, /Exit code: 1/);
  assert.match(brief, /AssertionError: expected 2/);
  assert.match(brief, /1 failing test/);
});

test('verifyMilestone: a red command with no checker is unverified, never a silent pass or a kill', async () => {
  const report = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ getDiagnostics: async () => null, runCommand: async () => okCommand({ exitCode: 1, stderrTail: 'missing script: test' }) }),
    ROOT
  );
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.command?.exitCode, 1);
  assert.equal(report.command?.stderrTail, 'missing script: test');
  assert.match(report.notes.join(' '), /exited 1/);
});

test('verifyMilestone: a green command never erases a type error', async () => {
  const report = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ getDiagnostics: async () => [diag()], runCommand: async () => okCommand() }),
    ROOT
  );
  assert.equal(report.verdict, 'failed', 'the failing diagnostics verdict is sticky');
});

test('verifyMilestone: a declined command never turns a failure green and is recorded', async () => {
  const declined = okCommand({ exitCode: null, declinedReason: 'the user declined the command' });
  const failed = await verifyMilestone(
    milestone({ verifyCommand: 'rm -rf /' }),
    host({ getDiagnostics: async () => [diag()], runCommand: async () => declined }),
    ROOT
  );
  assert.equal(failed.verdict, 'failed', 'the diagnostics verdict stands');
  assert.match(failed.notes.join(' '), /was not run/);

  const clean = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ runCommand: async () => declined }),
    ROOT
  );
  assert.equal(clean.verdict, 'passed', 'a declined command leaves the clean diagnostics verdict alone');
});

test('verifyMilestone: when no checker can run, the verdict is unverified, never a silent pass', async () => {
  const report = await verifyMilestone(
    milestone(),
    host({
      getDiagnostics: async () => {
        throw new Error('language service offline');
      }
    }),
    ROOT
  );
  assert.equal(report.verdict, 'unverified');
  assert.match(report.notes.join(' '), /language service offline/);

  const commandThrew = await verifyMilestone(
    milestone({ expectedFiles: [], verifyCommand: 'npm test' }),
    host({
      runCommand: async () => {
        throw new Error('no terminal');
      }
    }),
    ROOT
  );
  assert.equal(commandThrew.verdict, 'unverified');
  assert.match(commandThrew.notes.join(' '), /no terminal/);
});

test('verifyMilestone: a checker that is not attached is unverified, not a silent green', async () => {
  const report = await verifyMilestone(milestone(), host({ getDiagnostics: async () => null }), ROOT);
  assert.equal(report.verdict, 'unverified');
  assert.match(report.notes.join(' '), /no type checker is attached/);
});

test('verifyMilestone: a proof command killed by its time limit cannot carry a pass', async () => {
  const timedOut = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ getDiagnostics: async () => null, runCommand: async () => okCommand({ exitCode: 0, timedOut: true }) }),
    ROOT
  );
  assert.notEqual(timedOut.verdict, 'passed', 'a half-finished run proved nothing');
  assert.equal(timedOut.verdict, 'failed');
  assert.match(timedOut.notes.join(' '), /killed by its time limit/);
});

test('verifyMilestone: a zero-write turn fails while its expected files are absent, passes once they exist', async () => {
  const absent = await verifyMilestone(
    milestone(),
    host({ readFile: async () => { throw new Error('ENOENT'); } }),
    ROOT,
    { patchesApplied: 0, changedFiles: 0 }
  );
  assert.equal(absent.verdict, 'failed', 'a turn that wrote nothing cannot pass a milestone whose files are not on disk');
  assert.match(absent.notes.join(' '), /touched nothing/);
  assert.match(absent.notes.join(' '), /expected file\(s\) are absent: src\/a\.ts/);

  const present = await verifyMilestone(
    milestone(),
    host({ readFile: async () => 'already on disk' }),
    ROOT,
    { patchesApplied: 0, changedFiles: 0 }
  );
  assert.equal(present.verdict, 'passed', 'the expected files already on disk are the milestone\'s work');
  assert.match(present.notes.join(' '), /touched nothing/);
});

test('verifyMilestone: a host that reports no non-patch writes is taken at its word', async () => {
  const report = await verifyMilestone(milestone(), host(), ROOT, { patchesApplied: 0 });
  assert.equal(report.verdict, 'unverified', 'zero writes with no file reader to prove the outputs exist is not a pass');
  assert.match(report.notes.join(' '), /touched nothing/, 'zero patches and no reported mutations is zero writes');
});

test('verifyMilestone: real writes earn a pass with no touched-nothing note', async () => {
  const patched = await verifyMilestone(milestone(), host(), ROOT, { patchesApplied: 1, changedFiles: 0 });
  const commanded = await verifyMilestone(milestone(), host(), ROOT, { patchesApplied: 0, changedFiles: 2 });
  for (const report of [patched, commanded]) {
    assert.equal(report.verdict, 'passed');
    assert.doesNotMatch(report.notes.join(' '), /touched nothing/);
  }
});

test('verifyMilestone: a read-only investigation still passes, now honestly annotated', async () => {
  const unit = milestone({ expectedFiles: [], verifyCommand: 'npm test' });
  const report = await verifyMilestone(unit, host(), ROOT, { patchesApplied: 0, changedFiles: 0 });
  assert.equal(report.verdict, 'passed', 'a green proof command is still proof for a read-only unit');
  assert.match(report.notes.join(' '), /touched nothing/);
});

test('verifyMilestone: without write evidence the report is unchanged', async () => {
  const report = await verifyMilestone(milestone(), host(), ROOT);
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.notes, [], 'no writes argument means no claim either way');
});

test('createAutonomyPorts hands the turn\'s writes to the verifier', async () => {
  const ports = createAutonomyPorts(host(), {
    rootPath: ROOT,
    onEvent: () => undefined,
    isCancellationRequested: () => false
  });
  const report = await ports.verify(milestone(), { patchesApplied: 0, changedFiles: 0 });
  assert.equal(report.verdict, 'unverified', 'no file reader means the no-op turn cannot be claimed as passed');
  assert.match(report.notes.join(' '), /touched nothing/);
});

test('createAutonomyPorts forwards every capability and hides the host behind the contract', async () => {
  const events: AutonomyEvent[] = [];
  let cancelled = false;
  const ports = createAutonomyPorts(
    host({
      runTurn: async (request) => ({
        reply: request.milestone.id,
        patchesApplied: 2,
        patchFailures: ['src/a.ts: no match'],
        aborted: false
      }),
      listFiles: () => ['src/a.ts'],
      askPlan: async (prompt) => `plan for ${prompt}`
    }),
    { rootPath: ROOT, onEvent: (event) => events.push(event), isCancellationRequested: () => cancelled }
  );

  assert.deepEqual(ports.listFiles(), ['src/a.ts']);
  assert.equal(await ports.askPlan('build it'), 'plan for build it');

  const turn = await ports.runTurn({ goal: 'g', milestone: milestone() });
  assert.equal(turn.reply, 'm1');
  assert.equal(turn.patchesApplied, 2);

  ports.onEvent({ type: 'log', text: 'hi' });
  assert.equal(events.length, 1);
  assert.equal(ports.isCancellationRequested(), false);
  cancelled = true;
  assert.equal(ports.isCancellationRequested(), true);

  const report = await ports.verify(milestone());
  assert.equal(report.verdict, 'passed');
});

test('a caller without a Pause button gets a port that cannot pause', () => {
  const plain = createAutonomyPorts(host({}), {
    rootPath: ROOT,
    onEvent: () => undefined,
    isCancellationRequested: () => false
  });
  assert.equal(plain.isPauseRequested, undefined);

  let paused = false;
  const withPause = createAutonomyPorts(host({}), {
    rootPath: ROOT,
    onEvent: () => undefined,
    isCancellationRequested: () => false,
    isPauseRequested: () => paused
  });
  assert.equal(withPause.isPauseRequested?.(), false);
  paused = true;
  assert.equal(withPause.isPauseRequested?.(), true, 'the panel flag reaches the driver through the port');
});

test('collectMilestoneDiagnostics matches Windows case-insensitive paths across expectedFiles and touchedFiles', () => {
  const winDiagnostics = [
    diag({ file: 'C:\\ws\\SRC\\Utils\\ratelimiter.ts', line: 9, message: "Cannot find module 'redis'." })
  ];
  const lines = collectMilestoneDiagnostics(
    milestone({ expectedFiles: [], touchedFiles: ['src/utils/rateLimiter.ts'] }),
    winDiagnostics,
    'C:\\WS'
  );
  assert.equal(lines?.length, 1);
  assert.equal(lines?.[0].path, 'src/utils/rateLimiter.ts');
  assert.equal(lines?.[0].line, 10);
});

test('verifyMilestone passes target files to getDiagnostics and fails placeholder stubs via readFile', async () => {
  let seenFiles: string[] | undefined;
  const report = await verifyMilestone(
    milestone({ expectedFiles: ['src/enroll.ts'] }),
    host({
      getDiagnostics: async (files) => {
        seenFiles = files;
        return [];
      },
      readFile: async () => "export const enroll = { courseTitle: '', // Retrieve course title if needed\n};"
    }),
    ROOT,
    { patchesApplied: 1 }
  );

  assert.deepEqual(seenFiles, ['src/enroll.ts']);
  assert.equal(report.verdict, 'failed');
  assert.equal(report.diagnostics.length, 1);
  assert.match(report.diagnostics[0].message, /Placeholder/i);
  assert.match(report.notes.join(' '), /error diagnostic\(s\) found/);
});

