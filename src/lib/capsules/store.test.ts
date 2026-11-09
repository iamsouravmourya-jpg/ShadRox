import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseIndexedDb } from '../persistence';
import {
  deleteCapsule,
  exportCapsules,
  getCapsule,
  importCapsules,
  listCapsules,
  pruneCapsules,
  saveCapsule
} from './store';
import { CAPSULE_FORMAT, CAPSULE_VERSION, type CapsuleExport, type ChangeCapsule } from './types';

function makeCapsule(id: string, createdAt = 1): ChangeCapsule {
  return {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    id,
    taskId: `task-${id}`,
    workspaceRoot: '/ws',
    createdAt,
    status: 'captured',
    promptIntent: 'test intent',
    baseHashes: {},
    diffs: [],
    verification: [],
    spend: null,
    machineDeltaRef: null,
    redaction: { redacted: false, fields: [], count: 0 },
    selfHash: ''
  };
}

function makeExport(capsules: ChangeCapsule[]): CapsuleExport {
  return { format: CAPSULE_FORMAT, version: CAPSULE_VERSION, exportedAt: Date.now(), capsules };
}

test('plain node exposes no IndexedDB', () => {
  assert.equal(canUseIndexedDb(), false);
});

test('saveCapsule returns false without IndexedDB', async () => {
  assert.equal(await saveCapsule(makeCapsule('cap-1')), false);
});

test('listCapsules returns an empty array without IndexedDB', async () => {
  assert.deepEqual(await listCapsules('/ws'), []);
});

test('getCapsule returns null without IndexedDB', async () => {
  assert.equal(await getCapsule('cap-1'), null);
});

test('deleteCapsule returns false without IndexedDB', async () => {
  assert.equal(await deleteCapsule('cap-1'), false);
});

test('pruneCapsules returns 0 without IndexedDB', async () => {
  assert.equal(await pruneCapsules('/ws'), 0);
  assert.equal(await pruneCapsules('/ws', 10), 0);
});

test('exportCapsules returns an empty envelope without IndexedDB', async () => {
  const envelope = await exportCapsules('/ws');
  assert.equal(envelope.format, CAPSULE_FORMAT);
  assert.equal(envelope.version, CAPSULE_VERSION);
  assert.equal(typeof envelope.exportedAt, 'number');
  assert.deepEqual(envelope.capsules, []);
});

test('importCapsules reports local storage unavailable for a valid envelope', async () => {
  const result = await importCapsules(makeExport([makeCapsule('cap-1')]), '/ws');
  assert.deepEqual(result, { imported: 0, skipped: 0, errors: ['local storage unavailable'] });
});

test('importCapsules rejects a wrong-format envelope before the storage check', async () => {
  const malformed = { format: 'not-the-capsule-format', version: CAPSULE_VERSION, exportedAt: Date.now(), capsules: [] };
  const result = await importCapsules(malformed, '/ws');
  assert.deepEqual(result, { imported: 0, skipped: 0, errors: ['invalid capsule export'] });
});

test('importCapsules rejects a null envelope', async () => {
  const result = await importCapsules(null, '/ws');
  assert.deepEqual(result, { imported: 0, skipped: 0, errors: ['invalid capsule export'] });
});

test('importCapsules rejects a wrong-version envelope', async () => {
  const malformed = { format: CAPSULE_FORMAT, version: 999, exportedAt: Date.now(), capsules: [] };
  const result = await importCapsules(malformed, '/ws');
  assert.deepEqual(result, { imported: 0, skipped: 0, errors: ['invalid capsule export'] });
});
