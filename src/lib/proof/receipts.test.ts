/**
 * Durability test for the Self-Healing Proof receipts (deliverable 3).
 *
 * The "complete-or-nothing" check: the renderer's `ProofLedger` writes through
 * the desktop bridge, and the bridge below is the same body `electron/main.cjs`
 * installs on `proof:append-receipt` — the real `proofService`, the real
 * `proofStore` and the real `proofKeyring`, over an injected temp directory.
 * A *new* ledger instance (a simulated app restart) must then read the receipt
 * back with the same proof hash the first session was handed. No hand-made
 * fixtures: every byte on disk is produced by the production writer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ProofLedger, globalProofLedger, hydrateFailureReceipts } from '../proofLedger';
import { createFailureReceipt, proposeRepair, verifyHealing } from '../repairProof';

const moduleUrl = (relative: string) => pathToFileURL(path.resolve(process.cwd(), relative)).href;

const { createProofStore } = await import(moduleUrl('electron/proof-store.cjs'));
const { createProofService, PROOF_APP_SCOPE } = await import(moduleUrl('electron/proof-service.cjs'));
const { createProofKeyring: makeKeyring } = await import(moduleUrl('electron/proof-keyring.cjs'));

/**
 * Installs `globalThis.window.shadroxDesktop.proof` with the main-process
 * handler bodies wired to the real modules. Returns the service so a test can
 * audit the file the same writer produced.
 */
function installDesktopProofBridge(root: string) {
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  };
  const service = createProofService({
    store: createProofStore({ root, safeStorage: fakeSafeStorage }),
    keyring: makeKeyring({ dir: path.join(root, 'proof-keys'), safeStorage: fakeSafeStorage }),
    now: () => 1_700_000_000_000
  });

  const proof = {
    appendReceipt: async (receipt: never, kind?: 'record' | 'update') => {
      const { record, receiptHash } = await service.appendReceipt(receipt, kind === 'update' ? 'receipt.update' : 'receipt.failure');
      return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId, receiptHash };
    },
    appendMilestone: async (milestone: never) => {
      const record = await service.appendMilestone(milestone);
      return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId };
    },
    receipts: () => service.readReceipts(PROOF_APP_SCOPE),
    records: (workspaceId?: string) => service.readRecords(workspaceId ?? PROOF_APP_SCOPE),
    verify: (workspaceId?: string) => service.verify(workspaceId ?? PROOF_APP_SCOPE)
  };

  Object.defineProperty(globalThis, 'window', {
    value: { shadroxDesktop: { platform: 'win32', proof } },
    configurable: true,
    writable: true
  });
  return { proof, service };
}

function withoutDesktopBridge() {
  delete (globalThis as { window?: unknown }).window;
}

test('a receipt recorded before a restart comes back with the same proof hash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-restart-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { service } = installDesktopProofBridge(root);

  // Session 1: exactly the API the agent tool uses — sync record, then a heal.
  const first = new ProofLedger();
  const captured = createFailureReceipt({
    source: 'terminal',
    target: 'npm test',
    errorMessage: '2 tests failed',
    exitCode: 1,
    stackTrace: 'at Object.<anonymous> (src/run.ts:12:3)',
    relevantFiles: ['src/run.ts']
  });
  first.recordFailureReceipt(captured);
  const proposed = proposeRepair(captured, '--- a/src/run.ts\n+++ b/src/run.ts\n');
  first.updateFailureReceipt(proposed);
  const healed = verifyHealing(proposed, { clean: true, evidenceMessage: 'all green' });
  first.updateFailureReceipt(healed);
  await first.flushPersistence();
  const sessionOneHash = first.getFailureReceiptProofHash(captured.id);
  assert.equal(typeof sessionOneHash, 'string');

  // Session 2: a new process hydrating from the same on-disk chain.
  withoutDesktopBridge();
  const second = new ProofLedger();
  installDesktopProofBridge(root);
  assert.equal(await second.hydrate(), 1);

  const back = second.getFailureReceipt(captured.id);
  assert.ok(back);
  assert.deepEqual(back, healed, 'the durable copy must round-trip every receipt field');
  assert.equal(back.status, 'verified_healed');
  assert.equal(second.getFailureReceiptProofHash(captured.id), sessionOneHash);

  const report = await service.verify(PROOF_APP_SCOPE);
  assert.equal(report.ok, true, report.detail);
  assert.equal(report.totalRecords, 3, 'one capture plus two status transitions are three signed entries');
});

test('a forged receipt line is not replayed as proof', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-forged-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { service } = installDesktopProofBridge(root);
  const ledger = new ProofLedger();
  const captured = createFailureReceipt({
    source: 'test',
    target: 'npm test',
    errorMessage: '1 test failed',
    exitCode: 1
  });
  ledger.recordFailureReceipt(captured);
  await ledger.flushPersistence();

  const workspaceDir = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .find((entry) => fs.existsSync(path.join(entry, 'ledger.jsonl')));
  assert.ok(workspaceDir);
  const forged = {
    v: 1,
    seq: 2,
    ts: Date.now(),
    workspace: 'shadrox.app',
    type: 'receipt.update',
    actor: 'system',
    messageId: null,
    data: { receipt: { ...captured, status: 'verified_healed' }, receiptHash: 'forged' },
    prev: '0'.repeat(64),
    keyId: 'k-forged',
    hash: 'forged',
    sig: 'forged'
  };
  fs.appendFileSync(path.join(workspaceDir!, 'ledger.jsonl'), `${JSON.stringify(forged)}\n`);

  const replayed = await service.readReceipts(PROOF_APP_SCOPE);
  assert.equal(replayed.length, 1, 'nothing after the first unverifiable record is trusted');
  assert.equal(replayed[0]!.receipt.status, 'captured');
  assert.notEqual(replayed[0]!.proofHash, 'forged');
});

