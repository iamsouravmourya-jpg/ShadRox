'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProofStore } = require('./proof-store.cjs');

test('proof store appends workspace-bound JSONL and isolates workspace ids', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createProofStore({ root, safeStorage: null });
  const record = JSON.stringify({ workspace: 'workspace-a', seq: 1 });
  await store.appendLine('workspace-a', record);
  assert.equal(await store.readLedger('workspace-a'), `${record}\n`);
  assert.equal(await store.readLedger('workspace-b'), null);
  await assert.rejects(store.appendLine('workspace-a', JSON.stringify({ workspace: 'workspace-b', seq: 1 })), /workspace/);
});

test('proof keys are encrypted at rest and require OS-backed encryption', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).toString('base64'),
    decryptString: (value) => Buffer.from(value.toString(), 'base64').toString('utf8')
  };
  const store = createProofStore({ root, safeStorage });
  const registry = JSON.stringify({ current: 'key-1', private: { jwk: { d: 'secret' } } });
  await store.writeKeys('workspace-a', registry);
  assert.equal(await store.readKeys('workspace-a'), registry);
  const keyFile = fs.readdirSync(path.join(root, require('node:crypto').createHash('sha256').update('workspace-a').digest('hex')))
    .find((name) => name === 'keys.enc');
  assert.ok(keyFile);
  assert.equal(fs.readFileSync(path.join(root, require('node:crypto').createHash('sha256').update('workspace-a').digest('hex'), keyFile), 'utf8').includes('"d":"secret"'), false);

  const unavailable = createProofStore({ root, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(unavailable.readKeys('workspace-a'), /unavailable/);
  await assert.rejects(unavailable.writeKeys('workspace-a', registry), /unavailable/);
});

test('proof store rejects oversized records and malformed key registries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createProofStore({
    root,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: String }
  });
  await assert.rejects(store.appendLine('workspace-a', `${'x'.repeat(256 * 1024 + 1)}`), /oversized/);
  await assert.rejects(store.writeKeys('workspace-a', '{'), SyntaxError);
});
