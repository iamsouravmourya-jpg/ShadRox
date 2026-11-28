import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hashContextContent,
  revalidateContextFreshness,
  revalidateManifestAfterTurn,
  type ContextManifest,
  type ContextSource
} from './contextManifest';
import { dedupeManifestData } from './contextDedup';

const source = (over: Partial<ContextSource>): ContextSource => ({
  path: 'src/App.tsx',
  kind: 'retrieved',
  reason: 'test',
  ranges: [],
  fullFile: true,
  freshness: 'fresh',
  estimatedTokens: 10,
  ...over
});

test('hashContextContent is deterministic and content-sensitive', () => {
  const a = hashContextContent('const x = 1;\n');
  const b = hashContextContent('const x = 1;\n');
  const c = hashContextContent('const x = 2;\n');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('revalidateContextFreshness marks fresh, stale, unknown and adopted', () => {
  const v1 = hashContextContent('one');
  const v2 = hashContextContent('two');
  const sources = [
    source({ path: 'a.ts', version: v1 }),
    source({ path: 'b.ts', version: v1 }),
    source({ path: 'c.ts', version: undefined }),
    source({ path: 'd.ts', version: v1 }),
    source({ path: 'map', kind: 'map', version: v1 })
  ];
  const out = revalidateContextFreshness(sources, {
    'a.ts': v1, // unchanged → fresh
    'b.ts': v2, // changed → stale
    'c.ts': v2, // no prior version → unknown, adopt v2
    'd.ts': null // file gone → stale
    // map has no entry → untouched
  });
  const byPath = Object.fromEntries(out.map((s) => [s.path, s]));
  assert.equal(byPath['a.ts'].freshness, 'fresh');
  assert.equal(byPath['b.ts'].freshness, 'stale');
  assert.equal(byPath['c.ts'].freshness, 'unknown');
  assert.equal(byPath['c.ts'].version, v2);
  assert.equal(byPath['d.ts'].freshness, 'stale');
  assert.equal(byPath['map'].freshness, 'fresh');
});

test('dedupeManifestData records content version and freshness from disk files', () => {
  const { sources } = dedupeManifestData({
    selectedSymbols: [],
    selectedFiles: [],
    workspaceFiles: [],
    activeFile: null,
    diskFiles: [
      { name: 'src/App.tsx', content: 'x', language: 'tsx', version: 'vHASH' },
      { name: 'src/lib.ts', content: 'y', language: 'ts' }
    ],
    repoMap: ''
  });
  const app = sources.find((s) => s.path === 'src/App.tsx');
  const lib = sources.find((s) => s.path === 'src/lib.ts');
  assert.equal(app?.version, 'vHASH');
  assert.equal(app?.freshness, 'fresh');
  // A file with no explicit version still gets a content-hash identity, so its
  // freshness is real ('fresh' now) and a later re-hash can detect a mid-loop edit.
  assert.equal(lib?.version, hashContextContent('y'));
  assert.equal(lib?.freshness, 'fresh');
});

test('revalidateManifestAfterTurn marks only the sources the turn mutated as stale', () => {
  const manifest: ContextManifest = {
    sources: [
      source({ path: 'src/App.tsx', version: hashContextContent('a') }),
      source({ path: 'src/lib.ts', version: hashContextContent('b') }),
      source({ path: 'src/pin.ts', kind: 'pin', ranges: [{ start: 0, end: 1 }], fullFile: false }),
      source({ path: 'repo map', kind: 'map' })
    ],
    missing: [],
    deduped: 0
  };
  const out = revalidateManifestAfterTurn(manifest, ['./src/App.tsx']);
  const byPath = Object.fromEntries(out.sources.map((s) => [s.path, s]));
  assert.equal(byPath['src/App.tsx'].freshness, 'stale', 'edited file is stale');
  assert.equal(byPath['src/lib.ts'].freshness, 'fresh', 'untouched file stays fresh');
  assert.equal(byPath['src/pin.ts'].freshness, 'fresh', 'pin has no version, left as-is');
  assert.equal(byPath['repo map'].freshness, 'fresh', 'map is never revalidated');
  // No changed paths is a no-op that returns the same manifest reference.
  assert.equal(revalidateManifestAfterTurn(manifest, []), manifest);
});