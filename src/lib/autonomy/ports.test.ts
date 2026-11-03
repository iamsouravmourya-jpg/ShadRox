import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopDiagnostic } from '../desktop';
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
    runTurn: async () => ({ reply: '', patchesApplied: 0, patchFailures: [], creditsSpent: 0, aborted: false }),
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

  const red = await verifyMilestone(
    milestone({ verifyCommand: 'npm test' }),
    host({ runCommand: async () => okCommand({ exitCode: 1, stderrTail: 'boom' }) }),
    ROOT
  );
  assert.equal(red.verdict, 'failed');
  assert.match(red.notes.join(' '), /exited 1/);
  assert.equal(red.command?.exitCode, 1);
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

test('createAutonomyPorts forwards every capability and hides the host behind the contract', async () => {
  const events: AutonomyEvent[] = [];
  let cancelled = false;
  const ports = createAutonomyPorts(
    host({
      runTurn: async (request) => ({
        reply: request.milestone.id,
        patchesApplied: 2,
        patchFailures: ['src/a.ts: no match'],
        creditsSpent: 1,
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
