import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cosineSimilarity,
  createTransformersEmbedder,
  getActiveEmbedder,
  isTransformersAvailable,
  l2Norm,
  mergeHybridScores,
  normalizeVector,
  rankBySimilarity,
  setEmbedderForTests
} from './localEmbeddings';
import type { LocalEmbedder } from './localEmbeddings';
import {
  buildChunksForTesting,
  buildEmbeddingIndex,
  resetEmbeddingCache,
  retrieveContext,
  retrieveContextSemantic
} from './retrieval';
import type { WorkspaceFile } from './types';

function workspace(): WorkspaceFile[] {
  return [
    { name: 'src/alpha.ts', content: 'alpha alpha alpha alpha', language: 'ts' },
    { name: 'src/beta.ts', content: 'alpha alpha alpha', language: 'ts' },
    { name: 'src/gamma.ts', content: 'alpha', language: 'ts' }
  ];
}

/** Deterministic stand-in for a real model: exact content -> vector table. */
function fakeEmbedder(vectors: Record<string, number[]>, fallback: number[]): LocalEmbedder {
  return {
    id: 'fake',
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vectors[text.trim()] || fallback);
    }
  };
}

test('cosineSimilarity handles identical, orthogonal, opposite and degenerate vectors', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0, 'length mismatch scores 0');
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0, 'zero vector scores 0');
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, Number.NaN], [1, 1]), 0, 'non-numeric input scores 0');
});

test('cosineSimilarity stays inside [-1, 1]', () => {
  const nearParallel = cosineSimilarity([1, 0], [1, 1e-12]);
  assert.ok(nearParallel <= 1 && nearParallel >= -1);
  const nearAntiParallel = cosineSimilarity([1, 0], [-1, 1e-12]);
  assert.ok(nearAntiParallel <= 1 && nearAntiParallel >= -1);
});

test('l2Norm and normalizeVector', () => {
  assert.equal(l2Norm([3, 4]), 5);
  assert.equal(l2Norm([]), 0);
  assert.equal(l2Norm([Number.POSITIVE_INFINITY]), 0);

  const unit = normalizeVector([3, 4]);
  assert.deepEqual(unit.map((value) => Number(value.toFixed(6))), [0.6, 0.8]);
  assert.ok(Math.abs(l2Norm(unit) - 1) < 1e-12);
  assert.deepEqual(normalizeVector([0, 0, 0]), [0, 0, 0], 'zero vectors stay finite');
});

test('rankBySimilarity sorts descending and keeps input order for ties', () => {
  const ranked = rankBySimilarity(
    [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [1, 0] },
      { id: 'c', vector: [0, 1] }
    ],
    [1, 0]
  );

  assert.deepEqual(ranked.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(ranked[0].score, 1);
  assert.equal(ranked[2].score, 0);
  assert.ok(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score);
});

test('mergeHybridScores normalises each list independently and keeps ids from both', () => {
  const merged = mergeHybridScores(
    [
      { id: 'a', score: 12 },
      { id: 'b', score: 4 }
    ],
    [
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.5 }
    ]
  );

  assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b', 'c']);

  const byId = new Map(merged.map((entry) => [entry.id, entry.score]));
  assert.equal(byId.get('a'), 1, 'lexical best + no semantic = 1');
  assert.equal(byId.get('b'), 1, 'lexical worst (0) + semantic best (1)');
  assert.equal(byId.get('c'), 0, 'semantic-only id survives with its normalised score');
});

