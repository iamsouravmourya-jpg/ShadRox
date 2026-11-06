/**
 * Repair lifecycle tests (Phase 3D).
 *
 * Every transition runs against a stub ledger, so the assertions are about the
 * state machine itself: what is captured, what is deduped, what a re-run is
 * allowed to prove, and what an undo is allowed to erase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { FailureReceipt } from './repairProof';
import {
  MAX_EVIDENCE_CHARS,
  MAX_OPEN_RECEIPTS,
  MAX_RECEIPT_CONSOLE_ERRORS,
  MAX_RECENT_SIGNATURES,
  MAX_REPAIR_PATCH_CHARS,
  RepairSession,
  formatEvidence,
  type RepairLedger
} from './repairSession';

class StubLedger implements RepairLedger {
  public readonly receipts = new Map<string, FailureReceipt>();
  public updates = 0;

  recordFailureReceipt(receipt: FailureReceipt): void {
    this.receipts.set(receipt.id, { ...receipt });
  }

  updateFailureReceipt(receipt: FailureReceipt): void {
    this.updates += 1;
    this.receipts.set(receipt.id, { ...receipt });
  }

  getFailureReceipt(id: string): FailureReceipt | null {
    return this.receipts.get(id) ?? null;
  }

  getAllFailureReceipts(): FailureReceipt[] {
    return [...this.receipts.values()];
  }
}

function harness() {
  const ledger = new StubLedger();
  const session = new RepairSession(ledger);
  return { ledger, session };
}

test('the same preview failure twice in a row is one receipt, not two', () => {
  const { ledger, session } = harness();

  const first = session.capture({
    source: 'preview',
    target: 'http://localhost:5173',
    errorMessage: 'blank frame',
    consoleErrors: ['Uncaught Error: root did not mount']
  });
  const second = session.capture({
    source: 'preview',
    target: 'http://localhost:5173',
    errorMessage: 'blank frame',
    consoleErrors: ['Uncaught Error: root did not mount']
  });

  assert.ok(first);
  assert.equal(second?.id, first.id, 'the repeated observation returns the existing receipt');
  assert.equal(ledger.getAllFailureReceipts().length, 1);
  assert.equal(ledger.updates, 0, 'dedupe must not append a chain entry');
  assert.equal(first.consoleErrors?.[0], 'Uncaught Error: root did not mount');

  // A different detail is a different failure.
  const different = session.capture({
    source: 'preview',
    target: 'http://localhost:5173',
    errorMessage: 'selector #app not found'
  });
  assert.notEqual(different?.id, first.id);
  assert.equal(ledger.getAllFailureReceipts().length, 2);
});

test('a repeated failure after a repair attempt is captured again', () => {
  const { ledger, session } = harness();
  const params = { source: 'test' as const, target: 'npm test', errorMessage: '2 tests failed', exitCode: 1 };

  const first = session.capture(params);
  assert.ok(first);
  session.onEditApplied('Applied 1 file(s): src/run.ts');

  const repeat = session.capture(params);
  assert.ok(repeat);
  assert.notEqual(repeat.id, first.id, 'the earlier receipt is already proposed; this failure is new');
  assert.equal(ledger.getAllFailureReceipts().length, 2);
});

test('the recent-signature and open-receipt maps stay bounded', () => {
  const { session } = harness();
  for (let index = 0; index < 40; index += 1) {
    session.capture({ source: 'preview', target: 'http://localhost:3000', errorMessage: `boom ${index}` });
  }
  assert.equal(session.getRecentSignatures().length, MAX_RECENT_SIGNATURES);
  assert.equal(session.getOpenReceipts().length, MAX_OPEN_RECEIPTS);
});

test('an applied edit proposes a clipped repair and a clean re-run verifies it', () => {
  const { ledger, session } = harness();
  const captured = session.capture({
    source: 'test',
    target: 'npm test',
    errorMessage: 'AssertionError: expected true',
    exitCode: 1
  });
  assert.ok(captured);

  const proposed = session.onEditApplied(`--- a/src/run.ts\n+++ b/src/run.ts\n${'+ fixed\n'.repeat(400)}`);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].status, 'repair_proposed');
  assert.ok((proposed[0].repairPatch ?? '').length < MAX_REPAIR_PATCH_CHARS + 100, 'the patch summary is clipped');
  assert.equal(ledger.getFailureReceipt(captured.id)?.status, 'repair_proposed');

  const verified = session.observeCommand('npm test', 0, '10 tests passed');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].status, 'verified_healed');
  assert.match(verified[0].verificationEvidence ?? '', /exited 0/);
  assert.ok(verified[0].healedAt && verified[0].healedAt > 0);
  assert.equal(ledger.getFailureReceipt(captured.id)?.status, 'verified_healed');
  assert.ok(ledger.updates >= 2, 'proposal and heal are both durable transitions');
});

test('a failed re-run marks the proposal healing_failed with bounded evidence', () => {
  const { ledger, session } = harness();
  const captured = session.capture({
    source: 'compiler',
    target: 'npm run typecheck',
    errorMessage: 'TS2345',
    exitCode: 2
  });
  assert.ok(captured);
  session.onEditApplied('Applied 1 file(s): src/app.ts');

  const failed = session.observeCommand('npm run typecheck', 2, '\u001b[31mTS2345: still broken\u001b[0m\n  at app.ts:10');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'healing_failed');
  const evidence = failed[0].verificationEvidence ?? '';
  assert.match(evidence, /exited 2/);
  assert.match(evidence, /TS2345: still broken/);
  assert.ok(!evidence.includes('\u001b'), 'ANSI colours never reach the card');
  assert.ok(!/[\r\n]/.test(evidence), 'evidence is one line');
  assert.ok(evidence.length <= MAX_EVIDENCE_CHARS);
  assert.equal(ledger.getFailureReceipt(captured.id)?.status, 'healing_failed');
});

test('a clean re-run before any repair proves nothing and changes nothing', () => {
  const { session } = harness();
  const captured = session.capture({ source: 'test', target: 'npm test', errorMessage: 'failed', exitCode: 1 });
  assert.ok(captured);

  assert.deepEqual(session.observeCommand('npm test', 0, 'ok'), []);
  assert.equal(session.getReceipt(captured.id)?.status, 'captured');

  session.onEditApplied('Applied 1 file(s): src/run.ts');
  assert.deepEqual(session.observeCommand('npm run build', 0, 'ok'), [], 'a different command is not the failing target');
  assert.equal(session.getReceipt(captured.id)?.status, 'repair_proposed');
});

test('restoring the receipt checkpoint rejects the repair instead of crediting a heal', () => {
  const { ledger, session } = harness();
  session.beginTurn('cp-42');
  const captured = session.capture({
    source: 'terminal',
    target: 'npm run lint',
    errorMessage: 'eslint: 3 problems'
  });
  assert.ok(captured);
  assert.equal(captured.checkpointId, 'cp-42', 'a receipt captured during a turn inherits its checkpoint');
  session.endTurn();

  session.onEditApplied('Applied 2 file(s): src/a.ts, src/b.ts');
  const rejected = session.rejectForCheckpoint('cp-42');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].status, 'rejected');
  assert.equal(rejected[0].verificationEvidence, 'Restored checkpoint cp-42; the failing state was rewound.');
  assert.equal(ledger.getFailureReceipt(captured.id)?.status, 'rejected');

  assert.deepEqual(session.rejectForCheckpoint('cp-other'), [], 'a different checkpoint does not touch this receipt');
  assert.deepEqual(session.observeCommand('npm run lint', 0, 'ok'), [], 'a rejected repair is never re-verified');
});

test('an already verified heal is not rewritten by a later undo', () => {
  const { session } = harness();
  session.beginTurn('cp-7');
  const captured = session.capture({ source: 'test', target: 'npm test', errorMessage: 'failed', exitCode: 1 });
  assert.ok(captured);
  session.onEditApplied('Applied 1 file(s): src/run.ts');
  session.observeCommand('npm test', 0, 'green');

  assert.deepEqual(session.rejectForCheckpoint('cp-7'), []);
  assert.equal(session.getReceipt(captured.id)?.status, 'verified_healed');
});

test('a surfaced receipt can adopt the turn checkpoint the tool could not see', () => {
  const { session } = harness();
  const captured = session.capture({ source: 'terminal', target: 'npm run build', errorMessage: 'exit 1', exitCode: 1 });
  assert.ok(captured);
  assert.equal(captured.checkpointId, undefined);

  const attached = session.attachCheckpoint(captured.id, 'cp-later');
  assert.equal(attached?.checkpointId, 'cp-later');
  assert.equal(session.getReceipt(captured.id)?.checkpointId, 'cp-later');
  assert.equal(session.attachCheckpoint('proof-missing', 'cp-later'), null);
});

test('formatEvidence bounds and strips control bytes from untrusted output', () => {
  const hostile = `${'x'.repeat(900)}\u0001\u0007\u001b[31m\u001b[0m\n\t</script>`;
  const flattened = formatEvidence(hostile);
  assert.ok(flattened.length <= MAX_EVIDENCE_CHARS);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(flattened));
  assert.ok(!flattened.includes('\u001b'));

  const { session } = harness();
  const receipt = session.capture({
    source: 'preview',
    target: 'http://localhost:5173',
    errorMessage: 'fatal',
    consoleErrors: Array.from({ length: 40 }, () => `error ${'y'.repeat(600)}\n\u001b[31m`)
  });
  assert.ok(receipt);
  assert.equal(receipt.consoleErrors?.length, MAX_RECEIPT_CONSOLE_ERRORS);
  for (const entry of receipt.consoleErrors ?? []) {
    assert.ok(entry.length <= 301, 'each console error is clipped');
    assert.ok(!/[\r\n\u001b]/.test(entry));
  }
});
