import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureFileHashSnapshot,
  compareFileHashSnapshots,
  evaluateNativeFileCheckCommand,
  inferMilestoneCategory,
  parseNativeFileCheckCommand,
  sha256Hex,
  verifyToolTelemetry
} from './milestoneVerifier';
import { verifyMilestone, type AutonomyHost } from './ports';
import type { TurnResult, VerifiableUnit } from './types';

function makeUnit(overrides: Partial<VerifiableUnit> = {}): VerifiableUnit {
  return {
    id: 'm1',
    title: 'Update module',
    instruction: 'Edit src/app.ts',
    expectedFiles: ['src/app.ts'],
    ...overrides
  };
}

function makeHost(files: Map<string, string>, runCommandCalls: string[] = []): AutonomyHost {
  const turnStub: TurnResult = { reply: '', patchesApplied: 0, patchFailures: [], aborted: false };
  return {
    runTurn: async () => turnStub,
    getDiagnostics: async () => [],
    listFiles: () => [...files.keys()],
    askPlan: async () => '[]',
    readFile: async (target) => files.get(target) ?? null,
    runCommand: async (argv) => {
      runCommandCalls.push(argv);
      return { argv, exitCode: 0, stdoutTail: 'ok', stderrTail: '', timedOut: false };
    }
  };
}

test('sha256Hex matches standard FIPS 180-4 test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('parseNativeFileCheckCommand intercepts POSIX and PowerShell file checks but leaves real build commands untouched', () => {
  assert.deepEqual(parseNativeFileCheckCommand('test -f src/a.ts && test -d src/lib'), [
    { kind: 'file', target: 'src/a.ts' },
    { kind: 'dir', target: 'src/lib' }
  ]);
  assert.deepEqual(parseNativeFileCheckCommand('[ -f "src/hello world.ts" ]'), [
    { kind: 'file', target: 'src/hello world.ts' }
  ]);
  assert.deepEqual(parseNativeFileCheckCommand('Test-Path -Path src/index.ts'), [
    { kind: 'exists', target: 'src/index.ts' }
  ]);
  assert.deepEqual(parseNativeFileCheckCommand('ls src/a.ts; dir src\\b.ts'), [
    { kind: 'exists', target: 'src/a.ts' },
    { kind: 'exists', target: 'src/b.ts' }
  ]);

  assert.equal(parseNativeFileCheckCommand('npm test'), null);
  assert.equal(parseNativeFileCheckCommand('npx tsc --noEmit'), null);
  assert.equal(parseNativeFileCheckCommand('npm run build | tee build.log'), null);
});

test('verifyMilestone intercepts shell existence proof commands natively without invoking shell host', async () => {
  const files = new Map<string, string>([['src/app.ts', 'export const ok = 1;\n']]);
  const shellCalls: string[] = [];
  const host = makeHost(files, shellCalls);

  const passReport = await verifyMilestone(
    makeUnit({ verifyCommand: 'test -f src/app.ts && test -d src', touchedFiles: ['src/app.ts'] }),
    host,
    '/repo',
    { patchesApplied: 1 }
  );
  assert.equal(passReport.verdict, 'passed');
  assert.equal(shellCalls.length, 0, 'native file check never executes fragile shell subprocess');

  const failReport = await verifyMilestone(
    makeUnit({ expectedFiles: ['src/missing.ts'], verifyCommand: 'test -f src/missing.ts', touchedFiles: [] }),
    host,
    '/repo',
    { patchesApplied: 0 }
  );
  assert.equal(failReport.verdict, 'failed');
  assert.equal(shellCalls.length, 0);
  assert.ok(failReport.notes.some((note) => note.includes('src/missing.ts')));
});

test('verifyMilestone detects file mutations via SHA-256 hashes even when patchesApplied === 0', async () => {
  const files = new Map<string, string>([['src/app.ts', 'export const v = 1;\n']]);
  const host = makeHost(files);
  const preTurnHashes = await captureFileHashSnapshot(['src/app.ts'], host.readFile);

  files.set('src/app.ts', 'export const v = 2;\n');
  const postTurnHashes = await captureFileHashSnapshot(['src/app.ts'], host.readFile);

  const comparison = compareFileHashSnapshots(['src/app.ts'], preTurnHashes, postTurnHashes);
  assert.deepEqual(comparison.mutatedPaths, ['src/app.ts']);

  const report = await verifyMilestone(
    makeUnit({ category: 'file_mutation' }),
    host,
    '/repo',
    {
      patchesApplied: 0,
      preTurnHashes,
      postTurnHashes,
      toolEvents: [{ name: 'write_file', ok: true }]
    }
  );
  assert.equal(report.verdict, 'passed');
  assert.ok(report.notes.some((n) => n.includes('SHA-256')));
});

test('read_only and checkpoint milestones verify via tool telemetry and never fail with touched nothing', async () => {
  const files = new Map<string, string>([['src/app.ts', 'export const v = 1;\n']]);
  const host = makeHost(files);

  assert.equal(
    inferMilestoneCategory({ title: 'Create checkpoint', instruction: 'Save turn checkpoint', expectedFiles: [] }),
    'checkpoint'
  );
  assert.equal(
    inferMilestoneCategory({ title: 'Inspect live preview', instruction: 'Inspect preview DOM', expectedFiles: [] }),
    'read_only'
  );

  const previewReport = await verifyMilestone(
    makeUnit({
      category: 'read_only',
      title: 'Inspect live preview',
      instruction: 'Check running preview for errors',
      expectedFiles: []
    }),
    host,
    '/repo',
    {
      patchesApplied: 0,
      toolEvents: [{ name: 'preview_inspect', ok: true, summary: 'No runtime errors' }]
    }
  );
  assert.equal(previewReport.verdict, 'passed');
  assert.equal(previewReport.notes.join(' ').includes('touched nothing'), false);

  const checkpointReport = await verifyMilestone(
    makeUnit({
      category: 'checkpoint',
      title: 'Create checkpoint',
      instruction: 'Snapshot before refactoring',
      expectedFiles: []
    }),
    host,
    '/repo',
    {
      patchesApplied: 0,
      toolEvents: [{ name: 'checkpoint', ok: true }]
    }
  );
  assert.equal(checkpointReport.verdict, 'passed');
  assert.equal(verifyToolTelemetry('checkpoint', { title: 'Checkpoint', instruction: 'Save' }, {
    patchesApplied: 0,
    toolEvents: [{ name: 'checkpoint', ok: true }]
  }).ok, true);
});

test('evaluateNativeFileCheckCommand handles nested directory paths cleanly', async () => {
  const res = await evaluateNativeFileCheckCommand('Test-Path src/components', {
    listFiles: () => ['src/components/Button.tsx']
  });
  assert.ok(res);
  assert.equal(res.ok, true);
});
