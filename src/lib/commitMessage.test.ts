import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCommitContext } from './commitMessage';

test('falls back to dirty editor buffers outside a git folder', async () => {
  const source = await collectCommitContext(null, ['src/a.ts', 'src/b.ts'], [{ name: 'src/a.ts', content: '' }]);
  assert.equal(source.status, 'M src/a.ts\nM src/b.ts');
  assert.equal(source.diff, '');
  assert.equal(source.log, '');
});

test('lists every file when nothing is unsaved', async () => {
  const source = await collectCommitContext(null, [], [{ name: 'index.html', content: '<h1/>' }]);
  assert.equal(source.status, 'A index.html');
});

test('has no context for an empty workspace', async () => {
  const source = await collectCommitContext(null, [], []);
  assert.equal(source.status, '');
});
