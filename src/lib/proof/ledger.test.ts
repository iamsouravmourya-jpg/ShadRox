import assert from 'node:assert/strict';
import test from 'node:test';
import { ProofLedger, type ProofLedgerIo } from './ledger';
import { verifyProofLedger, type VerifyIo } from './verify';

function memoryIo(): VerifyIo & { ledger: () => string } {
  let ledger = '';
  let keys: string | null = null;
  const io: VerifyIo = {
    async readLedger() { return ledger || null; },
    async appendLine(line: string) {
      ledger = ledger ? `${ledger}\n${line}` : line;
    },
    async readKeys() { return keys; },
    async writeKeys(text: string) { keys = text; },
    live: { async readLive() { return null; } }
  };
  return Object.assign(io, { ledger: () => ledger });
}

test('proof ledger appends a signed command record that verifies', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io satisfies ProofLedgerIo, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  const record = await ledger.append({
    type: 'command.run',
    actor: 'agent',
    messageId: 'm1',
    data: { argv: 'npm test', exitCode: 0 }
  });
  assert.equal(record.seq, 1);
  assert.equal(record.workspace, 'ws-1');
  assert.equal(record.prev, '0'.repeat(64));

  const report = await verifyProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  assert.equal(report.chainValid, true);
  assert.equal(report.totalRecords, 1);
  assert.equal(report.claims[0]?.status, 'recorded');
});

test('a rewritten proof hash fails verification', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  await ledger.append({ type: 'command.denied', actor: 'agent', data: { deniedReason: 'blocked' } });
  const parsed = JSON.parse(io.ledger()) as { hash: string };
  parsed.hash = 'f'.repeat(64);
  const broken: ProofLedgerIo = {
    async readLedger() { return JSON.stringify(parsed); },
    async appendLine() { throw new Error('unused'); },
    readKeys: io.readKeys,
    writeKeys: io.writeKeys
  };
  const report = await verifyProofLedger({ ...broken, live: io.live }, { workspace: 'ws-1' });
  assert.equal(report.chainValid, false);
  assert.equal(report.tamperedRecords.length, 1);
});
