import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedContent,
  acceptedReplacementBlocks,
  allHunkIds,
  computeHunks,
  groupedHunkId,
  hunkStats
} from './hunks';

test('a single changed line becomes one hunk', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nB\nc\n';
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].beforeStart, 1);
  assert.equal(hunks[0].beforeEnd, 2);
  assert.deepEqual(hunks[0].afterLines, ['B']);

  assert.equal(acceptedContent(before, hunks, allHunkIds(hunks)), after);
  assert.equal(acceptedContent(before, hunks, new Set()), before);
});

test('an inserted line has an empty original range', () => {
  const hunks = computeHunks('a\nc\n', 'a\nb\nc\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].beforeStart, 1);
  assert.equal(hunks[0].beforeEnd, 1);
  assert.deepEqual(hunks[0].afterLines, ['b']);
});

test('a deleted line keeps its original range and has no replacement', () => {
  const before = 'a\nb\nc\n';
  const hunks = computeHunks(before, 'a\nc\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].beforeStart, 1);
  assert.equal(hunks[0].beforeEnd, 2);
  assert.deepEqual(hunks[0].afterLines, []);
  assert.equal(acceptedContent(before, hunks, allHunkIds(hunks)), 'a\nc\n');
});

test('accepting one hunk leaves a rejected one byte-for-byte intact', () => {
  const before = 'keep1\nbad1\nkeep2\nbad2\n';
  const after = 'keep1\nGOOD1\nkeep2\nGOOD2\n';
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(acceptedContent(before, hunks, new Set([hunks[0].id])), 'keep1\nGOOD1\nkeep2\nbad2\n');
  assert.equal(acceptedContent(before, hunks, new Set([hunks[1].id])), 'keep1\nbad1\nkeep2\nGOOD2\n');
});

test('identical text produces no hunks', () => {
  assert.deepEqual(computeHunks('same\n', 'same\n'), []);
});

test('hunkStats counts added and removed lines', () => {
  const hunks = computeHunks('a\nb\nc\n', 'a\nB\nC\nD\n');
  const stats = hunkStats(hunks);
  assert.equal(stats.removed, 2);
  assert.equal(stats.added, 3);
});

test('a small edit inside a huge file still yields exactly one tight hunk', () => {
  const original = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n');
  const changed = original.replace('line 1500', 'CHANGED');
  const hunks = computeHunks(original, changed);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].beforeStart, 1500);
  assert.equal(hunks[0].beforeEnd, 1501);
  assert.deepEqual(hunks[0].afterLines, ['CHANGED']);
});

test('a rewrite too large for the diff table degrades to one whole-file hunk', () => {
  const before = Array.from({ length: 2200 }, (_, index) => `old ${index}`).join('\n');
  const after = Array.from({ length: 2200 }, (_, index) => `new ${index}`).join('\n');
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].beforeStart, 0);
  assert.equal(hunks[0].beforeEnd, 2200);
  assert.equal(acceptedContent(before, hunks, allHunkIds(hunks)), after);
});

test('accepted search-replace hunks are merged per block and rejected blocks are omitted', () => {
  const blocks = [
    { original: 'keep1\nold1\nkeep2\nold2', updated: 'keep1\nnew1\nkeep2\nnew2' },
    { original: 'old', updated: 'new' }
  ];
  const firstBlockHunks = computeHunks(blocks[0].original, blocks[0].updated);
  const result = acceptedReplacementBlocks(blocks, [groupedHunkId(0, firstBlockHunks[0].id)]);

  assert.deepEqual(result.blocks, [
    { original: blocks[0].original, updated: 'keep1\nnew1\nkeep2\nold2' }
  ]);
  assert.deepEqual(result.unknownIds, []);
});

test('accepted search-replace hunks report stale review ids', () => {
  const result = acceptedReplacementBlocks(
    [{ original: 'old', updated: 'new' }],
    ['4:hunk-1', '0:missing']
  );
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.unknownIds, ['4:hunk-1', '0:missing']);
});
