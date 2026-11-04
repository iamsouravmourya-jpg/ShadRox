import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompletionTrie,
  boostFor,
  ingestDocument,
  resetProjectRegistry,
  trailingIdentifier
} from './completionTrie.ts';

test('single-word insert tracks one leaf and one terminal weight', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();
  trie.insert('workspaceFolder');

  assert.equal(trie.size, 1);
  assert.equal(trie.leafCountFor('workspaceFolder'), 1);
  assert.equal(trie.rankCandidates('workspaceF', { minWeight: 1, limit: 4 })[0]?.weight, 1);
});

test('multi-word boundaries keep shared prefixes under one prefix node', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();
  trie.insert('filePaths');
  trie.insert('workspaceFile');

  const candidates = trie.rankCandidates('work', { minWeight: 1, limit: 10 });
  assert.ok(candidates.some((entry) => entry.candidate === 'workspaceFile'));
  assert.equal(trie.mostCommonPrefix('work', 1), 'workspaceFile');
  assert.equal(trie.leafCountFor('work'), 1);
});

test('prefix ranking prefers the heavier identifier first', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();
  trie.insert('authConfig');
  trie.insert('authConfig');
  trie.insert('authConfig');
  trie.insert('readmeMd');

  const ranked = trie.rankCandidates('auth', { minWeight: 1, limit: 10 });
  assert.equal(ranked[0]?.candidate, 'authConfig');
  assert.equal(ranked[0]?.weight, 3);
  assert.equal(trie.mostCommonPrefix('auth', 1), 'authConfig');
});

test('remove decrements leaf counts and maintains accurate cycles', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();

  for (let index = 0; index < 5; index += 1) {
    trie.insert('authConfig');
    assert.equal(trie.leafCountFor('authConfig'), 1);
    assert.equal(trie.rankCandidates('auth', { minWeight: 1, limit: 5 })[0]?.weight, 1);
    trie.remove('authConfig');
    assert.equal(trie.leafCountFor('authConfig'), 0);
  }
});

test('long keys are rejected silently', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();
  trie.insert('x'.repeat(129));

  assert.equal(trie.size, 0);
  assert.equal(trie.leafCountFor('x'.repeat(129)), 0);
});

test('subtree scans stop after the collection budget', () => {
  resetProjectRegistry();
  const trie = new CompletionTrie();
  for (let index = 0; index < 8_000; index += 1) {
    trie.insert(`alpha${index.toString(36)}`);
  }

  const ranked = trie.rankCandidates('alpha', { minWeight: 1, limit: 50 });
  assert.ok(ranked.length > 0);
  assert.ok(ranked.length <= 50);
  assert.ok(ranked.every((entry) => entry.weight >= 1));
});

test('ingesting workspace paths resolves typed project identifiers', () => {
  resetProjectRegistry();
  for (const file of ['src/lib/workspace.ts', 'src/components/App.tsx', 'src/lib/auth/config.ts']) {
    ingestDocument(file, file);
  }

  assert.equal(trailingIdentifier('const ap'), 'ap');
  assert.equal(trailingIdentifier('const con'), 'con');
  assert.ok((boostFor('ap')?.candidate ?? '').toLowerCase().includes('app'));
  assert.ok((boostFor('con')?.candidate ?? '').toLowerCase().includes('config'));
});
