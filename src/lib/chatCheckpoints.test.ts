import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRestoreImpactTooltip,
  isWindowsReservedCheckpointPath,
  normalizeCheckpointPath,
  recordPreMutationState,
  summarizeRestoreCheckpoints,
  type PromptCheckpointSnapshot
} from './chatCheckpoints';

test('Windows reserved device names are rejected in checkpoint normalization', () => {
  const reserved = ['nul', 'CON', 'prn.txt', 'src/aux/file.ts', 'com1', 'lpt9.log', './NUL'];
  for (const candidate of reserved) {
    assert.equal(isWindowsReservedCheckpointPath(candidate), true, `Expected reserved match for ${candidate}`);
    assert.equal(normalizeCheckpointPath(candidate), null, `Expected null checkpoint path for ${candidate}`);
  }

  const valid = ['nullCheck.ts', 'console.ts', 'src/App.tsx', 'docs/auxiliary.md', 'src/com10.ts'];
  for (const candidate of valid) {
    assert.equal(isWindowsReservedCheckpointPath(candidate), false, `Expected safe path for ${candidate}`);
    assert.equal(normalizeCheckpointPath(candidate), candidate, `Expected preserved path for ${candidate}`);
  }
});

test('recordPreMutationState skips Windows reserved paths while recording normal paths', () => {
  const initial: PromptCheckpointSnapshot = {
    userMessageId: 'u1',
    promptText: 'update app',
    workspaceKey: 'ws',
    createdAt: 1,
    priorFiles: {},
    createdPaths: []
  };
  const updated = recordPreMutationState(initial, [
    { path: 'nul', content: 'should ignore' },
    { path: 'src/CON.tsx', content: null },
    { path: 'src/App.tsx', content: 'old' },
    { path: 'src/New.tsx', content: null }
  ]);
  assert.deepEqual(updated.priorFiles, { 'src/App.tsx': 'old' });
  assert.deepEqual(updated.createdPaths, ['src/New.tsx']);
});

test('formatRestoreImpactTooltip and summarizeRestoreCheckpoints compute accurate hover summaries', () => {
  assert.equal(formatRestoreImpactTooltip(3, 1), 'Reverts 3 modified, deletes 1 created file');
  assert.equal(formatRestoreImpactTooltip(2, 2), 'Reverts 2 modified, deletes 2 created files');
  assert.equal(formatRestoreImpactTooltip(1, 0), 'Reverts 1 modified file');
  assert.equal(formatRestoreImpactTooltip(4, 0), 'Reverts 4 modified files');
  assert.equal(formatRestoreImpactTooltip(0, 1), 'Deletes 1 created file');
  assert.equal(formatRestoreImpactTooltip(0, 3), 'Deletes 3 created files');
  assert.equal(formatRestoreImpactTooltip(0, 0), 'Restore workspace files to before this prompt');

  const cp1: PromptCheckpointSnapshot = {
    userMessageId: 'u1',
    promptText: 'first edit',
    workspaceKey: 'ws',
    createdAt: 1,
    priorFiles: { 'src/a.ts': 'a0', 'src/b.ts': 'b0' },
    createdPaths: []
  };
  const cp2: PromptCheckpointSnapshot = {
    userMessageId: 'u2',
    promptText: 'second edit',
    workspaceKey: 'ws',
    createdAt: 2,
    priorFiles: { 'src/c.ts': 'c0' },
    createdPaths: ['src/new.ts']
  };
  const tooltips = summarizeRestoreCheckpoints([cp1, cp2]);
  assert.equal(tooltips.u1, 'Reverts 3 modified, deletes 1 created file');
  assert.equal(tooltips.u2, 'Reverts 1 modified, deletes 1 created file');
});
