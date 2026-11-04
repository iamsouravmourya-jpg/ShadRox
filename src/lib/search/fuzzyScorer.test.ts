/**
 * Ports of VSCode's own fuzzyScorer.test.ts expectations (MIT, Microsoft)
 * adapted to ShadRox's standalone port in ./fuzzyScorer, plus regression
 * tests for the orderings ShadRox's previous ad-hoc matcher got wrong.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareItemsByFuzzyScore,
  matchesCamelCase,
  parseQueryTokens,
  pathAccessor,
  prepareQuery,
  rankByFuzzy,
  rankFilesByFuzzy,
  scoreFuzzy,
  scoreItemFuzzy,
  type FuzzyScoreItem,
  type IItemAccessor,
  type IItemScore,
  type IMatch
} from './fuzzyScorer';

// --- helpers mirroring void-main/src/vs/base/test/common/fuzzyScorer.test.ts ---

function _doScore(target: string, query: string, allowNonContiguousMatches?: boolean): FuzzyScoreItem {
  const preparedQuery = prepareQuery(query);
  return scoreFuzzy(target, preparedQuery.normalized, preparedQuery.normalizedLowercase, allowNonContiguousMatches ?? !preparedQuery.expectContiguousMatch);
}

function scoreItem(item: string, query: string, allowNonContiguousMatches: boolean, accessor: IItemAccessor<string>): IItemScore {
  return scoreItemFuzzy(item, prepareQuery(query), allowNonContiguousMatches, accessor, Object.create(null));
}

function compareItemsByScore(itemA: string, itemB: string, query: string, accessor: IItemAccessor<string>): number {
  return compareItemsByFuzzyScore(itemA, itemB, prepareQuery(query), true, accessor, Object.create(null));
}

// ShadRox's previous ad-hoc matcher (src/components/QuickOpen.tsx before the
// port), kept here only to assert orderings the old code got wrong.
function legacyScore(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct + haystack.lastIndexOf('/') * 0.01;
  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor < 0) return Number.POSITIVE_INFINITY;
    cursor += 1;
  }
  return 500;
}

function legacyRank(paths: string[], query: string): string[] {
  return paths
    .map((path) => ({ path, rank: legacyScore(path, query) }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

test('score (fuzzy): HelLo-World ordering is monotonic (ported from vscode)', () => {
  const target = 'HelLo-World';

  const scores: FuzzyScoreItem[] = [];
  scores.push(_doScore(target, 'HelLo-World', true)); // direct case match
  scores.push(_doScore(target, 'hello-world', true)); // direct mix-case match
  scores.push(_doScore(target, 'HW', true)); // direct case prefix (multiple)
  scores.push(_doScore(target, 'hw', true)); // direct mix-case prefix (multiple)
  scores.push(_doScore(target, 'H', true)); // direct case prefix
  scores.push(_doScore(target, 'h', true)); // direct mix-case prefix
  scores.push(_doScore(target, 'W', true)); // direct case word prefix
  scores.push(_doScore(target, 'Ld', true)); // in-string case match (multiple)
  scores.push(_doScore(target, 'ld', true)); // in-string mix-case match
  scores.push(_doScore(target, 'w', true)); // direct mix-case word prefix
  scores.push(_doScore(target, 'L', true)); // in-string case match
  scores.push(_doScore(target, 'l', true)); // in-string mix-case match
  scores.push(_doScore(target, '4', true)); // no match

  const sortedScores = scores.concat().sort((a, b) => b[0] - a[0]);
  assert.deepStrictEqual(scores, sortedScores);
});

test('score (contiguous): quoted queries disable non-contiguous matching', () => {
  const target = 'HelLo-World';

  assert.ok(_doScore(target, 'HelLo-World', false)[0] > 0);
  assert.strictEqual(_doScore(target, 'HelLo-World', false)[1].length, 'HelLo-World'.length);

  assert.ok(_doScore(target, 'hello-world', false)[0] > 0);
  assert.strictEqual(_doScore(target, 'HW', false)[0], 0);
  assert.ok(_doScore(target, 'h', false)[0] > 0);
  assert.ok(_doScore(target, 'ello', false)[0] > 0);
  assert.ok(_doScore(target, 'ld', false)[0] > 0);
  assert.strictEqual(_doScore(target, 'eo', false)[0], 0);
});

test('word-start and consecutive bonuses are reflected in match positions', () => {
  // 'HW' must land on the two word starts (index 0 and 6), not scattered chars.
  assert.deepStrictEqual(_doScore('HelLo-World', 'HW', true)[1], [0, 6]);
  // A longer consecutive run must beat a scattered subsequence.
  assert.ok(_doScore('foobar', 'foob', true)[0] > _doScore('foobar', 'fbr', true)[0]);
});

test('camelCase filter: fb splits fooBar (ported from vscode filters tests)', () => {
  assert.deepStrictEqual(matchesCamelCase('fb', 'fooBar'), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  assert.deepStrictEqual(matchesCamelCase('fB', 'fooBar'), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  assert.strictEqual(matchesCamelCase('obr', 'fooBar'), null);
});

test('scoreItem - matches are proper (ported from vscode, file path accessor)', () => {
  const resource = 'xyz/some/path/someFile123.txt';

  // Path Identity
  const identityRes = scoreItem(resource, resource, true, pathAccessor);
  assert.ok(identityRes.score);
  assert.strictEqual(identityRes.descriptionMatch!.length, 1);
  assert.strictEqual(identityRes.labelMatch!.length, 1);
  assert.strictEqual(identityRes.descriptionMatch![0].start, 0);
  assert.strictEqual(identityRes.descriptionMatch![0].end, pathAccessor.getItemDescription(resource)!.length);
  assert.strictEqual(identityRes.labelMatch![0].start, 0);
  assert.strictEqual(identityRes.labelMatch![0].end, pathAccessor.getItemLabel(resource)!.length);

  // Basename Prefix
  const basenamePrefixRes = scoreItem(resource, 'som', true, pathAccessor);
  assert.ok(basenamePrefixRes.score);
  assert.ok(!basenamePrefixRes.descriptionMatch || basenamePrefixRes.descriptionMatch.length === 0);
  assert.strictEqual(basenamePrefixRes.labelMatch!.length, 1);
  assert.strictEqual(basenamePrefixRes.labelMatch![0].start, 0);
  assert.strictEqual(basenamePrefixRes.labelMatch![0].end, 'som'.length);

  // Basename Camelcase
  const basenameCamelcaseRes = scoreItem(resource, 'sF', true, pathAccessor);
  assert.ok(basenameCamelcaseRes.score);
  assert.strictEqual(basenameCamelcaseRes.labelMatch!.length, 2);
  assert.strictEqual(basenameCamelcaseRes.labelMatch![0].start, 0);
  assert.strictEqual(basenameCamelcaseRes.labelMatch![0].end, 1);
  assert.strictEqual(basenameCamelcaseRes.labelMatch![1].start, 4);
  assert.strictEqual(basenameCamelcaseRes.labelMatch![1].end, 5);

  // Basename Match
  const basenameRes = scoreItem(resource, 'of', true, pathAccessor);
  assert.ok(basenameRes.score);
  assert.strictEqual(basenameRes.labelMatch!.length, 2);
  assert.strictEqual(basenameRes.labelMatch![0].start, 1);
  assert.strictEqual(basenameRes.labelMatch![0].end, 2);
  assert.strictEqual(basenameRes.labelMatch![1].start, 4);
  assert.strictEqual(basenameRes.labelMatch![1].end, 5);

  // Path Match (spans description + label)
  const pathRes = scoreItem(resource, 'xyz123', true, pathAccessor);
  assert.ok(pathRes.score);
  assert.ok(pathRes.descriptionMatch && pathRes.descriptionMatch.length === 1);
  assert.ok(pathRes.labelMatch && pathRes.labelMatch.length === 1);
  assert.strictEqual(pathRes.descriptionMatch![0].start, 0);
  assert.strictEqual(pathRes.descriptionMatch![0].end, 3);
  assert.strictEqual(pathRes.labelMatch![0].start, 8);
  assert.strictEqual(pathRes.labelMatch![0].end, 11);

  // No Match
  const noRes = scoreItem(resource, '987', true, pathAccessor);
  assert.ok(!noRes.score);

  // No Exact Match (quotes turn off fuzziness)
  const noExactRes = scoreItem(resource, '"sF"', true, pathAccessor);
  assert.ok(!noExactRes.score);

  // Verify Scores ordering tiers
  assert.ok(identityRes.score > basenamePrefixRes.score);
  assert.ok(basenamePrefixRes.score > basenameRes.score);
  assert.ok(basenameRes.score > pathRes.score);
  assert.ok(pathRes.score > noRes.score);
});

test('scoreItem - multiple pieces require every piece to match', () => {
  const resource = 'xyz/some/path/someFile123.txt';

  const res1 = scoreItem(resource, 'xyz some', true, pathAccessor);
  assert.ok(res1.score);
  const res2 = scoreItem(resource, 'some xyz', true, pathAccessor);
  assert.ok(res2.score);
  assert.strictEqual(res1.score, res2.score);
  const res3 = scoreItem(resource, 'some xyz file file123', true, pathAccessor);
  assert.ok(res3.score > res2.score);
  // 'xyz zzz' — the second piece matches nothing, so the whole query must drop
  assert.ok(!scoreItem(resource, 'xyz zzz', true, pathAccessor).score);
});

test('fuzzyScorer query matches vs/base/common/fuzzyScorer.ts first (path tie-break)', () => {
  const paths = [
    'src/scorer-notes/draft.md',
    'src/lib/legacy/fs-cor.ts',
    'vs/base/common/fuzzyScorer.ts',
    'vs/base/test/common/fuzzyScorer.test.ts'
  ];

  const ranked = rankFilesByFuzzy('fuzzyScorer', paths).map((entry) => entry.item);
  assert.strictEqual(ranked[0], 'vs/base/common/fuzzyScorer.ts');
  assert.strictEqual(ranked[1], 'vs/base/test/common/fuzzyScorer.test.ts');
  assert.ok(!ranked.includes('src/lib/legacy/fs-cor.ts') || ranked.indexOf('src/lib/legacy/fs-cor.ts') > 1);

  // Highlight positions are exposed for the label: 'fuzzyScorer' at 0..11.
  const top = rankFilesByFuzzy('fuzzyScorer', paths)[0];
  const expectedMatches: IMatch[] = [{ start: 0, end: 'fuzzyScorer'.length }];
  assert.deepStrictEqual(top.labelMatch, expectedMatches);
});

test('a filename match beats a coincidental early path match (ordering the old matcher got wrong)', () => {
  const paths = [
    'src/scorer-notes/todo.md', // old matcher: direct substring at index 4 -> wins
    'src/lib/search/fuzzyScorer.ts' // old matcher: direct substring at index ~18 -> loses
  ];

  // Legacy ad-hoc scorer prefers the path where the substring appears earliest.
  assert.deepStrictEqual(legacyRank(paths, 'scorer'), ['src/scorer-notes/todo.md', 'src/lib/search/fuzzyScorer.ts']);

  // The ported item scorer prefers the match on the file *name* (label tier).
  const ranked = rankFilesByFuzzy('scorer', paths).map((entry) => entry.item);
  assert.deepStrictEqual(ranked, ['src/lib/search/fuzzyScorer.ts', 'src/scorer-notes/todo.md']);
});

test('acronym-style queries prefer word starts, not the first scattered hit', () => {
  const paths = [
    'src/alfobar.ts', // 'f' then scattered 'b' — the old matcher tied it at 500 and sorted it first (alphabetical)
    'src/FileBrowser.tsx' // camelCase word starts F and B
  ];

  // Old ad-hoc scorer: both are pure subsequences (rank 500), broken by path
  // locale order, so the scattered hit wins.
  assert.deepStrictEqual(legacyRank(paths, 'fb'), ['src/alfobar.ts', 'src/FileBrowser.tsx']);

  // Ported scorer: word-start + same-case bonuses put FileBrowser first.
  const ranked = rankFilesByFuzzy('fb', paths).map((entry) => entry.item);
  assert.deepStrictEqual(ranked, ['src/FileBrowser.tsx', 'src/alfobar.ts']);
});

test('+/~ filter tokens include and exclude candidates', () => {
  const tokens = parseQueryTokens('scorer +src/lib ~test');
  assert.deepStrictEqual(tokens, { include: ['src/lib'], exclude: ['test'], query: 'scorer' });

  const paths = [
    'src/lib/search/fuzzyScorer.ts',
    'src/lib/search/fuzzyScorer.test.ts', // excluded by ~test
    'src/scorer-notes/todo.md' // excluded by +src/lib
  ];
  const ranked = rankByFuzzy('scorer +src/lib ~test', paths, pathAccessor).map((entry) => entry.item);
  assert.deepStrictEqual(ranked, ['src/lib/search/fuzzyScorer.ts']);

  // Filter tokens alone still filter (no fuzzy part required).
  const onlyFilters = rankByFuzzy('+search', paths, pathAccessor).map((entry) => entry.item);
  assert.deepStrictEqual(onlyFilters, ['src/lib/search/fuzzyScorer.ts', 'src/lib/search/fuzzyScorer.test.ts']);
});

test('compareItemsByFuzzyScore prefers shorter full-word prefix matches', () => {
  // Mirrors the vscode expectation: given 'window' queries, window.ts beats
  // windowActions.ts because the prefix covers a larger share of the label.
  const paths = ['src/vs/windowActions.ts', 'src/vs/window.ts'];
  const ranked = rankFilesByFuzzy('window', paths).map((entry) => entry.item);
  assert.deepStrictEqual(ranked, ['src/vs/window.ts', 'src/vs/windowActions.ts']);

  assert.ok(compareItemsByScore('src/vs/window.ts', 'src/vs/windowActions.ts', 'window', pathAccessor) < 0);
});
