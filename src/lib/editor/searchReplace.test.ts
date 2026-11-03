import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSearchableFiles, planReplaceAll, searchInFiles, totalMatches, type SearchableFile } from './searchReplace';

const files: SearchableFile[] = [
  { name: 'src/a.ts', content: 'const add = 1;\nconst sum = add + 1;\n' },
  { name: 'src/b.ts', content: 'add()\n' }
];

const resultsOf = (outcome: ReturnType<typeof searchInFiles>) => {
  assert.ok(!('error' in outcome), 'expected a successful search');
  return outcome.results;
};

test('searchInFiles finds every occurrence and reports its line range', () => {
  const results = resultsOf(searchInFiles(files, 'add'));
  assert.equal(totalMatches(results), 3);

  const a = results.find((result) => result.file === 'src/a.ts');
  assert.deepEqual(a?.matches[1], {
    line: 1,
    character: 12,
    endCharacter: 15,
    text: 'const sum = add + 1;',
    match: 'add'
  });
});

test('searches are case-insensitive unless asked otherwise', () => {
  assert.equal(totalMatches(resultsOf(searchInFiles(files, 'ADD'))), 3);
  assert.equal(totalMatches(resultsOf(searchInFiles(files, 'ADD', { caseSensitive: true }))), 0);
});

test('whole-word matching does not fire inside a longer identifier', () => {
  const widened: SearchableFile[] = [{ name: 'a.ts', content: 'address = add;\n' }];
  assert.equal(totalMatches(resultsOf(searchInFiles(widened, 'add'))), 2);
  assert.equal(totalMatches(resultsOf(searchInFiles(widened, 'add', { wholeWord: true }))), 1);
});

test('regular-expression mode is used verbatim', () => {
  assert.equal(totalMatches(resultsOf(searchInFiles(files, 'ad+', { regex: true }))), 3);
});

test('a broken pattern, an empty query, and an always-matching pattern are reported', () => {
  assert.ok('error' in searchInFiles(files, 'a(', { regex: true }));
  assert.ok('error' in searchInFiles(files, ''));
  // `a*` matches the empty string, which would insert text between every char.
  assert.ok('error' in searchInFiles(files, 'a*', { regex: true }));
});

test('planReplaceAll rewrites each matching file and counts the replacements', () => {
  const outcome = planReplaceAll(files, 'add', 'plus');
  assert.ok(!('error' in outcome));
  assert.equal(outcome.truncated, false);
  assert.deepEqual(
    outcome.plans.map((plan) => [plan.file, plan.content, plan.replacements]),
    [
      ['src/a.ts', 'const plus = 1;\nconst sum = plus + 1;\n', 2],
      ['src/b.ts', 'plus()\n', 1]
    ]
  );
  assert.equal(outcome.plans[0].original, files[0].content);
});

test('mergeSearchableFiles prefers open buffers over disk contents by normalized path', () => {
  const merged = mergeSearchableFiles(
    [{ name: 'src\\a.ts', content: 'unsaved' }],
    [
      { name: 'src/a.ts', content: 'disk' },
      { name: 'src/b.ts', content: 'other' }
    ]
  );
  assert.deepEqual(merged, [
    { name: 'src\\a.ts', content: 'unsaved' },
    { name: 'src/b.ts', content: 'other' }
  ]);
});

test('planReplaceAll keeps $-group references working in the replacement', () => {
  const outcome = planReplaceAll([{ name: 'a.txt', content: 'x1 y2\n' }], '([a-z])(\\d)', '$2$1', { regex: true });
  assert.ok(!('error' in outcome));
  assert.equal(outcome.plans[0].content, '1x 2y\n');
});

test('planReplaceAll returns no plan when nothing matches', () => {
  const outcome = planReplaceAll(files, 'missing', 'replacement');
  assert.ok(!('error' in outcome));
  assert.deepEqual(outcome.plans, []);
});
