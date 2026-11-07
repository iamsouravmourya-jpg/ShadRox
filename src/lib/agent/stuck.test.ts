import assert from 'node:assert/strict';
import test from 'node:test';
import { detectStuck, stuckInstruction, type StuckRound } from './stuck';

const round = (calls: string[], changedFiles = 0): StuckRound => ({ calls, changedFiles });

const identical = (count: number, calls = ['read_file src/a.ts']): StuckRound[] =>
  Array.from({ length: count }, () => round(calls));

const distinct = (count: number): StuckRound[] =>
  Array.from({ length: count }, (_, index) => round([`read_file src/${index}.ts`]));

test('no history is not stuck', () => {
  assert.equal(detectStuck([]), null);
});

test('two identical rounds are still normal', () => {
  assert.equal(detectStuck(identical(2)), null);
});

test('the same call set three rounds in a row is a repeat', () => {
  const signal = detectStuck(identical(3));
  assert.equal(signal?.kind, 'repeat');
  assert.match(signal?.detail as string, /rounds 1-3/);
  assert.match(signal?.detail as string, /read_file src\/a\.ts/);
});

test('a repeat compares call sets, not their order', () => {
  const signal = detectStuck([round(['a', 'b']), round(['b', 'a', 'a']), round(['b', 'a'])]);
  assert.equal(signal?.kind, 'repeat');
});

test('an identical run only needs to be three long anywhere in the history', () => {
  const signal = detectStuck([round(['a']), ...identical(3, ['b']), round(['c'])]);
  assert.equal(signal?.kind, 'repeat');
  assert.match(signal?.detail as string, /rounds 2-4/);
});

test('four rounds of nothing new with no changes is no-progress', () => {
  const signal = detectStuck([round(['a']), round([]), round(['a']), round([])]);
  assert.equal(signal?.kind, 'no-progress');
  assert.match(signal?.detail as string, /4 rounds/);
});

test('no-progress needs four rounds', () => {
  assert.equal(detectStuck([round(['a']), round([]), round(['a'])]), null);
});

test('an empty round breaks a repeat so the slower verdict applies', () => {
  assert.equal(detectStuck([round(['a']), round([]), round([]), round([])])?.kind, 'no-progress');
});

test('a changed file is progress', () => {
  assert.equal(detectStuck([round(['a']), round([]), round(['a']), round([]), round(['a'], 2)]), null);
});

test('fresh call keys are progress', () => {
  assert.equal(detectStuck(distinct(4)), null);
});

test('six rounds whose last two stall is exhausted', () => {
  const signal = detectStuck([...distinct(4), round([]), round([])]);
  assert.equal(signal?.kind, 'exhausted');
  assert.match(signal?.detail as string, /rounds 5 and 6 of 6/);
});

test('a real mutation in the tail is progress and clears the exhausted verdict', () => {
  const signal = detectStuck([...distinct(4), round([]), round(['delete_file gone.txt'], 1)]);
  assert.equal(signal, null, 'a round that changed a file is not a stalled tail');
});

test('exhausted needs six rounds', () => {
  assert.equal(detectStuck([...distinct(3), round([]), round([])]), null);
});

test('a stalled tail outranks the repeat verdict', () => {
  assert.equal(detectStuck(identical(6))?.kind, 'exhausted');
  assert.equal(detectStuck(identical(5))?.kind, 'repeat');
});

test('every signal kind has a detail and an instruction that ends the turn', () => {
  const cases = [
    identical(3),
    [round(['a']), round([]), round(['a']), round([])],
    [...distinct(4), round([]), round([])]
  ];
  for (const rounds of cases) {
    const signal = detectStuck(rounds);
    assert.ok(signal);
    assert.ok(signal.detail.length > 0);
    const instruction = stuckInstruction(signal);
    assert.match(instruction, /looping/);
    assert.match(instruction, /Stop calling tools/);
    assert.match(instruction, /final answer now/);
    assert.ok(instruction.includes(signal.detail));
  }
});

test('the repeat instruction names the calls it keeps re-asking for', () => {
  const many = identical(3, ['read_file a.ts', 'read_file b.ts', 'read_file c.ts', 'read_file d.ts']);
  assert.match(detectStuck(many)?.detail as string, /\+1 more/);
});
