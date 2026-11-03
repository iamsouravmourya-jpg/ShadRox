import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCheckpointDiff, diffToCheckpoint } from './checkpointDiff';

const file = (name: string, content: string) => ({ name, content });

test('a checkpoint identical to the live buffers reports a clean restore', () => {
  const current = [file('a.ts', 'one\ntwo'), file('b.ts', 'x')];
  const diff = diffToCheckpoint(current, [...current]);
  assert.equal(diff.clean, true);
  assert.equal(diff.changes.length, 0);
  assert.match(describeCheckpointDiff(diff), /changes nothing/);
});

test('edited files count added and removed lines', () => {
  const diff = diffToCheckpoint([file('a.ts', 'one\ntwo\nthree')], [file('a.ts', 'one\nTWO\nthree')]);
  assert.deepEqual(
    { kind: diff.changes[0].kind, added: diff.changes[0].added, removed: diff.changes[0].removed },
    { kind: 'edit', added: 1, removed: 1 }
  );
  assert.equal(diff.edited, 1);
  assert.equal(diff.linesAdded, 1);
  assert.equal(diff.linesRemoved, 1);
});

test('files that only exist in the checkpoint come back, and new ones are deleted', () => {
  const diff = diffToCheckpoint([file('kept.ts', 'a'), file('new.ts', '1\n2\n3')], [file('kept.ts', 'a'), file('old.ts', 'x\ny')]);
  const byPath = new Map(diff.changes.map((change) => [change.path, change]));
  assert.equal(byPath.get('old.ts').kind, 'restore');
  assert.equal(byPath.get('old.ts').added, 2);
  assert.equal(byPath.get('new.ts').kind, 'delete');
  assert.equal(byPath.get('new.ts').removed, 3);
  assert.equal(byPath.has('kept.ts'), false);
  assert.equal(diff.restored, 1);
  assert.equal(diff.deleted, 1);
});

test('path separators and case do not split one file into two changes', () => {
  const diff = diffToCheckpoint([{ name: 'src\\A.ts', content: 'one' }], [{ name: 'src/a.ts', content: 'two' }]);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].kind, 'edit');
});

test('the list is capped but the totals stay complete', () => {
  const current = Array.from({ length: 200 }, (_, index) => file(`f${index}.ts`, 'a\nb'));
  const checkpoint = Array.from({ length: 200 }, (_, index) => file(`f${index}.ts`, 'a'));
  const diff = diffToCheckpoint(current, checkpoint, { maxChanges: 5 });
  assert.equal(diff.changes.length, 5);
  assert.equal(diff.truncated, true);
  assert.equal(diff.edited, 200);
  assert.equal(diff.linesRemoved, 200);
});

test('changes sort by path so the same states render the same list', () => {
  const diff = diffToCheckpoint([file('z.ts', 'a'), file('m.ts', 'a')], [file('z.ts', 'b'), file('m.ts', 'b')]);
  assert.deepEqual(diff.changes.map((change) => change.path), ['m.ts', 'z.ts']);
});

test('a huge file reports the edit without a line count', () => {
  const huge = 'x'.repeat(400_001);
  const diff = diffToCheckpoint([file('big.txt', huge)], [file('big.txt', `${huge}\nextra`)]);
  assert.equal(diff.changes[0].kind, 'edit');
  assert.equal(diff.changes[0].approximate, true);
});

test('the summary sentence names each kind of change', () => {
  const summary = describeCheckpointDiff(diffToCheckpoint([file('a.ts', 'one\ntwo'), file('new.ts', 'n')], [file('a.ts', 'one'), file('gone.ts', 'g')]));
  assert.match(summary, /3 files change/);
  assert.match(summary, /1 edited/);
  assert.match(summary, /1 came back/);
  assert.match(summary, /1 deleted by restore/);
});
