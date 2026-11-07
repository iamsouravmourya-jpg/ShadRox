import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRequestEnvelope, type RequestEnvelope } from '../requestEnvelope';
import {
  commandIntent,
  composerAfterCheckpointFailure,
  planResume,
  retryCheck,
  undoVerdict,
  type ResumableTask
} from './scopePreserve';

function envelope(overrides: Partial<Parameters<typeof createRequestEnvelope>[0]> = {}): RequestEnvelope {
  return createRequestEnvelope({
    id: 'req-1',
    workspaceId: 'ws-a',
    prompt: 'fix the parser',
    targets: ['src/parser.ts'],
    permissionMode: 'ask',
    refineMode: 'code',
    plan: 'starter',
    payer: 'shared',
    provider: 'gateway',
    model: 'glm-4.7-flash',
    budgetCredits: 12,
    ...overrides
  });
}

describe('retryCheck (S17)', () => {
  it('a retry with the same identity is allowed (S17)', () => {
    const check = retryCheck(envelope(), envelope());
    assert.equal(check.ok, true);
    assert.deepEqual(check.drift, []);
  });

  it('a retry that would switch the paying key is reported, not applied (S17)', () => {
    const check = retryCheck(envelope(), envelope({ payer: 'byok' }));
    assert.equal(check.ok, false);
    assert.ok(check.drift.includes('payer'));
    assert.match(check.reason, /paying key/);
  });

  it('a retry after the workspace or mode changed is reported (S17)', () => {
    const check = retryCheck(envelope(), envelope({ workspaceId: 'ws-b', permissionMode: 'agent' }));
    assert.ok(check.drift.includes('workspace'));
    assert.ok(check.drift.includes('permission'));
  });

  it('a retry after an attached file changed version is reported (S17)', () => {
    const check = retryCheck(envelope(), envelope(), {
      frozen: [{ path: 'src/parser.ts', version: 'v1' }],
      current: [{ path: 'src/parser.ts', version: 'v2' }]
    });
    assert.equal(check.ok, false);
    assert.deepEqual(check.versionChanges, ['src/parser.ts']);
  });
});

describe('planResume (S17)', () => {
  it('resumes unfinished tasks and never re-runs passed ones (S17)', () => {
    const tasks: ResumableTask[] = [
      { id: 't1', status: 'passed', completedEffects: ['write:src/a.ts'] },
      { id: 't2', status: 'unverified' },
      { id: 't3', status: 'pending' },
      { id: 't4', status: 'stopped' }
    ];
    const plan = planResume(tasks);
    assert.deepEqual(plan.alreadyDone, ['t1']);
    assert.deepEqual(plan.rerun, ['t2', 't3', 't4']);
    assert.deepEqual(plan.skipEffects, ['write:src/a.ts']);
  });

  it('treats an unverified task as unfinished, not done (S17)', () => {
    assert.deepEqual(planResume([{ id: 't1', status: 'unverified' }]).rerun, ['t1']);
  });
});

describe('commandIntent (S17)', () => {
  it('Stop halts and preserves work; it does not undo (S17)', () => {
    const stop = commandIntent('stop');
    const undo = commandIntent('undo');
    assert.equal(stop.rerunsWork, false);
    assert.equal(stop.restoresCheckpoint, false);
    assert.equal(stop.keepsExistingWork, true);
    assert.notDeepEqual(stop, undo);
    assert.equal(undo.restoresCheckpoint, true);
    assert.equal(undo.keepsExistingWork, false);
  });

  it('Resume sends work again but keeps what already landed (S17)', () => {
    const resume = commandIntent('resume');
    assert.equal(resume.rerunsWork, true);
    assert.equal(resume.restoresCheckpoint, false);
    assert.equal(resume.keepsExistingWork, true);
  });
});

describe('undoVerdict (S17)', () => {
  it('restores when the file still matches the checkpoint (S17)', () => {
    assert.equal(
      undoVerdict({ path: 'a.ts', baseContent: 'old', stage: 'pre-apply' }, { exists: true, content: 'old' }),
      'safe'
    );
  });

  it('refuses a stale restore that would destroy newer edits (S17)', () => {
    assert.equal(
      undoVerdict({ path: 'a.ts', baseContent: 'old', stage: 'pre-apply' }, { exists: true, content: 'edited by user' }),
      'stale'
    );
  });

  it('reports a missing file instead of restoring over nothing (S17)', () => {
    assert.equal(
      undoVerdict({ path: 'a.ts', baseContent: 'old', stage: 'pre-apply' }, { exists: false, content: '' }),
      'missing'
    );
  });
});

describe('composerAfterCheckpointFailure (S17)', () => {
  it('leaves a usable composer and says nothing changed (S17)', () => {
    const result = composerAfterCheckpointFailure('disk full');
    assert.equal(result.usable, true);
    assert.match(result.status, /Nothing was changed/);
    assert.match(result.status, /disk full/);
  });
});
