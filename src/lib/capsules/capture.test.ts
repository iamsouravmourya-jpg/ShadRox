import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Hex } from '../proof/ledger';
import { buildCapsule } from './capture';
import { verifyCapsuleIntegrity } from './redactor';
import { CAPSULE_FORMAT, CAPSULE_VERSION, type CapsuleCaptureInput } from './types';

const input = (overrides: Partial<CapsuleCaptureInput> = {}): CapsuleCaptureInput => ({
  taskId: 'task-1',
  workspaceRoot: 'C:/repo',
  promptIntent: 'Refactor the widget',
  baseFiles: [],
  postFiles: [],
  ...overrides
});

test('edited file produces one diff with raw hashes and sealed integrity', async () => {
  const captureInput = input({
    baseFiles: [{ path: 'a.ts', content: 'old' }],
    postFiles: [{ path: 'a.ts', content: 'new' }]
  });
  const before = JSON.stringify(captureInput);
  const capsule = await buildCapsule(captureInput);

  assert.equal(capsule.format, CAPSULE_FORMAT);
  assert.equal(capsule.version, CAPSULE_VERSION);
  assert.match(capsule.id, /^cap-\d+-[a-z0-9]+$/);
  assert.equal(capsule.status, 'captured');
  assert.equal(capsule.diffs.length, 1);
  const diff = capsule.diffs[0];
  assert.equal(diff.path, 'a.ts');
  assert.equal(diff.kind, 'edited');
  assert.equal(diff.beforeHash, await sha256Hex('old'));
  assert.equal(diff.afterHash, await sha256Hex('new'));
  assert.equal(diff.before, 'old');
  assert.equal(diff.after, 'new');
  assert.equal(capsule.baseHashes['a.ts'], await sha256Hex('old'));
  assert.match(capsule.selfHash, /^[0-9a-f]{64}$/);
  assert.equal(capsule.redaction.redacted, false);
  assert.equal(await verifyCapsuleIntegrity(capsule), true);
  assert.equal(JSON.stringify(captureInput), before, 'buildCapsule must not mutate its input');
});

test('new post file is a created diff with null before', async () => {
  const capsule = await buildCapsule(input({ postFiles: [{ path: 'n.ts', content: 'x' }] }));
  assert.equal(capsule.diffs.length, 1);
  const diff = capsule.diffs[0];
  assert.equal(diff.kind, 'created');
  assert.equal(diff.path, 'n.ts');
  assert.equal(diff.before, null);
  assert.equal(diff.beforeHash, null);
  assert.equal(diff.after, 'x');
  assert.equal(diff.afterHash, await sha256Hex('x'));
});

test('missing post file is a deleted diff with null after', async () => {
  const capsule = await buildCapsule(input({ baseFiles: [{ path: 'd.ts', content: 'x' }] }));
  assert.equal(capsule.diffs.length, 1);
  const diff = capsule.diffs[0];
  assert.equal(diff.kind, 'deleted');
  assert.equal(diff.path, 'd.ts');
  assert.equal(diff.before, 'x');
  assert.equal(diff.beforeHash, await sha256Hex('x'));
  assert.equal(diff.after, null);
  assert.equal(diff.afterHash, null);
});

test('unchanged file produces no diff', async () => {
  const capsule = await buildCapsule(input({
    baseFiles: [{ path: 's.ts', content: 'same' }],
    postFiles: [{ path: 's.ts', content: 'same' }]
  }));
  assert.equal(capsule.diffs.length, 0);
});

test('paths match case-insensitively across separators, keeping post casing', async () => {
  const capsule = await buildCapsule(input({
    baseFiles: [{ path: '.\\src\\A.ts', content: 'old' }],
    postFiles: [{ path: 'src/a.ts', content: 'new' }]
  }));
  assert.equal(capsule.diffs.length, 1);
  assert.equal(capsule.diffs[0].kind, 'edited');
  assert.equal(capsule.diffs[0].path, 'src/a.ts');
});

test('secrets are redacted before sealing and the seal still verifies', async () => {
  const capsule = await buildCapsule(input({
    promptIntent: 'Set up the environment',
    postFiles: [{ path: '.env', content: 'API_KEY=supersecretvalue123\n' }]
  }));
  assert.equal(capsule.diffs.length, 1);
  const after = capsule.diffs[0].after ?? '';
  assert.ok(after.includes('[REDACTED_SECRET]'), 'masked marker present');
  assert.ok(!after.includes('supersecretvalue123'), 'raw secret must not survive');
  assert.equal(capsule.redaction.redacted, true);
  assert.ok(capsule.redaction.count >= 1);
  assert.match(capsule.selfHash, /^[0-9a-f]{64}$/);
  assert.equal(await verifyCapsuleIntegrity(capsule), true);
});

test('multi-file mixed snapshot yields created + edited + deleted, skipping unchanged', async () => {
  const capsule = await buildCapsule(input({
    baseFiles: [
      { path: 'keep.ts', content: 'same' },
      { path: 'edit.ts', content: 'old' },
      { path: 'gone.ts', content: 'bye' }
    ],
    postFiles: [
      { path: 'keep.ts', content: 'same' },
      { path: 'edit.ts', content: 'new' },
      { path: 'add.ts', content: 'fresh' }
    ]
  }));
  assert.equal(capsule.diffs.length, 3);
  const byPath = new Map(capsule.diffs.map((diff) => [diff.path, diff]));
  assert.equal(byPath.get('add.ts')?.kind, 'created');
  assert.equal(byPath.get('edit.ts')?.kind, 'edited');
  assert.equal(byPath.get('gone.ts')?.kind, 'deleted');
  assert.equal(byPath.has('keep.ts'), false);
  assert.equal(await verifyCapsuleIntegrity(capsule), true);
});