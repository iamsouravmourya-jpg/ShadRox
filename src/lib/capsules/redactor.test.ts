import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactCapsule, sealCapsule, verifyCapsuleIntegrity } from './redactor';
import { CAPSULE_FORMAT, CAPSULE_VERSION } from './types';
import type { ChangeCapsule, CapsuleFileDiff } from './types';

const MARKER = '[REDACTED_SECRET]';

const githubPat = 'ghp_' + 'aB3'.repeat(10);
const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const googleKey = 'AIza' + 'Z'.repeat(25);
const groqKey = 'gsk_' + 'Z'.repeat(25);
const openaiKey = 'sk-' + 'Z'.repeat(25);
const bearerToken = 'abcdefghijklmnopqrstuvwxyz123456';
const bearer = `Bearer ${bearerToken}`;
const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
const pemBody = 'MIIBogIBAAJBALRiMLAHexamplekeymaterial';
const pem = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`;
const assignment = 'API_KEY=abc123secretvalue';

const families: Array<{ name: string; secret: string; raw: string[] }> = [
  { name: 'GitHub PAT', secret: githubPat, raw: [githubPat] },
  { name: 'AWS access key', secret: awsKey, raw: [awsKey] },
  { name: 'Google API key', secret: googleKey, raw: [googleKey] },
  { name: 'Groq key', secret: groqKey, raw: [groqKey] },
  { name: 'OpenAI key', secret: openaiKey, raw: [openaiKey] },
  { name: 'Bearer token', secret: bearer, raw: [bearerToken] },
  { name: 'JWT', secret: jwt, raw: [jwt] },
  { name: 'PEM private key', secret: pem, raw: [pemBody, 'BEGIN RSA PRIVATE KEY'] },
  { name: 'KEY=value assignment', secret: assignment, raw: ['abc123secretvalue'] },
];

for (const family of families) {
  test(`redactText masks ${family.name} and is idempotent`, () => {
    const first = redactText(family.secret);
    assert.ok(first.count >= 1, `expected >=1 mask, got ${first.count}`);
    assert.ok(first.text.includes(MARKER), 'output must contain the redaction marker');
    for (const raw of family.raw) {
      assert.ok(!first.text.includes(raw), `raw secret material survived: ${family.name}`);
    }
    const second = redactText(first.text);
    assert.equal(second.count, 0, 'second pass must mask nothing new');
  });
}

test('redactText leaves non-secret text unchanged with count 0', () => {
  const plain = 'function greet(name) {\n  return "Hello, " + name;\n}\n';
  const result = redactText(plain);
  assert.equal(result.count, 0);
  assert.equal(result.text, plain);
});

test('redactText idempotence across a combined multi-secret payload', () => {
  const combined = families.map((f) => f.secret).join('\n');
  const first = redactText(combined);
  assert.ok(first.count >= families.length);
  const second = redactText(first.text);
  assert.equal(second.count, 0);
});

function makeDiff(overrides: Partial<CapsuleFileDiff> = {}): CapsuleFileDiff {
  return {
    path: 'a.ts',
    kind: 'edited',
    beforeHash: null,
    afterHash: null,
    before: null,
    after: null,
    ...overrides,
  };
}

function makeCapsule(overrides: Partial<ChangeCapsule> = {}): ChangeCapsule {
  return {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    id: 'cap-test-1',
    taskId: 'task-1',
    workspaceRoot: 'C:/repo',
    createdAt: 1700000000000,
    status: 'captured',
    promptIntent: 'plain intent',
    baseHashes: {},
    diffs: [],
    verification: [],
    spend: null,
    machineDeltaRef: null,
    redaction: { redacted: false, fields: [], count: 0 },
    selfHash: '',
    ...overrides,
  };
}

test('redactCapsule masks promptIntent and diff.after, reports fields, and does not mutate input', () => {
  const input = makeCapsule({
    promptIntent: `deploy with ${githubPat}`,
    diffs: [makeDiff({ before: 'clean before content', after: githubPat })],
  });
  const snapshot = JSON.parse(JSON.stringify(input));

  const { capsule: out, report } = redactCapsule(input);

  assert.equal(report.redacted, true);
  assert.equal(report.count, 2);
  assert.ok(report.fields.includes('promptIntent'));
  assert.ok(report.fields.includes('diffs[0].after'));
  assert.ok(!report.fields.includes('diffs[0].before'));
  assert.equal(out.redaction, report);
  assert.ok(!out.promptIntent.includes(githubPat));
  assert.equal(out.diffs[0].after, MARKER);
  assert.equal(out.diffs[0].before, 'clean before content');
  assert.equal(out.selfHash, '', 'redactCapsule must not reseal');

  assert.deepEqual(input, snapshot, 'input capsule was mutated');
  assert.notEqual(out, input);
  assert.notEqual(out.diffs, input.diffs);
  assert.notEqual(out.diffs[0], input.diffs[0]);
});

test('redactCapsule reports diffs[i].before when only the base content holds a secret', () => {
  const input = makeCapsule({
    promptIntent: 'clean',
    diffs: [makeDiff({ before: openaiKey, after: 'clean after' })],
  });
  const { capsule: out, report } = redactCapsule(input);
  assert.equal(report.redacted, true);
  assert.deepEqual(report.fields, ['diffs[0].before']);
  assert.equal(out.diffs[0].before, MARKER);
});

test('redactCapsule on a clean capsule reports no redaction', () => {
  const input = makeCapsule({ diffs: [makeDiff({ before: 'a', after: 'b' })] });
  const { report } = redactCapsule(input);
  assert.equal(report.redacted, false);
  assert.equal(report.count, 0);
  assert.deepEqual(report.fields, []);
});

test('sealCapsule produces a 64-char hex selfHash that verifies', async () => {
  const sealed = await sealCapsule(makeCapsule({ promptIntent: 'hello' }));
  assert.match(sealed.selfHash, /^[0-9a-f]{64}$/);
  assert.equal(await verifyCapsuleIntegrity(sealed), true);
});

test('verifyCapsuleIntegrity detects tampering with diff.after without resealing', async () => {
  const sealed = await sealCapsule(makeCapsule({ diffs: [makeDiff({ after: 'original' })] }));
  const tampered: ChangeCapsule = {
    ...sealed,
    diffs: sealed.diffs.map((d, i) => (i === 0 ? { ...d, after: 'changed' } : d)),
  };
  assert.equal(await verifyCapsuleIntegrity(tampered), false);
});

test('verifyCapsuleIntegrity detects tampering with promptIntent without resealing', async () => {
  const sealed = await sealCapsule(makeCapsule({ promptIntent: 'original intent' }));
  const tampered: ChangeCapsule = { ...sealed, promptIntent: 'evil intent' };
  assert.equal(await verifyCapsuleIntegrity(tampered), false);
});

test('verifyCapsuleIntegrity returns false for an empty selfHash', async () => {
  assert.equal(await verifyCapsuleIntegrity(makeCapsule()), false);
});

test('sealCapsule is deterministic for the same capsule and key order', async () => {
  const capsule = makeCapsule({ promptIntent: 'same' });
  const a = await sealCapsule(capsule);
  const b = await sealCapsule(capsule);
  assert.equal(a.selfHash, b.selfHash);

  const reordered: ChangeCapsule = { selfHash: capsule.selfHash, redaction: capsule.redaction, ...capsule };
  const c = await sealCapsule(reordered);
  assert.equal(c.selfHash, a.selfHash, 'canonicalJson must be insensitive to key insertion order');
});