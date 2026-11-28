/**
 * Scalability guards and large-project tools: the multi-megabyte OOM guards on
 * read_file/write_file/apply_patch, and the find_by_glob / git_diff /
 * test_changed tools that keep big repos workable. A stub bridge stands in for
 * the main process; everything under test is production code in tools.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyToolEffect, isKnownTool, runTool } from './tools';
import { beginTurn, noteWrite, resetTurns } from './turnState';
import { clearWorkspacePendingChanges, setWorkspaceAutoSave } from './pendingChanges';
import { clearRepoMapCache } from './repoMap';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { shadroxDesktop: { platform: 'win32', ...stub } },
    configurable: true,
    writable: true
  });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

const TEN_MB = 10 * 1024 * 1024;

test('the three large-project tools are known and classified correctly', () => {
  assert.equal(isKnownTool('find_by_glob'), true);
  assert.equal(isKnownTool('git_diff'), true);
  assert.equal(isKnownTool('test_changed'), true);
  assert.equal(classifyToolEffect('find_by_glob'), 'read');
  assert.equal(classifyToolEffect('git_diff'), 'read');
  assert.equal(classifyToolEffect('test_changed'), 'execute');
});

test('read_file refuses a file above the OOM limit instead of loading it whole', async () => {
  const huge = 'x'.repeat(TEN_MB + 16);
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (path === 'huge.bin') return { name: path, content: huge, version: 'v1' };
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    }
  }, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'huge.bin' } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.match(outcome.error as string, /read limit/);
    assert.match(outcome.error as string, /search_text/);
  });
});

test('write_file refuses to load an existing file above the edit limit', async () => {
  const huge = 'y'.repeat(TEN_MB + 16);
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: huge, version: 'v1' })
  }, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'big.ts', content: 'tiny\n' } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.match(outcome.error as string, /edit limit/);
  });
});

test('apply_patch refuses when the aggregate new content exceeds the per-call budget', async () => {
  resetTurns();
  setWorkspaceAutoSave('ws', false);
  try {
    const chunk = 'z'.repeat(5 * 1024 * 1024);
    await withBridge({}, async () => {
      const outcome = await runTool('ws', {
        name: 'apply_patch',
        args: { patches: [
          { path: 'a.ts', old: '', new: chunk },
          { path: 'b.ts', old: '', new: chunk }
        ] }
      });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.refused, true);
      assert.match(outcome.error as string, /per-call limit/);
      assert.match(outcome.error as string, /NOTHING was written/);
    });
  } finally {
    clearWorkspacePendingChanges('ws');
  }
});

test('find_by_glob walks directories and returns only glob matches', async () => {
  const pages: Record<string, { entries: Array<{ path: string; kind: 'file' | 'directory' }>; nextCursor: number | null }> = {
    '': { entries: [{ path: 'src', kind: 'directory' }, { path: 'README.md', kind: 'file' }], nextCursor: null },
    src: { entries: [{ path: 'src/a.test.ts', kind: 'file' }, { path: 'src/b.ts', kind: 'file' }], nextCursor: null }
  };
  await withBridge({
    listDirectory: async (_id: string, dir: string) => pages[dir] ?? { entries: [], nextCursor: null }
  }, async () => {
    const outcome = await runTool('ws', { name: 'find_by_glob', args: { pattern: '**/*.test.ts' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /src\/a\.test\.ts/);
    assert.doesNotMatch(outcome.content, /src\/b\.ts/);
    assert.doesNotMatch(outcome.content, /README/);
  });
});

test('find_by_glob reports no matches cleanly', async () => {
  await withBridge({
    listDirectory: async () => ({ entries: [{ path: 'a.ts', kind: 'file' }], nextCursor: null })
  }, async () => {
    const outcome = await runTool('ws', { name: 'find_by_glob', args: { pattern: '**/*.py' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /No files match/);
  });
});

test('git_diff returns the per-path diff and a clear message when empty', async () => {
  await withBridge({
    gitFileDiff: async (_id: string, path: string, staged: boolean) => {
      assert.equal(path, 'src/a.ts');
      assert.equal(staged, false);
      return 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new';
    }
  }, async () => {
    const outcome = await runTool('ws', { name: 'git_diff', args: { path: 'src/a.ts', staged: false } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /diff --git a\/src\/a\.ts/);
    assert.match(outcome.content, /\+new/);
  });

  await withBridge({
    gitFileDiff: async () => ''
  }, async () => {
    const outcome = await runTool('ws', { name: 'git_diff', args: { path: 'src/clean.ts', staged: false } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /No .*diff for src\/clean\.ts/);
  });
});

test('test_changed runs the file-targeted vitest command for changed files', async () => {
  resetTurns();
  const turn = beginTurn('ws', 'change a test', { scaffold: false, addPage: false });
  noteWrite(turn, ['src/a.test.ts']);
  let ranCommand = '';
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (path === 'package.json') {
        return { name: path, content: JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }), version: 'v1' };
      }
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    },
    runCommand: async (_id: string, command: string) => {
      ranCommand = command;
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    }
  }, async () => {
    const outcome = await runTool('ws', { name: 'test_changed', args: {} });
    assert.equal(outcome.ok, true, `test_changed should pass, got: ${outcome.error ?? outcome.content}`);
    assert.match(ranCommand, /^npx vitest run/);
    assert.match(ranCommand, /src\/a\.test\.ts/);
    assert.match(outcome.content, /tested 1 changed file/);
  });
});

test('test_changed refuses when nothing changed this turn', async () => {
  resetTurns();
  await withBridge({}, async () => {
    const outcome = await runTool('ws', { name: 'test_changed', args: {} });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.match(outcome.error as string, /no files changed this turn/);
  });
});

test('get_dependents lists downstream importers from the cached import graph', async () => {
  clearRepoMapCache();
  const contents: Record<string, string> = {
    'src/api/client.ts': 'export function apiClient() { return 0; }\n',
    'src/billing/checkout.ts': "import { apiClient } from '../api/client';\nexport function Checkout() { return apiClient(); }\n"
  };
  const dirs: Record<string, Array<{ path: string; kind: 'file' | 'directory' }>> = {
    '': [{ path: 'src', kind: 'directory' }],
    src: [{ path: 'src/api', kind: 'directory' }, { path: 'src/billing', kind: 'directory' }],
    'src/api': [{ path: 'src/api/client.ts', kind: 'file' }],
    'src/billing': [{ path: 'src/billing/checkout.ts', kind: 'file' }]
  };
  await withBridge({
    listDirectory: async (_id: string, dir: string) => ({ entries: dirs[dir] ?? [], nextCursor: null }),
    loadFiles: async (_id: string, batch: string[]) => ({
      files: batch.map((name) => ({ name, content: contents[name] ?? '', version: 'v1' })),
      missing: []
    })
  }, async () => {
    const outcome = await runTool('ws', { name: 'get_dependents', args: { path: 'src/api/client.ts' } });
    assert.equal(outcome.ok, true, outcome.error ?? outcome.content);
    assert.match(outcome.content, /downstream dependent/);
    assert.match(outcome.content, /src\/billing\/checkout\.ts/);
    assert.match(outcome.content, /apiClient/);
  });
});