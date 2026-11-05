import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCommitContext, generateCommitMessage } from './commitMessage';

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

test('git-derived secrets are scrubbed before commit-message provider handoff', async () => {
  const token = `ghp_${'A'.repeat(36)}`;
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return { ok: true, json: async () => ({ message: 'fix: protect config' }) } as Response;
  }) as typeof fetch;
  try {
    await generateCommitMessage({
      status: 'M src/config.ts',
      diff: `+const API_KEY = "${token}";`,
      log: ''
    }, { provider: 'gemini', model: 'gemini-flash' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((requestBody?.diff as string).includes(token), false);
  assert.match(requestBody?.diff as string, /API_KEY = \[REDACTED_SECRET\]/);
});
