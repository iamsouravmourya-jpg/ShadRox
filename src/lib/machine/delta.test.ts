import assert from 'node:assert/strict';
import test from 'node:test';
import { machineRestoreReason, type MachineDelta } from './delta';

const report: MachineDelta = {
  checkpointId: 'cp-test', startedAt: 1, endedAt: 2, state: 'complete', files: [], dependencies: [],
  git: { before: null, after: null, changed: false, positionChanged: false, reversible: true },
  previews: { started: [], stopped: [] }, terminals: { before: [], after: [] }, tools: {}, environment: '',
  limitations: [], omissions: [], canRestore: true, blockedReason: null
};

test('only a complete, available, reversible snapshot enables restore', () => {
  assert.equal(machineRestoreReason(report), null);
  assert.match(machineRestoreReason(null)!, /expired/);
  assert.match(machineRestoreReason({ ...report, state: 'recording' })!, /Recording/);
  assert.match(machineRestoreReason({ ...report, state: 'restored' })!, /already/);
  assert.match(machineRestoreReason({ ...report, omissions: ['size limit'] })!, /Incomplete/);
  assert.match(machineRestoreReason({ ...report, git: { ...report.git, reversible: false } })!, /Git/);
  assert.equal(machineRestoreReason({ ...report, blockedReason: 'Overlapping turns' }), 'Overlapping turns');
  assert.match(machineRestoreReason({ ...report, canRestore: false })!, /No reversible/);
});