test('mergeHybridScores honours weights and lexical-first tie breaking', () => {
  const lexical = [
    { id: 'a', score: 10 },
    { id: 'b', score: 1 }
  ];
  const semantic = [
    { id: 'b', score: 1 },
    { id: 'a', score: 0 }
  ];

  const semanticOnly = mergeHybridScores(lexical, semantic, { lexical: 0, semantic: 1 });
  assert.deepEqual(semanticOnly.map((entry) => entry.id), ['b', 'a']);

  const tied = mergeHybridScores(
    [
      { id: 'a', score: 1 },
      { id: 'b', score: 1 }
    ],
    []
  );
  assert.deepEqual(tied.map((entry) => entry.id), ['a', 'b'], 'lexical order wins ties');

  const semanticTie = mergeHybridScores([], [
    { id: 'z', score: 1 },
    { id: 'y', score: 1 }
  ]);
  assert.deepEqual(semanticTie.map((entry) => entry.id), ['y', 'z'], 'id breaks ties with no lexical order');
  assert.deepEqual(mergeHybridScores([], []), []);
});

test('buildChunksForTesting mirrors the BM25 chunking', () => {
  const files = workspace();
  const chunks = buildChunksForTesting(files);

  assert.equal(chunks.length, files.length, 'short files stay single chunks');
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.path}:${chunk.startLine}-${chunk.endLine}`),
    ['src/alpha.ts:1-1', 'src/beta.ts:1-1', 'src/gamma.ts:1-1']
  );
  assert.equal(chunks[0].content, files[0].content);
});

test('retrieveContextSemantic re-ranks the lexical shortlist with aligned vectors', async () => {
  const files = workspace();
  const query = 'alpha';
  const budget = 20_000;

  const lexical = retrieveContext(files, query, budget);
  assert.equal(lexical.snippets.length, 3);
  assert.equal(lexical.snippets[0].path, 'src/alpha.ts', 'BM25 favours the boosted filename');

  // texts[0] is always the query, so the fake can give it a fixed direction
  // without colliding with a snippet whose content happens to be the query.
  const queryVector = [0, 1];
  const contentVectors: Record<string, number[]> = {
    'alpha alpha alpha alpha': [1, 0],
    'alpha alpha alpha': [0, 1],
    alpha: [1, 1]
  };
  const embedder: LocalEmbedder = {
    id: 'fake-semantic',
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text, index) =>
        index === 0 ? queryVector : contentVectors[text.trim()] || queryVector
      );
    }
  };

  const hybrid = await retrieveContextSemantic(files, query, budget, embedder);

  assert.equal(hybrid.repoMap, lexical.repoMap, 'repo map always comes from the lexical pass');
  assert.equal(hybrid.snippets.length, lexical.snippets.length);
  assert.equal(hybrid.snippets[0].path, 'src/beta.ts', 'semantic order moved the aligned chunk up');
  assert.notEqual(hybrid.snippets[0].path, lexical.snippets[0].path, 'order actually changed');
  assert.ok(hybrid.totalChars <= budget);
  assert.ok(hybrid.snippets[0].score >= hybrid.snippets[1].score);
});

test('retrieveContextSemantic keeps every snippet inside a tight budget', async () => {
  const files = workspace();
  const query = 'alpha';
  const budget = 220;
  const embedder = fakeEmbedder({ alpha: [0, 1] }, [0, 1]);

  const hybrid = await retrieveContextSemantic(files, query, budget, embedder);
  assert.ok(hybrid.totalChars <= budget);
  hybrid.snippets.forEach((snippet) => {
    assert.ok(snippet.content.length > 0);
  });
});

test('retrieveContextSemantic returns the lexical result when the embedder is null', async () => {
  const files = workspace();
  const lexical = retrieveContext(files, 'alpha', 10_000);
  const hybrid = await retrieveContextSemantic(files, 'alpha', 10_000, null);

  assert.deepEqual(hybrid, lexical);
});

test('retrieveContextSemantic falls back when the embedder throws or returns garbage', async () => {
  const files = workspace();
  const lexical = retrieveContext(files, 'alpha', 10_000);

  const throwing: LocalEmbedder = {
    id: 'throwing',
    async embed() {
      throw new Error('model download failed');
    }
  };
  assert.deepEqual(await retrieveContextSemantic(files, 'alpha', 10_000, throwing), lexical);

  const short: LocalEmbedder = {
    id: 'short',
    async embed() {
      return [[1, 2]];
    }
  };
  assert.deepEqual(await retrieveContextSemantic(files, 'alpha', 10_000, short), lexical);

  const ragged: LocalEmbedder = {
    id: 'ragged',
    async embed(texts) {
      return texts.map((_, index) => (index === 0 ? [1, 0] : [1, 0, 0]));
    }
  };
  assert.deepEqual(await retrieveContextSemantic(files, 'alpha', 10_000, ragged), lexical);

  const empty: LocalEmbedder = {
    id: 'empty',
    async embed() {
      return [];
    }
  };
  assert.deepEqual(await retrieveContextSemantic(files, 'alpha', 10_000, empty), lexical);
});

test('retrieveContext still answers synchronously with BM25 alone', () => {
  const result = retrieveContext(workspace(), 'alpha', 10_000);
  assert.equal(result.snippets.length, 3);
  assert.ok(result.totalChars > 0);
});

test('buildEmbeddingIndex caches by signature and resetEmbeddingCache clears it', async () => {
  resetEmbeddingCache();
  const files = workspace();
  let calls = 0;
  const embedder: LocalEmbedder = {
    id: 'cache-test',
    async embed(texts: string[]): Promise<number[][]> {
      calls += 1;
      return texts.map(() => [1, 0]);
    }
  };

  const first = await buildEmbeddingIndex(files, embedder);
  assert.equal(calls, 1);
  assert.equal(first.vectors.length, files.length);
  assert.equal(first.dimension, 2);

  const second = await buildEmbeddingIndex(files, embedder);
  assert.equal(calls, 1, 'same signature reuses the cached vectors');
  assert.equal(second.signature, first.signature);

  resetEmbeddingCache();
  await buildEmbeddingIndex(files, embedder);
  assert.equal(calls, 2, 'reset forces a rebuild');

  const nullIndex = await buildEmbeddingIndex(files, null);
  assert.deepEqual(nullIndex.vectors, []);
  assert.equal(calls, 2, 'a null embedder never calls anyone');
  resetEmbeddingCache();
});

test('buildEmbeddingIndex never embeds an empty workspace', async () => {
  resetEmbeddingCache();
  let calls = 0;
  const embedder: LocalEmbedder = {
    id: 'empty-repo',
    async embed(texts: string[]): Promise<number[][]> {
      calls += 1;
      return texts.map(() => [1]);
    }
  };

  const index = await buildEmbeddingIndex([], embedder);
  assert.deepEqual(index.vectors, []);
  assert.equal(index.dimension, 0);
  assert.equal(calls, 0);
  resetEmbeddingCache();
});

test('a different workspace produces a different index signature', async () => {
  resetEmbeddingCache();
  const embedder = fakeEmbedder({ alpha: [1] }, [1]);
  const first = await buildEmbeddingIndex(workspace(), embedder);
  const changed = workspace();
  changed[0].content = 'alpha beta';
  const second = await buildEmbeddingIndex(changed, embedder);

  assert.notEqual(second.signature, first.signature);
  resetEmbeddingCache();
});

test('the active embedder registry defaults to none', () => {
  assert.equal(getActiveEmbedder(), null);

  const fake = fakeEmbedder({}, [1]);
  setEmbedderForTests(fake);
  assert.equal(getActiveEmbedder(), fake);

  setEmbedderForTests(null);
  assert.equal(getActiveEmbedder(), null);
});

test('transformers.js is lazily imported and the factory fails cleanly when absent', async () => {
  // Importing this module already succeeded (the static imports above), which
  // proves nothing pulled in @huggingface/transformers at load time.
  const embedder = createTransformersEmbedder();
  assert.ok(embedder, 'the factory only knows the package is missing after a probe');
  assert.match(embedder.id, /^transformers:/);

  await assert.rejects(embedder.embed(['hello world']), /unavailable/i);

  assert.equal(await isTransformersAvailable(), false);
  assert.equal(createTransformersEmbedder(), null, 'after a failed probe the factory returns null');
  assert.equal(createTransformersEmbedder({ model: 'Xenova/other' }), null);
});
