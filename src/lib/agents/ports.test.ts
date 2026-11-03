import assert from 'node:assert/strict';
import test from 'node:test';

import type { AutonomyHost } from '../autonomy/ports';
import { createTeamPorts } from './ports';
import type { TeamEvent } from './types';

function host(overrides: Partial<AutonomyHost> = {}): AutonomyHost {
  return {
    runTurn: async () => ({ reply: 'ok', patchesApplied: 0, patchFailures: [], creditsSpent: 0, aborted: false }),
    getDiagnostics: async () => [],
    listFiles: () => ['src/a.ts'],
    askPlan: async () => '[]',
    runCommand: async () => ({ argv: '', exitCode: 0, stdoutTail: '', stderrTail: '', timedOut: false }),
    ...overrides
  };
}

test('createTeamPorts delegates runTurn and listFiles straight to the host', async () => {
  const calls: string[] = [];
  const ports = createTeamPorts(
    host({
      listFiles: () => ['src/a.ts', 'src/b.ts'],
      runTurn: async (request) => {
        calls.push(request.milestone.id);
        return { reply: 'done', patchesApplied: 2, patchFailures: [], creditsSpent: 1, aborted: false };
      }
    }),
    { rootPath: 'C:/repo', onEvent: () => undefined, isCancellationRequested: () => false }
  );

  assert.deepEqual(ports.listFiles(), ['src/a.ts', 'src/b.ts']);
  const result = await ports.runTurn({
    goal: 'g',
    milestone: { id: 't1', title: 'a', instruction: 'do a', expectedFiles: ['src/a.ts'] }
  });
  assert.deepEqual(calls, ['t1']);
  assert.equal(result.patchesApplied, 2);
});

test('createTeamPorts verifies through the app verifier, keeping the honest unverified verdict', async () => {
  const ports = createTeamPorts(host(), {
    rootPath: 'C:/repo',
    onEvent: () => undefined,
    isCancellationRequested: () => false
  });

  const checked = await ports.verify({ id: 't1', expectedFiles: ['src/a.ts'] });
  assert.equal(checked.verdict, 'passed');

  const nothing = await ports.verify({ id: 't2', expectedFiles: [] });
  assert.equal(nothing.verdict, 'unverified');
});

test('createTeamPorts passes onEvent and cancellation through to the caller', () => {
  const events: TeamEvent[] = [];
  const ports = createTeamPorts(host(), {
    rootPath: 'C:/repo',
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => true
  });

  ports.onEvent({ type: 'team:log', text: 'hello' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'team:log');
  assert.equal(ports.isCancellationRequested(), true);
});
