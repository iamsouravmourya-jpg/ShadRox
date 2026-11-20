import assert from 'node:assert/strict';
import test from 'node:test';
import { settleConfirm, subscribeConfirm } from '../confirm';
import { beginTurn, resetTurns, noteWrite } from './turnState';
import {
  setCheckpointStorage, setCheckpointHost, createAgentCheckpoint, ensureTurnCheckpoint,
  listAgentCheckpoints, restoreAgentCheckpoint, type CheckpointStorage, type CheckpointFile
} from './checkpoints';
import type { CheckpointMeta } from '../history';

/** An in-memory stand-in for the IndexedDB history store. */
function fakeStorage() {
  const metas: CheckpointMeta[] = [];
  const files = new Map<string, CheckpointFile[]>();
  const created = new Map<string, string[]>();
  let seq = 0;
  const storage: CheckpointStorage = {
    async save(input) {
      const id = `cp-${++seq}`;
      const meta: CheckpointMeta = { id, messageId: input.messageId, label: input.label, createdAt: Date.now(), fileCount: input.files.length };
      metas.unshift(meta);
      files.set(id, [...input.files]);
      created.set(id, []);
      return meta;
    },
    async list() { return [...metas]; },
    async loadFiles(id) { return files.get(id) ?? null; },
    async mergeFiles(id, incoming) {
      const existing = files.get(id) ?? [];
      for (const file of incoming) {
        const index = existing.findIndex((entry) => entry.name === file.name);
        if (index >= 0) existing[index] = file; else existing.push(file);
      }
      files.set(id, existing);
      const meta = metas.find((entry) => entry.id === id);
      if (meta) meta.fileCount = existing.length;
      return incoming.length;
    },
    async addCreatedPaths(id, paths) { created.set(id, [...new Set([...(created.get(id) ?? []), ...paths])]); },
    async loadCreatedPaths(id) { return created.get(id) ?? []; }
  };
  return { storage, metas, files, created };
}

function withApproval(accepted: boolean, body: () => Promise<void>) {
  const off = subscribeConfirm(() => settleConfirm(accepted));
  return body().finally(off);
}

test.afterEach(() => {
  setCheckpointStorage(null);
  setCheckpointHost(null);
  resetTurns();
});

test('ensureTurnCheckpoint snapshots pre-images via loadFiles and merges as the turn touches more', async () => {
  const { storage, files } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  const desktop = { loadFiles: async (_id: string, paths: string[]) => ({ files: paths.map((name) => ({ name, content: `old:${name}`, version: 'v' })), missing: [] }) };

  const id = await ensureTurnCheckpoint(turn, desktop, ['a.ts']);
  assert.ok(id);
  assert.equal(turn.checkpointId, id);
  assert.deepEqual(files.get(id!), [{ name: 'a.ts', content: 'old:a.ts' }]);

  await ensureTurnCheckpoint(turn, desktop, ['a.ts', 'b.ts']);
  assert.deepEqual(files.get(id!)!.map((file) => file.name).sort(), ['a.ts', 'b.ts'], 'a.ts is not re-snapshotted, b.ts merges in');
  assert.equal(turn.checkpointPaths.size, 2);
});

test('ensureTurnCheckpoint records created paths so a restore can delete them', async () => {
  const { storage, created } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['new.ts'], ['new.ts']);
  const desktop = { loadFiles: async () => ({ files: [], missing: [] }) };
  const id = await ensureTurnCheckpoint(turn, desktop, ['existing.ts']);
  assert.deepEqual(created.get(id!), ['new.ts']);
});

test('ensureTurnCheckpoint is a no-op without loadFiles or a resolvable path', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  assert.equal(await ensureTurnCheckpoint(turn, {}, ['a.ts']), null, 'no loadFiles channel');
  setCheckpointHost(() => null);
  const turn2 = beginTurn('ws2', 'ask', { scaffold: false, addPage: false });
  assert.equal(await ensureTurnCheckpoint(turn2, { loadFiles: async () => ({ files: [], missing: [] }) }, ['a.ts']), null, 'no path');
});

test('createAgentCheckpoint fails open when the path is unknown', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => null);
  assert.equal(await createAgentCheckpoint('ws', 'label', [{ name: 'a.ts', content: 'x' }]), null);
});

test('listAgentCheckpoints returns the store newest first', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  await createAgentCheckpoint('ws', 'first', [{ name: 'a.ts', content: 'x' }]);
  await createAgentCheckpoint('ws', 'second', [{ name: 'b.ts', content: 'y' }]);
  const { path, checkpoints } = await listAgentCheckpoints('ws');
  assert.equal(path, '/ws');
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].label, 'second');
});

test('restore deletes created files and writes the stored pre-images back, after approval', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const meta = await createAgentCheckpoint('ws', 'before', [{ name: 'a.ts', content: 'original' }]);
  await storage.addCreatedPaths(meta!.id, ['made.ts']);
  const deleted: string[] = [];
  const saved: Array<{ name: string; content: string }> = [];
  const desktop = {
    deletePath: async (_id: string, path: string) => { deleted.push(path); return { path, kind: 'file' as const }; },
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => { saved.push(...entries); return { errors: [], saved: entries.map((entry) => entry.name) }; }
  };
  await withApproval(true, async () => {
    const result = await restoreAgentCheckpoint('ws', desktop, meta!.id);
    assert.equal(result.ok, true);
    assert.deepEqual(deleted, ['made.ts']);
    assert.deepEqual(saved, [{ name: 'a.ts', content: 'original' }]);
    assert.match(result.message, /Restored "before"/);
  });
});

test('a cancelled restore changes nothing', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const meta = await createAgentCheckpoint('ws', 'before', [{ name: 'a.ts', content: 'original' }]);
  let touched = false;
  const desktop = { deletePath: async () => { touched = true; return { path: 'x', kind: 'file' as const }; }, saveFiles: async () => { touched = true; return { errors: [], saved: [] }; } };
  await withApproval(false, async () => {
    const result = await restoreAgentCheckpoint('ws', desktop, meta!.id);
    assert.equal(result.ok, false);
    assert.match(result.message, /did not approve/);
    assert.equal(touched, false);
  });
});

test('an unknown checkpoint id is refused with a pointer to list_checkpoints', async () => {
  const { storage } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const result = await restoreAgentCheckpoint('ws', {}, 'nope');
  assert.equal(result.ok, false);
  assert.match(result.message, /list_checkpoints/);
});

test('a machine checkpoint routes to the machine-turn restore channel', async () => {
  const { storage, metas } = fakeStorage();
  setCheckpointStorage(storage);
  setCheckpointHost(() => '/ws');
  const meta = await createAgentCheckpoint('ws', 'machine', []);
  metas.find((entry) => entry.id === meta!.id)!.machine = true;
  let called = '';
  const desktop = { restoreMachineTurn: async (_id: string, id: string) => { called = id; return { ok: true, message: 'done', report: { checkpointId: id, startedAt: 0, endedAt: 0, state: 'complete' as const, files: [], dependencies: [], git: { before: null, after: null, changed: false, positionChanged: false, reversible: true }, previews: { started: [], stopped: [] }, terminals: { before: [], after: [] }, tools: {}, environment: '', limitations: [], omissions: [], canRestore: true, blockedReason: null } }; } };
  await withApproval(true, async () => {
    const result = await restoreAgentCheckpoint('ws', desktop, meta!.id);
    assert.equal(result.ok, true);
    assert.equal(called, meta!.id);
  });
});