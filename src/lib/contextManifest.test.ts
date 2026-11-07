import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContextManifest,
  contextManifestTotals,
  mergeContextSources,
  renderContextManifest,
  shouldSubmitOnEnter,
  unionRanges,
  type ContextSource
} from './contextManifest';

function source(overrides: Partial<ContextSource> & { path: string }): ContextSource {
  return {
    kind: 'retrieved',
    reason: 'relevant match',
    ranges: [],
    fullFile: false,
    freshness: 'fresh',
    estimatedTokens: 100,
    ...overrides
  };
}

describe('unionRanges (S05)', () => {
  it('folds overlapping and touching ranges into one (S05)', () => {
    assert.deepEqual(unionRanges([{ start: 10, end: 20 }, { start: 15, end: 25 }]), [{ start: 10, end: 25 }]);
    assert.deepEqual(unionRanges([{ start: 0, end: 5 }, { start: 5, end: 9 }]), [{ start: 0, end: 9 }]);
  });

  it('keeps disjoint ranges separate and sorted (S05)', () => {
    assert.deepEqual(unionRanges([{ start: 40, end: 50 }, { start: 0, end: 10 }]), [
      { start: 0, end: 10 },
      { start: 40, end: 50 }
    ]);
  });
});

describe('mergeContextSources (S05)', () => {
  it('counts one copy when active, pinned and attached ranges overlap (S05)', () => {
    const merged = mergeContextSources([
      source({ path: 'src/parser.ts', kind: 'active', ranges: [{ start: 10, end: 20 }], estimatedTokens: 200 }),
      source({ path: 'src/parser.ts', kind: 'pin', ranges: [{ start: 18, end: 30 }], estimatedTokens: 200 }),
      source({ path: 'src/parser.ts', kind: 'attachment', ranges: [{ start: 0, end: 10 }], estimatedTokens: 200 })
    ]);
    assert.equal(merged.sources.length, 1);
    assert.equal(merged.deduped, 2);
    assert.deepEqual(merged.sources[0].ranges, [{ start: 0, end: 30 }]);
  });

  it('keeps the strongest kind and reason for a shared path (S05)', () => {
    const merged = mergeContextSources([
      source({ path: 'src/parser.ts', kind: 'retrieved', reason: 'fuzzy match' }),
      source({ path: 'src/parser.ts', kind: 'target', reason: 'you attached this file' })
    ]);
    assert.equal(merged.sources[0].kind, 'target');
    assert.equal(merged.sources[0].reason, 'you attached this file');
  });

  it('a whole-file read outranks ranges and is not re-billed per contributor (S05)', () => {
    const merged = mergeContextSources([
      source({ path: 'a.ts', kind: 'retrieved', ranges: [{ start: 0, end: 40 }], estimatedTokens: 300 }),
      source({ path: 'a.ts', kind: 'target', fullFile: true, estimatedTokens: 900 })
    ]);
    assert.equal(merged.sources.length, 1);
    assert.equal(merged.sources[0].fullFile, true);
    assert.equal(merged.sources[0].estimatedTokens, 900);
  });

  it('one stale contributor makes the merged source stale (S05)', () => {
    const merged = mergeContextSources([
      source({ path: 'a.ts', freshness: 'fresh' }),
      source({ path: 'a.ts', freshness: 'stale' })
    ]);
    assert.equal(merged.sources[0].freshness, 'stale');
  });
});

describe('buildContextManifest (S05)', () => {
  it('names an explicit target that resolved to nothing instead of assuming it was sent (S05)', () => {
    const manifest = buildContextManifest({
      sources: [source({ path: 'src/parser.ts' })],
      targets: ['src/parser.ts', 'src/never-opened.ts'],
      resolvedPaths: ['src/parser.ts']
    });
    assert.deepEqual(manifest.missing, ['src/never-opened.ts']);
  });

  it('treats a resolved pin as present without needing its exact target spelling (S05)', () => {
    const manifest = buildContextManifest({
      sources: [source({ path: 'src/parser.ts', kind: 'pin', fullFile: true })],
      targets: ['src/parser.ts#parse'],
      resolvedPaths: []
    });
    assert.deepEqual(manifest.missing, []);
  });

  it('matches targets across separators and case (S05)', () => {
    const manifest = buildContextManifest({
      sources: [],
      targets: ['src\\Parser.ts'],
      resolvedPaths: ['src/parser.ts']
    });
    assert.deepEqual(manifest.missing, []);
  });
});

describe('manifest reflection and IME (S05)', () => {
  it('totals reflect the merged sources, not the raw contributions (S05)', () => {
    const manifest = buildContextManifest({
      sources: [
        source({ path: 'a.ts', estimatedTokens: 100 }),
        source({ path: 'a.ts', estimatedTokens: 100 }),
        source({ path: 'b.ts', estimatedTokens: 50, freshness: 'stale' })
      ],
      targets: [],
      resolvedPaths: []
    });
    const totals = contextManifestTotals(manifest);
    assert.equal(totals.files, 2);
    assert.equal(totals.stale, 1);
  });

  it('says so plainly when nothing will be sent (S05)', () => {
    const manifest = buildContextManifest({ sources: [], targets: [], resolvedPaths: [] });
    assert.match(renderContextManifest(manifest), /No workspace context/);
  });

  it('an IME composition Enter does not submit; plain Enter does, Shift+Enter does not (S05)', () => {
    assert.equal(shouldSubmitOnEnter({ key: 'Enter', isComposing: true }), false);
    assert.equal(shouldSubmitOnEnter({ key: 'Enter' }), true);
    assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }), false);
    assert.equal(shouldSubmitOnEnter({ key: 'a' }), false);
  });
});
