import assert from 'node:assert/strict';
import test from 'node:test';
import { ProofLedger, canonicalJson, unsignedOf, webcryptoEd25519, type ProofLedgerIo } from './ledger';
import { verifyProofLedger, type VerifyIo } from './verify';
import { GENESIS_HASH, RECORD_VERSION, keyIdOfPublicJwk, lineOf, signedPayloadOf } from '../../../electron/proof-chain.cjs';
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
  assert.equal(record.prev, GENESIS_HASH);

  const report = await verifyProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  assert.equal(report.chainValid, true);
  assert.equal(report.totalRecords, 1);
  assert.equal(report.claims[0]?.status, 'recorded');
});

test('the renderer ledger writes the canonical schema the main process reads', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  const record = await ledger.append({ type: 'receipt.failure', actor: 'system', data: { receiptId: 'r-1' } });

  assert.deepEqual(Object.keys(record), [
    'v', 'seq', 'ts', 'workspace', 'type', 'actor', 'messageId', 'data', 'prev', 'keyId', 'hash', 'sig'
  ]);
  assert.equal(record.v, RECORD_VERSION);
  assert.equal(record.messageId, null, 'an absent message id is canonicalised to null');

  // The on-disk line is byte-for-byte what the shared serializer produces.
  assert.equal(io.ledger().trim(), lineOf(record));
  assert.equal(unsignedOf(record), signedPayloadOf(record));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.match(record.keyId, /^k-[0-9a-f]{12}$/);
  // The registry entry the renderer wrote must carry the same fingerprint the
  // main process derives from the same public JWK with Node's SHA-256.
  const registry = JSON.parse((await io.readKeys())!) as { current: string; keys: Array<{ keyId: string; publicJwk: JsonWebKey }> };
  assert.equal(registry.current, record.keyId);
  assert.equal(keyIdOfPublicJwk(registry.keys[0]!.publicJwk), record.keyId);
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
  assert.deepEqual(report.tamperedRecords, [1]);
});

test('receipt and milestone event types chain, and rotation keeps old records valid', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  await ledger.append({ type: 'receipt.failure', actor: 'system', data: { receipt: { id: 'r-1', status: 'captured' } } });
  await ledger.append({ type: 'receipt.update', actor: 'system', data: { receipt: { id: 'r-1', status: 'verified_healed' } } });
  const rotated = await ledger.rotateKey();
  await ledger.append({ type: 'milestone.verified', actor: 'system', data: { milestoneId: 'm1', verdict: 'passed' } });

  const report = await verifyProofLedger(io, { workspace: 'ws-1' });
  assert.equal(report.chainValid, true, report.summary);
  assert.equal(report.totalRecords, 3);
  assert.equal(report.keyIds.length, 2);
  assert.ok(report.keyIds.includes(rotated));
});

test('command output cannot forge a ledger line or a chain field', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  const hostile = `"\n{"seq":99,"prev":"${'f'.repeat(64)}"}\n`;
  const record = await ledger.append({
    type: 'command.run',
    actor: 'agent',
    data: { stderr: hostile }
  });
  const text = io.ledger();
  assert.equal(text.split('\n').length, 1, 'a payload newline must never split a record across lines');
  assert.deepEqual(JSON.parse(text).data.stderr, hostile);
  assert.equal(record.seq, 1);
  const report = await verifyProofLedger(io, { workspace: 'ws-1' });
  assert.equal(report.chainValid, true);
});

test('a torn last line is reported instead of being chained onto', async () => {
  const io = memoryIo();
  const ledger = new ProofLedger(io, { workspace: 'ws-1', now: () => 1_700_000_000_000 });
  await ledger.append({ type: 'turn.usage', actor: 'agent', data: { tokens: 10 } });
  const tornLedger: ProofLedgerIo = {
    async readLedger() { return `${io.ledger()}\n{"seq":2,"hash":"cut`; },
    async appendLine() { throw new Error('must not append onto a torn chain'); },
    readKeys: io.readKeys,
    writeKeys: io.writeKeys
  };
  const damaged = new ProofLedger(tornLedger, { workspace: 'ws-1' });
  await assert.rejects(damaged.append({ type: 'turn.usage', actor: 'agent', data: {} }), /torn record/);
  assert.equal(damaged.sawTruncatedTail, true);

  const report = await verifyProofLedger(
    { ...tornLedger, live: { async readLive() { return null; } } },
    { workspace: 'ws-1' }
  );
  assert.equal(report.truncatedTail, true);
  assert.equal(report.chainValid, false);
});

