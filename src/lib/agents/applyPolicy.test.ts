import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideApply,
  isDestructiveRewrite,
  partitionPatches,
  resolvePolicy,
  reviewSummaryLine,
  type PolicyFileState,
  type PolicyPatch
} from './applyPolicy';

const rewrite = (path: string, content: string): PolicyPatch => ({ path, kind: 'rewrite', content });
const searchReplace = (path: string, original: string, updated: string): PolicyPatch => ({
  path,
  kind: 'searchReplace',
  blocks: [{ original, updated }]
});

const READ_FILE: PolicyFileState = { exists: true, read: true, content: 'const a = 1;\nconst b = 2;\n' };
const UNREAD_FILE: PolicyFileState = { exists: true, read: false, content: 'const a = 1;\nconst b = 2;\n' };
const NEW_FILE: PolicyFileState = { exists: false, read: false };

test('a new file is auto-applied: nothing of the user is overwritten', () => {
  const decision = decideApply('auto', rewrite('src/new.ts', 'export const x = 1;'), NEW_FILE);
  assert.equal(decision.action, 'auto-apply');
  assert.match(decision.reason, /new file/);
});

test('an edit to a file the turn read is auto-applied', () => {
  const decision = decideApply('auto', searchReplace('src/a.ts', 'const a = 1;', 'const a = 2;'), READ_FILE);
  assert.equal(decision.action, 'auto-apply');
});

test('an overwrite of a file the turn never read requires review', () => {
  const decision = decideApply('auto', searchReplace('src/a.ts', 'const a = 1;', 'const a = 2;'), UNREAD_FILE);
  assert.equal(decision.action, 'require-review');
  assert.match(decision.reason, /never read/);
});

test('a whole-file rewrite of an unread file requires review too', () => {
  const decision = decideApply('auto', rewrite('src/a.ts', 'short'), UNREAD_FILE);
  assert.equal(decision.action, 'require-review');
});

test('a rewrite that empties a file is destructive even when it was read', () => {
  const decision = decideApply('auto', rewrite('src/a.ts', ''), { ...READ_FILE, content: 'one\ntwo\nthree\n' });
  assert.equal(decision.action, 'require-review');
  assert.match(decision.reason, /keeps almost none/);
});

test('a search/replace whose replacement is empty is a deletion and needs review', () => {
  const decision = decideApply('auto', searchReplace('src/a.ts', 'const b = 2;\n', ''), READ_FILE);
  assert.equal(decision.action, 'require-review');
  assert.match(decision.reason, /deletes the matched block/);
});

test('the review policy holds everything back, new files included', () => {
  const partition = partitionPatches('review', [rewrite('src/new.ts', 'x'), searchReplace('src/a.ts', 'a', 'b')], (patch) =>
    patch.path === 'src/new.ts' ? NEW_FILE : READ_FILE
  );
  assert.equal(partition.auto.length, 0);
  assert.equal(partition.review.length, 2);
  assert.equal(partition.reviewNotes.length, 2);
});

test('partition keeps input order inside each half so a set is reproducible', () => {
  const patches = [
    rewrite('src/1.ts', 'new'),
    searchReplace('src/a.ts', 'a', 'b'),
    rewrite('src/2.ts', 'new'),
    searchReplace('src/z.ts', 'z', 'y')
  ];
  const partition = partitionPatches('auto', patches, (patch) =>
    patch.kind === 'rewrite' ? NEW_FILE : patch.path.includes('src/z') ? UNREAD_FILE : READ_FILE
  );
  assert.deepEqual(
    partition.auto.map((patch) => patch.path),
    ['src/1.ts', 'src/a.ts', 'src/2.ts']
  );
  assert.deepEqual(
    partition.review.map((decision) => decision.patch.path),
    ['src/z.ts']
  );
});

test('a 400-line file replaced by 3 lines is destructive; a normal rewrite is not', () => {
  const big = Array.from({ length: 40 }, (_, index) => `export const v${index} = ${index};`).join('\n');
  assert.equal(isDestructiveRewrite('export const v0 = 0;', big), true);
  const edited = big.replace('export const v7 = 7;', 'export const v7 = 70;');
  assert.equal(isDestructiveRewrite(edited, big), false);
});

test('a small file may be rewritten wholesale without a review flag', () => {
  assert.equal(isDestructiveRewrite('export default 42;', 'one\ntwo\n'), false);
});

test('an unknown current content is treated as an existing file, not as a create', () => {
  const decision = decideApply('auto', searchReplace('src/a.ts', 'a', 'b'), { exists: true, read: true });
  // The rewrite branch only fires on `rewrite`; a search/replace on a read file
  // stays auto even when the caller could not fetch the current text.
  assert.equal(decision.action, 'auto-apply');
});

test('the default policy is auto, and an explicit review is honoured', () => {
  assert.equal(resolvePolicy(undefined), 'auto');
  assert.equal(resolvePolicy('review'), 'review');
  assert.equal(resolvePolicy('auto'), 'auto');
});

test('a path with backslashes or ./ is named consistently in the reason', () => {
  const decision = decideApply('auto', rewrite('.\\src\\a.ts', 'x'), UNREAD_FILE);
  assert.match(decision.reason, /^src\/a\.ts:/);
});

test('the review line names the count and the first files, never silently dropping the rest', () => {
  const line = reviewSummaryLine(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], ['src/a.ts: this turn changed a file it never read']);
  assert.match(line, /4 files await your review/);
  assert.match(line, /src\/a\.ts/);
  assert.doesNotMatch(line, /src\/d\.ts/);
  assert.match(line, /\(\+1 more\)/);
  assert.match(line, /never read/);
  assert.equal(reviewSummaryLine([], []), '');
});
