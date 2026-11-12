import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRequestEnvelope, type RequestEnvelope } from '../requestEnvelope';
import {
  detectFileRaces,
  mergeTargetManifest,
  plannerScope,
  TaskLedger,
  taskCompletionVerdict,
  workerScope,
  type TargetVersion
} from './taskLedger';

const ENVELOPE: RequestEnvelope = createRequestEnvelope({
  id: 'req-1',
  workspaceId: 'ws-a',
  prompt: 'refactor the parser',
  targets: ['src/parser.ts'],
  permissionMode: 'ask',
  refineMode: 'code',
  payer: 'shared',
  provider: 'gateway',
  model: 'glm-4.7-flash',
  budgetCredits: 24
});

describe('workerScope parity (S16)', () => {
  it('gives every worker the same frozen permission mode, payer and budget (S16)', () => {
    const a = workerScope(ENVELOPE, { id: 't1', files: [{ path: 'src/a.ts', version: 'v1' }] });
    const b = workerScope(ENVELOPE, { id: 't2', files: [{ path: 'src/b.ts', version: 'v1' }] });
    for (const scope of [a, b]) {
      assert.equal(scope.permissionMode, 'ask');
      assert.equal(scope.payer, 'shared');
      assert.equal(scope.budgetCredits, 24);
      assert.equal(scope.workspaceId, 'ws-a');
    }
    assert.deepEqual(a.targets.map((t) => t.path), ['src/a.ts']);
    assert.deepEqual(b.targets.map((t) => t.path), ['src/b.ts']);
  });

  it('carries a submitted attachment to planner and worker at its exact version (S16)', () => {
    const attachment: TargetVersion = { path: 'src/unopened.ts', version: 'sha-abc' };
    const planner = plannerScope(ENVELOPE, [attachment]);
    const worker = workerScope(ENVELOPE, { id: 't1' }, [attachment]);
    assert.deepEqual(planner.targets, [{ path: 'src/unopened.ts', version: 'sha-abc' }]);
    assert.deepEqual(worker.targets, [{ path: 'src/unopened.ts', version: 'sha-abc' }]);
  });

  it('does not let a later worker re-pin a target to a newer version (S16)', () => {
    const frozen = mergeTargetManifest(
      [{ path: 'src/a.ts', version: 'v1' }],
      [{ path: 'src/a.ts', version: 'v2' }]
    );
    assert.deepEqual(frozen, [{ path: 'src/a.ts', version: 'v1' }]);
  });
});

describe('taskCompletionVerdict (S16)', () => {
  it('a task with a failing required check is failed, never done (S16)', () => {
    assert.equal(
      taskCompletionVerdict({
        filesChanged: 1,
        requiredChecks: [{ name: 'typecheck', status: 'failed' }, { name: 'test', status: 'passed' }]
      }),
      'failed'
    );
  });

  it('a task with an unrun required check is unverified, never done (S16)', () => {
    assert.equal(
      taskCompletionVerdict({ filesChanged: 1, requiredChecks: [{ name: 'test', status: 'pending' }] }),
      'unverified'
    );
  });

  it('a task that changed files with no check at all is unverified (S16)', () => {
    assert.equal(taskCompletionVerdict({ filesChanged: 2, requiredChecks: [] }), 'unverified');
  });

  it('only every required check passing is done (S16)', () => {
    assert.equal(
      taskCompletionVerdict({
        filesChanged: 1,
        requiredChecks: [{ name: 'typecheck', status: 'passed' }, { name: 'test', status: 'passed' }]
      }),
      'done'
    );
    assert.equal(taskCompletionVerdict({ filesChanged: 0, requiredChecks: [] }), 'done');
  });

  it('a stopped task reads as stopped, not failed (S16)', () => {
    assert.equal(taskCompletionVerdict({ filesChanged: 1, requiredChecks: [], stopped: true }), 'stopped');
  });
});

describe('detectFileRaces (S16)', () => {
  it('names a file two tasks both claim (S16)', () => {
    const races = detectFileRaces([
      { taskId: 't1', files: ['src/shared.ts'] },
      { taskId: 't2', files: ['src/shared.ts', 'src/b.ts'] }
    ]);
    assert.equal(races.length, 1);
    assert.equal(races[0].file, 'src/shared.ts');
    assert.deepEqual(races[0].taskIds, ['t1', 't2']);
  });

  it('finds no race when each file belongs to one task (S16)', () => {
    assert.deepEqual(
      detectFileRaces([
        { taskId: 't1', files: ['src/a.ts'] },
        { taskId: 't2', files: ['src/b.ts'] }
      ]),
      []
    );
  });
});

describe('TaskLedger (S16)', () => {
  it('counts planner, worker and repair attempts in one ledger (S16)', () => {
    const ledger = new TaskLedger();
    ledger.record({
      id: 'a1',
      taskId: null,
      role: 'planner',
      model: 'gemini-2.5-flash-lite',
      payer: 'shared',
      permissionMode: 'ask',
      targets: [],
      creditsSpent: 0.4,
      status: 'done'
    });
    ledger.record({
      id: 'a2',
      taskId: 't1',
      role: 'worker',
      model: 'qwen3-coder-next',
      payer: 'shared',
      permissionMode: 'ask',
      targets: ['src/a.ts'],
      creditsSpent: 1.5,
      status: 'done'
    });
    ledger.record({
      id: 'a3',
      taskId: 't1',
      role: 'repair',
      model: 'deepseek-v4.1-flash',
      payer: 'shared',
      permissionMode: 'ask',
      targets: ['src/a.ts'],
      creditsSpent: 2,
      status: 'done'
    });
    assert.equal(ledger.attemptCount, 3);
    assert.equal(ledger.attemptsFor('t1').length, 2);
    assert.equal(ledger.creditsSpent, 3.9);
  });
});