test('a hostile receipt payload cannot forge a chain field', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-hostile-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { service } = installDesktopProofBridge(root);

  const hostile = createFailureReceipt({
    source: 'terminal',
    target: 'npm test',
    exitCode: 1,
    // Closes its own JSON string and re-opens the fields the chain is made of.
    errorMessage: `", "prev": "${'0'.repeat(64)}", "seq": 99999, "sig": "forged`
  });
  const ledger = new ProofLedger();
  ledger.recordFailureReceipt(hostile);
  await ledger.flushPersistence();

  const entries = await service.readReceipts(PROOF_APP_SCOPE);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].receipt.errorMessage, hostile.errorMessage, 'the payload must survive verbatim, as data');
  assert.equal(entries[0].seq, 1, 'the injected seq claim was ignored');

  const report = await service.verify(PROOF_APP_SCOPE);
  assert.equal(report.ok, true, report.detail);
  assert.equal(report.totalRecords, 1);
});

test('milestone proofs are appended to the same chain', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-milestone-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { service } = installDesktopProofBridge(root);

  const ledger = new ProofLedger();
  ledger.recordMilestoneProof({
    id: 'milestone-1',
    milestoneId: 'm1',
    title: 'Run the test suite',
    verifiedAt: 1_700_000_000_000,
    verdict: 'passed',
    diagnosticsCount: 0
  });
  await ledger.flushPersistence();

  assert.equal(ledger.getSummary().totalMilestonesVerified, 1);
  assert.equal(typeof ledger.getMilestoneProofHash('milestone-1'), 'string');
  const records = await service.readRecords(PROOF_APP_SCOPE);
  assert.equal(records[0].type, 'milestone.verified');
  assert.equal((await service.verify(PROOF_APP_SCOPE)).ok, true);
});

test('hydrateFailureReceipts replays the chain into the global ledger', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-global-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  installDesktopProofBridge(root);

  const receipt = createFailureReceipt({ source: 'compiler', target: 'npm run typecheck', errorMessage: 'TS2345', exitCode: 2 });
  globalProofLedger.recordFailureReceipt(receipt);
  await globalProofLedger.flushPersistence();

  withoutDesktopBridge();
  globalProofLedger.clear();
  installDesktopProofBridge(root);
  assert.equal(await hydrateFailureReceipts(), 1);
  assert.deepEqual(globalProofLedger.getAllFailureReceipts()[0]?.id, receipt.id);
  assert.equal(globalProofLedger.getFailureReceiptProofHash(receipt.id), receipt ? globalProofLedger.getFailureReceiptProofHash(receipt.id) : null);
  assert.equal(typeof globalProofLedger.getFailureReceiptProofHash(receipt.id), 'string');
});

test('without a desktop bridge receipts stay in memory and nothing throws', async () => {
  withoutDesktopBridge();
  const ledger = new ProofLedger();
  const receipt = createFailureReceipt({ source: 'preview', target: 'http://localhost:5173', errorMessage: 'blank frame' });
  ledger.recordFailureReceipt(receipt);
  await ledger.flushPersistence();
  assert.equal(ledger.getAllFailureReceipts().length, 1);
  assert.equal(ledger.getFailureReceiptProofHash(receipt.id), null);
  assert.equal(await ledger.hydrate(), 0);
  assert.equal(ledger.getLastError(), null);
});

test('a failed record is written as a record on the next update, never an orphan update', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-proof-retry-'));
  t.after(() => {
    withoutDesktopBridge();
    globalProofLedger.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { proof, service } = installDesktopProofBridge(root);
  const realAppend = proof.appendReceipt;
  let calls = 0;
  proof.appendReceipt = async (receipt: never, kind?: 'record' | 'update') => {
    calls += 1;
    if (calls === 1) throw new Error('disk full');
    return realAppend(receipt, kind);
  };

  const ledger = new ProofLedger();
  const captured = createFailureReceipt({ source: 'test', target: 'npm test', errorMessage: '1 test failed', exitCode: 1 });
  ledger.recordFailureReceipt(captured);
  await ledger.flushPersistence();
  assert.equal(ledger.getFailureReceiptProofHash(captured.id), null, 'a write that failed is not a durable entry');
  assert.match(ledger.getLastError() ?? '', /disk full/);

  const healed = verifyHealing(proposeRepair(captured, '--- a/x\n+++ b/x\n'), { clean: true, evidenceMessage: 'all green' });
  ledger.updateFailureReceipt(healed);
  await ledger.flushPersistence();
  assert.equal(typeof ledger.getFailureReceiptProofHash(captured.id), 'string', 'the update repairs the missing base');

  const entries = await service.readReceipts(PROOF_APP_SCOPE);
  assert.equal(entries.length, 1, 'one base record carries the latest state; no update without a record');
  assert.equal(entries[0]!.receipt.status, 'verified_healed');
  assert.equal((await service.verify(PROOF_APP_SCOPE)).ok, true);
});
