const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspaceAccess } = require('./workspace.cjs');
const { createMachineDelta, LIMITS } = require('./machine-delta.cjs');
const { createMachineReceipt, receiptFingerprint, RECEIPT_FORMAT, RECEIPT_VERSION } = require('./machine-receipt.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-receipt-')));
  const receiptsDir = path.join(root, '..', `shadrox-receipts-${path.basename(root)}`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(receiptsDir, { recursive: true, force: true }));
  const write = async (name, content) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  await write('a.txt', 'ZZbeforeZZ');
  const access = createWorkspaceAccess();
  const { workspaceId: id } = await access.openFolder(root);
  const systems = [
    { git: { head: 'cafe0000', ref: 'refs/heads/main', index: null, status: null, staged: {}, tree: {} }, previews: [], terminals: [], tools: { node: 'x' } },
    { git: { head: 'cafe0000', ref: 'refs/heads/main', index: null, status: null, staged: {}, tree: {} }, previews: [{ id: 'preview-1', kind: 'vite', port: 5173 }], terminals: [], tools: { node: 'x' } }
  ];
  let capture = 0;
  const delta = createMachineDelta({
    access,
    readSystem: async () => structuredClone(systems[Math.min(capture++, systems.length - 1)]),
    prepareGitRestore: async () => { throw new Error('Unexpected Git restore'); },
    stopOwnedPreview: async () => true
  });
  const receipts = createMachineReceipt({
    access,
    receiptsDir,
    getReport: (workspaceId, checkpointId) => delta.inspect(workspaceId, checkpointId),
    limits: LIMITS
  });
  return {
    root, id, write, delta, receipts,
    readReceipt: async (receiptId) => JSON.parse(await fs.readFile(path.join(receiptsDir, `${receiptId}.json`), 'utf8'))
  };
}

async function finishedTurn(t, checkpointId = 'cp-turn') {
  const f = await fixture(t);
  await f.delta.begin(f.id, checkpointId);
  await f.write('a.txt', 'ZZafterZZ');
  await f.write('new/deep.txt', 'ZZcreatedZZ');
  await f.delta.finish(f.id, checkpointId);
  return f;
}

test('receipt export contains hashes and metadata, never file content bytes', async (t) => {
  const f = await finishedTurn(t);
  const exported = await f.receipts.exportReceipt(f.id, 'cp-turn');
  const receipt = await f.readReceipt(exported.receiptId);
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.format, RECEIPT_FORMAT);
  assert.equal(receipt.version, RECEIPT_VERSION);
  assert.equal(receipt.receiptId, 'rc-cp-turn');
  assert.equal(receipt.hashKind, 'sha256');
  assert.equal(receipt.partial, false);
  assert.deepEqual(receipt.limits, LIMITS);
  assert.equal(receiptFingerprint(receipt), receipt.selfHash);
  const edited = receipt.report.files.find((change) => change.path === 'a.txt');
  assert.deepEqual([edited.kind, edited.beforeHash === null, typeof edited.afterHash === 'string'], ['edited', false, true]);
  assert.equal(receipt.report.previews.started[0].id, 'preview-1');
  assert.equal(receipt.report.git.before.head, 'cafe0000');
  assert.equal(serialized.includes('"content"'), false);
  assert.equal(serialized.includes('ZZbeforeZZ'), false);
  assert.equal(serialized.includes('ZZafterZZ'), false);
  assert.equal(serialized.includes('ZZcreatedZZ'), false);
  assert.equal(receipt.report.omissions.length, 0);
});

test('verifier confirms the exported receipt against live workspace files', async (t) => {
  const f = await finishedTurn(t);
  const { receiptId } = await f.receipts.exportReceipt(f.id, 'cp-turn');
  const verdict = await f.receipts.verifyReceipt(f.id, receiptId);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.selfHashMismatch, false);
  assert.equal(verdict.matched, verdict.checked);
  assert.deepEqual(verdict.invalidatedBy, []);
  assert.match(verdict.message, /Receipt holds — \d+\/\d+ file hashes still match/);
});

test('tampered or deleted workspace files invalidate only affected paths', async (t) => {
  const f = await finishedTurn(t);
  const { receiptId } = await f.receipts.exportReceipt(f.id, 'cp-turn');
  await f.write('a.txt', 'tampered after the receipt');
  await fs.unlink(path.join(f.root, 'new/deep.txt'));
  const verdict = await f.receipts.verifyReceipt(f.id, receiptId);
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.invalidatedBy.sort(), ['a.txt', 'new/deep.txt']);
  assert.match(verdict.message, /Invalidated by 2 file change\(s\): .*a\.txt/);
});

test('altered receipt fails its self-hash before checking workspace files', async (t) => {
  const f = await finishedTurn(t);
  const { receiptId, filePath } = await f.receipts.exportReceipt(f.id, 'cp-turn');
  const tampered = { ...(await f.readReceipt(receiptId)), partial: true };
  await fs.writeFile(filePath, JSON.stringify(tampered, null, 2));
  const verdict = await f.receipts.verifyReceipt(f.id, receiptId);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.selfHashMismatch, true);
  assert.match(verdict.message, /receipt file itself was altered/);
});

test('non-machine or still-recording checkpoints refuse receipt export', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.receipts.exportReceipt(f.id, 'cp-never-captured'), /Only machine-turn checkpoints/);
  await f.delta.begin(f.id, 'cp-recording');
  await assert.rejects(f.receipts.exportReceipt(f.id, 'cp-recording'), /still recording/);
});
