import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptAllPendingChanges,
  acceptPendingChange,
  clearWorkspacePendingChanges,
  computeLineDiffStats,
  getPendingChange,
  getPendingSnapshot,
  isAutoSaveEnabled,
  listPendingChanges,
  listPendingOverrides,
  registerWorkspaceBridge,
  rejectAllPendingChanges,
  rejectPendingChange,
  setWorkspaceAutoSave,
  stagePendingChange
} from './pendingChanges';

test('auto-save defaults to true and tracks toggles per workspace', () => {
  clearWorkspacePendingChanges();
  assert.equal(isAutoSaveEnabled('ws-a'), true);
  assert.equal(isAutoSaveEnabled(undefined), true);

  setWorkspaceAutoSave('ws-a', false);
  assert.equal(isAutoSaveEnabled('ws-a'), false);
  assert.equal(isAutoSaveEnabled('ws-b'), true);
});

test('computeLineDiffStats counts added and removed lines accurately', () => {
  assert.deepEqual(computeLineDiffStats(null, 'a\nb\nc\n'), { addedLines: 3, removedLines: 0 });
  assert.deepEqual(computeLineDiffStats('a\nb\n', 'a\nx\ny\nb\n'), { addedLines: 2, removedLines: 0 });
  assert.deepEqual(computeLineDiffStats('a\nb\nc\n', 'a\nz\n'), { addedLines: 1, removedLines: 2 });
});

test('stagePendingChange merges sequential edits, drops no-ops, and notifies workspace bridge', async () => {
  clearWorkspacePendingChanges();
  const virtualApplied: Array<{ path: string; content: string; created: boolean }> = [];
  const reverted: string[] = [];
  const flushed: Array<{ path: string; content: string }> = [];

  const unregister = registerWorkspaceBridge('ws-stage', {
    applyVirtualBuffers: (entries) => virtualApplied.push(...entries),
    revertBuffers: (entries) => reverted.push(...entries.map((e) => e.path)),
    flushToDisk: async (entries) => {
      flushed.push(...entries.map((e) => ({ path: e.path, content: e.content })));
      return { saved: entries.map((e) => e.path), errors: [] };
    }
  });

  try {
    setWorkspaceAutoSave('ws-stage', false);
    const first = stagePendingChange('ws-stage', {
      path: './src\\App.tsx',
      content: 'line1\nline2-edited\n',
      originalContent: 'line1\nline2\n',
      originalVersion: 'v1'
    });
    assert.ok(first);
    assert.equal(first.path, 'src/App.tsx');
    assert.equal(first.addedLines, 1);
    assert.equal(first.removedLines, 1);
    assert.equal(virtualApplied.length, 1);

    // Second edit preserves base originalContent & originalVersion
    const second = stagePendingChange('ws-stage', {
      path: 'src/App.tsx',
      content: 'line1\nline2-edited\nline3\n',
      originalContent: 'line1\nline2-edited\n',
      originalVersion: 'v2-ignored'
    });
    assert.ok(second);
    assert.equal(second.originalContent, 'line1\nline2\n');
    assert.equal(second.originalVersion, 'v1');
    assert.equal(second.addedLines, 2);
    assert.equal(second.removedLines, 1);

    // Reverting content back to original removes the pending change automatically
    const backToOriginal = stagePendingChange('ws-stage', {
      path: 'src/App.tsx',
      content: 'line1\nline2\n',
      originalContent: 'line1\nline2\n',
      originalVersion: 'v1'
    });
    assert.equal(backToOriginal, null);
    assert.equal(listPendingChanges('ws-stage').length, 0);
    assert.deepEqual(reverted, ['src/App.tsx']);

    // Stage two files and test single-file reject + acceptAll + snapshot totals
    stagePendingChange('ws-stage', {
      path: 'src/one.ts',
      content: 'a\nb\n',
      originalContent: 'a\n',
      originalVersion: 'v1'
    });
    stagePendingChange('ws-stage', {
      path: 'src/two.ts',
      content: 'x\ny\n',
      originalContent: null,
      originalVersion: null,
      created: true
    });

    const snap = getPendingSnapshot('ws-stage');
    assert.equal(snap.autoSave, false);
    assert.equal(snap.entries.length, 2);
    assert.equal(snap.totalAdded, 3);
    assert.equal(snap.totalRemoved, 0);
    assert.equal(listPendingOverrides('ws-stage').length, 2);

    const rej = rejectPendingChange('ws-stage', 'src/one.ts');
    assert.equal(rej.ok, true);
    assert.equal(getPendingChange('ws-stage', 'src/one.ts'), null);

    const acc = await acceptAllPendingChanges('ws-stage');
    assert.equal(acc.ok, true);
    assert.deepEqual(acc.savedPaths, ['src/two.ts']);
    assert.equal(flushed.length, 1);
    assert.equal(listPendingChanges('ws-stage').length, 0);

    // Single-file accept
    stagePendingChange('ws-stage', {
      path: 'src/three.ts',
      content: 'ok\n',
      originalContent: '',
      originalVersion: 'v1'
    });
    const oneAcc = await acceptPendingChange('ws-stage', 'src/three.ts');
    assert.equal(oneAcc.ok, true);
    assert.equal(listPendingChanges('ws-stage').length, 0);

    // RejectAll
    stagePendingChange('ws-stage', {
      path: 'src/four.ts',
      content: 'next\n',
      originalContent: 'prev\n',
      originalVersion: 'v1'
    });
    const rejAll = rejectAllPendingChanges('ws-stage');
    assert.deepEqual(rejAll.revertedPaths, ['src/four.ts']);
    assert.equal(listPendingChanges('ws-stage').length, 0);
  } finally {
    unregister();
    clearWorkspacePendingChanges();
  }
});
