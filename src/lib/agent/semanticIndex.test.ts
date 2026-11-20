import test from 'node:test';
import assert from 'node:assert/strict';
import type { ShadRoxDesktopAPI } from '../desktop';

const storage = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

/* A tiny fake workspace: two text files under src/, mutable between refreshes. */
const disk: Record<string, string> = {
  'a.ts': "export function validateToken(token: string) {\n  return token.length > 10;\n}\n",
  'src/b.ts': "export function renderButton(label: string) {\n  return `<button>${label}</button>`;\n}\n"
};
let listB = true;
const loadCalls: string[][] = [];

const fakeBridge = {
  listDirectory: async (_id: string, path: string) => {
    if (path === '') {
      return {
        entries: [
          { path: 'a.ts', kind: 'file' },
          { path: 'src', kind: 'directory' }
        ],
        nextCursor: null
      };
    }
    if (path === 'src') {
      return { entries: listB ? [{ path: 'src/b.ts', kind: 'file' }] : [], nextCursor: null };
    }
    return { entries: [], nextCursor: null };
  },
  loadFiles: async (_id: string, paths: string[]) => {
    loadCalls.push(paths);
    const versionOf = (text: string) => {
      let hash = 7;
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      return `v:${text.length}:${hash}`;
    };
    return {
      files: paths.filter((path) => path in disk).map((path) => ({ name: path, content: disk[path], version: versionOf(disk[path]) })),
      missing: []
    };
  },
  saveFiles: async () => ({ saved: [], errors: [] })
} as unknown as ShadRoxDesktopAPI;

(globalThis as unknown as Record<string, unknown>).window = { shadroxDesktop: fakeBridge };

const si = await import('./semanticIndex');

test('tokenize splits camelCase and drops stopwords', () => {
  const tokens = si.tokenize('handleFetchUrl and the XMLParser');
  assert.ok(tokens.includes('handle'));
  assert.ok(tokens.includes('fetch'));
  assert.ok(tokens.includes('url'));
  assert.ok(tokens.includes('xml'));
  assert.ok(tokens.includes('parser'));
  assert.ok(!tokens.includes('and'));
  assert.ok(!tokens.includes('the'));
});

test('chunkText keeps 1-based line ranges and extracts symbols', () => {
  const content = "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n";
  const chunks = si.chunkText(content, 'x.ts');
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].id, 'x.ts#0');
  const symbols = chunks.flatMap((chunk) => chunk.symbols);
  assert.ok(symbols.includes('alpha'));
  assert.ok(symbols.includes('beta'));
  const last = chunks.at(-1);
  assert.ok(last && last.endLine <= content.split('\n').length);
});

test('bm25Rank prefers the defining chunk and boosts matching paths', () => {
  const index = {
    v: 1 as const,
    updatedAt: 0,
    truncated: false,
    files: {
      'src/alpha.ts': {
        version: '1',
        chunks: [{ id: 'src/alpha.ts#0', startLine: 1, endLine: 3, text: 'export function alpha() { return 1; }', symbols: ['alpha'] }]
      },
      'src/notes.ts': {
        version: '1',
        chunks: [{ id: 'src/notes.ts#0', startLine: 1, endLine: 2, text: '// we should call alpha someday, maybe', symbols: [] }]
      }
    }
  };
  const ranked = si.bm25Rank(index, 'alpha', 5);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].path, 'src/alpha.ts');
  assert.ok(ranked[0].score > ranked[1].score + 2); // symbol + path boosts are decisive
  assert.deepEqual(si.bm25Rank(index, 'zzzznothing', 5), []);
  assert.ok(si.cosineSimilarity([1, 0], [1, 0]) > 0.99);
  assert.equal(si.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(si.cosineSimilarity([], [1]), 0);
});

test('refresh is incremental: re-chunks only changed files, removes deleted ones', async () => {
  storage.clear();
  si.resetSemanticIndexCache();
  const first = await si.refreshSemanticIndex('ws-idx', true);
  assert.equal(first.scanned, 2);
  assert.equal(first.rechunked, 2);
  assert.equal(first.removed, 0);
  assert.ok(first.index.files['a.ts']);
  assert.ok(first.index.files['src/b.ts']);

  const second = await si.refreshSemanticIndex('ws-idx', true);
  assert.equal(second.rechunked, 0); // identical versions: nothing re-chunked

  disk['a.ts'] = disk['a.ts'].replace('token.length > 10', 'token.length > 20');
  const third = await si.refreshSemanticIndex('ws-idx', true);
  assert.equal(third.rechunked, 1);
  assert.ok(third.index.files['a.ts'].chunks[0].text.includes('> 20'));

  listB = false;
  const fourth = await si.refreshSemanticIndex('ws-idx', true);
  assert.equal(fourth.removed, 1);
  assert.ok(!fourth.index.files['src/b.ts']);
  listB = true;

  // The index persisted to localStorage and survives a cache reset.
  si.resetSemanticIndexCache();
  const persisted = await si.refreshSemanticIndex('ws-idx', true);
  assert.ok(persisted.index.files['a.ts']);
});

test('handleSemanticSearch ranks without any API key and reports file:line', async () => {
  storage.clear();
  si.resetSemanticIndexCache();
  const result = await si.handleSemanticSearch('ws-search', { query: 'validateToken' });
  assert.equal(result.ok, true);
  assert.ok(result.content.includes('a.ts:1'));
  assert.ok(result.content.includes('lexical'));
  assert.ok(result.content.includes('Mode:'));

  const empty = await si.handleSemanticSearch('ws-search', { query: 'x' });
  assert.equal(empty.refused, true);
  const noMatch = await si.handleSemanticSearch('ws-search', { query: 'qqqzzzwww' });
  assert.equal(noMatch.ok, true);
  assert.ok(noMatch.content.includes('No chunk matched'));
});

test('a failed embedding rerank falls back to lexical honestly', async () => {
  storage.clear();
  si.resetSemanticIndexCache();
  // A key-shaped value enables the rerank attempt; fetch is stubbed to fail.
  storage.set('shadrox.byok.gemini', 'AIzaSyTEST-KEY-PLACEHOLDER-000000000');
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = async () => { throw new Error('network down'); };
  try {
    const result = await si.handleSemanticSearch('ws-fallback', { query: 'validateToken' });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes('a.ts:1'));
    assert.ok(/rerank unavailable|lexical/.test(result.content));
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
    storage.clear();
  }
});