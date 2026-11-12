import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { contentVersion, expectedDiskVersion } from './saveVersions';

const nodeHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

test('the renderer hashes a file body exactly like the desktop does', async () => {
  for (const content of ['', 'one\ntwo\n', 'café — 日本語 😀', 'x'.repeat(100_000)]) {
    assert.equal(await contentVersion(content), nodeHash(content));
  }
});

test('a restored buffer with no version pins the text the app last knew was on disk', async () => {
  const baseline = 'disk text the user has not touched\n';
  const pinned = await expectedDiskVersion({ version: undefined }, baseline);
  assert.equal(pinned, nodeHash(baseline));
});

test('a file the app never read from disk pins nothing, and no hash is computed', async () => {
  let hashed = 0;
  const hash = async () => {
    hashed += 1;
    return 'never called';
  };
  assert.equal(await expectedDiskVersion({ version: undefined }, undefined, hash), undefined);
  assert.equal(hashed, 0, 'a baseline-less file must not invent an expectation');
});

test('a version remembered from the disk read outranks the baseline hash', async () => {
  const pinned = await expectedDiskVersion({ version: 'abcdef0123' }, 'some older text', async () => 'the hash');
  assert.equal(pinned, 'abcdef0123');
});

test('a blank version is not a version, so the baseline hash is used instead', async () => {
  assert.equal(await expectedDiskVersion({ version: '' }, 'text', async () => 'the-hash'), 'the-hash');
});
