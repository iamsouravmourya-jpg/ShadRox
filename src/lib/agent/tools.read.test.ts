import assert from 'node:assert/strict';
import test from 'node:test';
import { runTool } from './tools';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

test('read_file defaults to reading up to 400 lines in one call (main agent)', async () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  await withBridge({ readFile: async () => ({ name: 'src/big.ts', content: long, version: 'v1' }) }, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'src/big.ts' } });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.content.includes('Total lines: 500 | Showing lines 1-400'), 'header reports 400-line cap');
    assert.ok(outcome.content.includes('lines (>400). Showing lines 1-400'), 'guidance tells the model to range-read');
    assert.ok(outcome.content.includes('search_text'), 'guidance points to outline/search_text');
    const shown = outcome.content.split('\n').filter((line) => /^\d+\| /.test(line));
    assert.equal(shown.length, 400, 'read_file caps at 400 lines by default');
  });

  const short = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  await withBridge({ readFile: async () => ({ name: 'src/small.ts', content: short, version: 'v1' }) }, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'src/small.ts' } });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.content.includes('Total lines: 50 | Showing lines 1-50'), 'short files read in full');
    const shown = outcome.content.split('\n').filter((line) => /^\d+\| /.test(line));
    assert.equal(shown.length, 50, 'no cap applied to a <=400 line file');
  });
});

test('read_files batches reads via loadFiles, falls back on missing, masks .env, and enforces traversal guard', async () => {
  const longLines = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
  let loadFilesCalled = 0;
  await withBridge({
    loadFiles: async (_id: string, paths: string[]) => {
      loadFilesCalled += 1;
      const files: Array<{ name: string; content: string; version: string }> = [];
      const missing: Array<{ path: string; reason: string }> = [];
      for (const p of paths) {
        if (p === 'src/long.ts') files.push({ name: p, content: longLines, version: 'v1' });
        else if (p === '.env') files.push({ name: p, content: 'API_KEY=super-secret-token-value\nPORT=3000\n', version: 'v1' });
        else missing.push({ path: p, reason: 'ENOENT' });
      }
      return { files, missing };
    }
  }, async () => {
    const outcome = await runTool('ws', {
      name: 'read_files',
      args: {
        paths: ['src/long.ts', '.env', 'src/missing.ts'],
        ranges: [{ path: 'src/long.ts', start_line: 260, end_line: 265 }]
      }
    });
    assert.equal(outcome.ok, true);
    assert.equal(loadFilesCalled, 1, 'uses batch loadFiles once instead of sequential RPCs');
    assert.ok(outcome.content.includes('[File: src/long.ts | Total lines: 300 | Showing lines 1-250]'));
    assert.ok(outcome.content.includes('showing first 250 of 300 lines'));
    assert.ok(outcome.content.includes('[File: src/long.ts | Total lines: 300 | Showing lines 260-265]'));
    assert.ok(!outcome.content.includes('super-secret-token-value'), '.env secrets are masked');
    assert.ok(outcome.content.includes('[File: src/missing.ts | Error: ENOENT]'));

    const traversal = await runTool('ws', { name: 'read_files', args: { paths: ['../etc/passwd'] } });
    assert.equal(traversal.refused, true);
  });
});

test('outline extracts multi-language signatures (Python/SQL) when TS outline returns empty', async () => {
  const files: Record<string, string> = {
    'app/worker.py': 'def process_batch(items):\n    return len(items)\n\nclass QueueRunner:\n    pass\n',
    'db/schema.sql': 'CREATE TABLE users (\n  id INT PRIMARY KEY\n);\nCREATE FUNCTION get_user() RETURNS INT AS $$ SELECT 1; $$;\n'
  };
  await withBridge({
    readFile: async (_id: string, p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return { name: p, content: files[p], version: 'v1' };
    }
  }, async () => {
    const pyOut = await runTool('ws', { name: 'outline', args: { path: 'app/worker.py' } });
    assert.equal(pyOut.ok, true);
    assert.match(pyOut.content, /function process_batch @1/);
    assert.match(pyOut.content, /class QueueRunner @4/);

    const sqlOut = await runTool('ws', { name: 'outline', args: { path: 'db/schema.sql' } });
    assert.equal(sqlOut.ok, true);
    assert.match(sqlOut.content, /users @1/);
    assert.match(sqlOut.content, /get_user @4/);
  });
});

test('find_by_glob honours .gitignore rules and fails open when .gitignore is absent', async () => {
  const tree: Record<string, Array<{ path: string; kind: 'file' | 'directory' }>> = {
    '': [
      { path: 'src', kind: 'directory' },
      { path: 'coverage', kind: 'directory' }
    ],
    'src': [{ path: 'src/index.ts', kind: 'file' }],
    'coverage': [{ path: 'coverage/report.ts', kind: 'file' }]
  };
  await withBridge({
    readFile: async (_id: string, p: string) => {
      if (p === '.gitignore') return { name: '.gitignore', content: 'coverage/\n', version: 'v1' };
      throw new Error('ENOENT');
    },
    listDirectory: async (_id: string, dir: string) => ({ entries: tree[dir] ?? [], nextCursor: null })
  }, async () => {
    const ignoredRes = await runTool('ws', { name: 'find_by_glob', args: { pattern: '**/*.ts' } });
    assert.equal(ignoredRes.ok, true);
    assert.match(ignoredRes.content, /src\/index\.ts/);
    assert.doesNotMatch(ignoredRes.content, /coverage\/report\.ts/);
  });

  await withBridge({
    readFile: async () => { throw new Error('ENOENT'); },
    listDirectory: async (_id: string, dir: string) => ({ entries: tree[dir] ?? [], nextCursor: null })
  }, async () => {
    const openRes = await runTool('ws', { name: 'find_by_glob', args: { pattern: '**/*.ts' } });
    assert.equal(openRes.ok, true);
    assert.match(openRes.content, /src\/index\.ts/);
    assert.match(openRes.content, /coverage\/report\.ts/);
  });
});

