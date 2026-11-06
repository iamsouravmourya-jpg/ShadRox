'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProofStore } = require('./proof-store.cjs');
const { createProofKeyring, PUBLIC_FILE } = require('./proof-keyring.cjs');
const { createProofService } = require('./proof-service.cjs');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(repoRoot, 'scripts', 'verify-proofs.mjs');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8')
  };
}

function runVerifier(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: repoRoot }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function seedLedger(root) {
  const safeStorage = fakeSafeStorage();
  const store = createProofStore({ root: path.join(root, 'proof-ledgers'), safeStorage });
  const keyring = createProofKeyring({ dir: path.join(root, 'proof-keys'), safeStorage });
  const service = createProofService({ store, keyring });
  await service.append('ws-1', { type: 'command.run', actor: 'agent', data: { commandHash: 'a'.repeat(64) } });
  await service.append('ws-1', { type: 'turn.usage', actor: 'agent', data: { tokens: 10 } });
  return { store, keyring, service };
}

test('npm run verify:proofs accepts a ledger the real writer produced', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-verify-proofs-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await seedLedger(root);

  const result = await runVerifier(['--root', path.join(root, 'proof-ledgers'), '--keys', path.join(root, 'proof-keys')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /OK {4}/);
  assert.match(result.stdout, /2 record\(s\)/);
  assert.ok(fs.existsSync(path.join(root, 'proof-keys', PUBLIC_FILE)));
});

test('npm run verify:proofs rejects a ledger whose record was rewritten', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-verify-proofs-tamper-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await seedLedger(root);

  const ledgerRoot = path.join(root, 'proof-ledgers');
  const [workspace] = fs.readdirSync(ledgerRoot);
  const ledgerFile = path.join(ledgerRoot, workspace, 'ledger.jsonl');
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  const record = JSON.parse(lines[1]);
  record.data.tokens = 999;
  lines[1] = JSON.stringify(record);
  fs.writeFileSync(ledgerFile, `${lines.join('\n')}\n`);

  const result = await runVerifier(['--ledger', ledgerFile, '--keys', path.join(root, 'proof-keys')]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /tampered 2/);
});
