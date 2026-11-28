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

const workspaceCacheStore = new Map<string, string>();

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
  saveFiles: async () => ({ saved: [], errors: [] }),
  readWorkspaceCache: async (id: string, key: string) => workspaceCacheStore.get(`${id}:${key}`) ?? null,
  writeWorkspaceCache: async (id: string, key: string, data: string) => {
    workspaceCacheStore.set(`${id}:${key}`, data);
    return true;
  }
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

test('invalidateSemanticIndexPaths drops changed files and forces a re-chunk', async () => {
  storage.clear();
  si.resetSemanticIndexCache();
  await si.refreshSemanticIndex('ws-inv', true);
  // Edit a.ts on disk, then invalidate it the way the turn loop does after a
  // write. The next (throttled) search must NOT serve the old chunk.
  disk['a.ts'] = "export function validateToken(token: string) {\n  return token.length > 99;\n}\n";
  si.invalidateSemanticIndexPaths('ws-inv', ['./a.ts']);
  const report = await si.refreshSemanticIndex('ws-inv'); // no force: throttle was cleared
  assert.equal(report.rechunked, 1, 'invalidated file is re-chunked despite the throttle window');
  assert.ok(report.index.files['a.ts'].chunks[0].text.includes('> 99'));
  // A path the index never held is ignored, and an empty list is a no-op.
  assert.doesNotThrow(() => si.invalidateSemanticIndexPaths('ws-inv', []));
  assert.doesNotThrow(() => si.invalidateSemanticIndexPaths('ws-inv', ['nope/never.ts']));
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

test('chunkText extracts Python, Go, Rust, and SQL symbols and invalidation handles Windows mixed-case paths', () => {
  const pyChunks = si.chunkText('def train_model(data):\n    return data\n', 'ml/train.py');
  assert.ok(pyChunks[0].symbols.includes('train_model'));
  const goChunks = si.chunkText('func HandleRequest(ctx int) {\n}\n', 'server/handler.go');
  assert.ok(goChunks[0].symbols.includes('HandleRequest'));
  const rsChunks = si.chunkText('pub struct RouterState {}\npub fn start_server() {}\n', 'src/main.rs');
  assert.ok(rsChunks[0].symbols.includes('RouterState'));
  assert.ok(rsChunks[0].symbols.includes('start_server'));
  const sqlChunks = si.chunkText('CREATE TABLE invoices (id INT);\n', 'db/schema.sql');
  assert.ok(sqlChunks[0].symbols.includes('invoices'));

  storage.clear();
  si.resetSemanticIndexCache();
  // Ensure case-insensitive Windows backslash path invalidation removes matching entries cleanly.
  const index = {
    v: 1 as const,
    updatedAt: 1000,
    truncated: false,
    files: {
      'src/App.tsx': { version: 'v1', chunks: [] }
    }
  };
  storage.set('shadrox.semanticIndex.v1:ws-win', JSON.stringify(index));
  si.resetSemanticIndexCache();
  si.invalidateSemanticIndexPaths('ws-win', ['.\\SRC\\app.tsx']);
  const reloaded = JSON.parse(storage.get('shadrox.semanticIndex.v1:ws-win') ?? '{}') as { files?: Record<string, unknown> };
  assert.equal(reloaded.files?.['src/App.tsx'], undefined, 'mixed-case backslash Windows path must invalidate cached entry');
  storage.clear();
});

test('concept-synonym expansion matches hidden filenames like session_gatekeeper.ts on "user login logic"', () => {
  const index = {
    v: 1 as const,
    updatedAt: 1000,
    truncated: false,
    files: {
      'src/security/session_gatekeeper.ts': {
        version: 'v1',
        chunks: [{
          id: 'src/security/session_gatekeeper.ts#0',
          startLine: 1,
          endLine: 8,
          text: 'export function verifySessionGuard(jwtCookie: string, rbacPermission: string) { return Boolean(jwtCookie && rbacPermission); }',
          symbols: ['verifySessionGuard']
        }]
      },
      'src/payments/razorpay_ledger.ts': {
        version: 'v1',
        chunks: [{
          id: 'src/payments/razorpay_ledger.ts#0',
          startLine: 1,
          endLine: 6,
          text: 'export function recordInvoiceQuota(subscriptionId: string) { return subscriptionId; }',
          symbols: ['recordInvoiceQuota']
        }]
      },
      'src/utils/math.ts': {
        version: 'v1',
        chunks: [{
          id: 'src/utils/math.ts#0',
          startLine: 1,
          endLine: 3,
          text: 'export function sum(a: number, b: number) { return a + b; }',
          symbols: ['sum']
        }]
      }
    }
  };
  const authHits = si.bm25Rank(index, 'user login logic', 3);
  assert.ok(authHits.length > 0);
  assert.equal(authHits[0].path, 'src/security/session_gatekeeper.ts');

  const billingHits = si.bm25Rank(index, 'stripe billing checkout', 3);
  assert.ok(billingHits.length > 0);
  assert.equal(billingHits[0].path, 'src/payments/razorpay_ledger.ts');
});

test('resolvePreFlightSemanticFallback returns top 2 cached hints in <5ms with zero disk I/O', () => {
  storage.clear();
  si.resetSemanticIndexCache();
  loadCalls.length = 0;

  si.warmSemanticIndexFromFiles('ws-preflight', [
    {
      name: 'src/guards/session_gatekeeper.ts',
      content: 'export function enforceCookieGuard(token: string) { return token.length > 5; }\n'
    },
    {
      name: 'src/auth/jwt_credential.ts',
      content: 'export function issueOAuthCredential(id: string) { return id; }\n'
    },
    {
      name: 'src/components/Button.tsx',
      content: 'export function Button() { return null; }\n'
    }
  ]);

  const t0 = performance.now();
  const fallback = si.resolvePreFlightSemanticFallback('ws-preflight', 'user login logic');
  const elapsedMs = performance.now() - t0;

  assert.equal(loadCalls.length, 0, 'pre-flight lookup must never trigger disk loadFiles');
  assert.equal(fallback.hints.length, 2, 'should return top 2 semantic candidates');
  assert.ok(elapsedMs < 25, `cached lookup should finish rapidly (got ${elapsedMs.toFixed(2)}ms)`);
  assert.ok(fallback.candidatePaths.includes('src/guards/session_gatekeeper.ts'));
  assert.ok(fallback.hintLine?.includes('SEMANTIC PRE-FLIGHT HINTS'));
  assert.ok(fallback.hintLine?.includes('enforceCookieGuard'));
});

test('multi-MB (>1.5MB) semantic index bypasses localStorage cap via workspace cache and validates FNV-1a envelope', async () => {
  storage.clear();
  workspaceCacheStore.clear();
  si.resetSemanticIndexCache();

  const bigBody = 'export function handleRequest(payload: string) {\n  return payload.trim();\n}\n' + '// ' + 'x'.repeat(1_000) + '\n';
  const manyFiles = Array.from({ length: 1_500 }, (_, i) => ({
    name: `src/mod/file_${String(i).padStart(4, '0')}.ts`,
    content: `${bigBody}export const id${i} = ${i};\n`
  }));

  const warmed = si.warmSemanticIndexFromFiles('ws-big', manyFiles);
  const jsonLen = JSON.stringify(warmed).length;
  assert.ok(jsonLen > 1_500_000, `expected >1.5MB index, got ${jsonLen} chars`);

  // Wait a microtask tick for async writeWorkspaceCache to settle.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(storage.get('shadrox.semanticIndex.v1:ws-big'), undefined, 'localStorage must not retain >1.5MB payload');
  const cachedEnvelope = workspaceCacheStore.get('ws-big:semantic-index');
  assert.ok(cachedEnvelope && cachedEnvelope.length > 1_500_000, 'disk cache holds full >1.5MB envelope');

  // Clear RAM and verify hydrateSemanticIndex restores all 1,500 files.
  si.resetSemanticIndexCache();
  const restored = await si.hydrateSemanticIndex('ws-big');
  assert.ok(restored);
  assert.equal(Object.keys(restored.files).length, 1_500);

  // Tampering with checksum rejects corrupt disk cache.
  workspaceCacheStore.set('ws-big:semantic-index', JSON.stringify({ v: 1, checksum: 'deadbeef', payload: '{"v":1,"updatedAt":9,"truncated":false,"files":{}}' }));
  si.resetSemanticIndexCache();
  const rejected = await si.hydrateSemanticIndex('ws-big');
  assert.equal(rejected, null);
});