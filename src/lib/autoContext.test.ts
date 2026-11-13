import assert from 'node:assert/strict';
import test from 'node:test';
import { applySelection, buildPathShortlist, buildSelectionInstruction, parseSelectedPaths } from './autoContext';
import type { WorkspaceFileEntry } from './types';

const tree: WorkspaceFileEntry[] = [
  { path: 'package.json', size: 900 },
  { path: 'src/App.tsx', size: 4000 },
  { path: 'src/components/ChatPanel.tsx', size: 6000 },
  { path: 'src/components/Sender.tsx', size: 2000 },
  { path: 'src/lib/spendLedger.ts', size: 1500 },
  { path: 'README.md', size: 800 },
  { path: 'src/generated/schema.d.ts', size: 900_000 }
];

test('the shortlist is drawn wider than the read budget', () => {
  const narrow = buildPathShortlist(tree, 'sender component', {
    widen: 1,
    maxFiles: 2,
    maxBytesPerFile: 50_000
  });
  const wide = buildPathShortlist(tree, 'sender component', {
    widen: 4,
    maxFiles: 2,
    maxBytesPerFile: 50_000
  });
  assert.ok(wide.length >= narrow.length);
  assert.equal(narrow.length, 2);
});

test('a file larger than the per-file cap is never shortlisted', () => {
  const shortlist = buildPathShortlist(tree, 'schema', { widen: 4, maxFiles: 6, maxBytesPerFile: 50_000 });
  assert.ok(!shortlist.includes('src/generated/schema.d.ts'));
});

test('the instruction forbids inventing a path and forbids prose', () => {
  const instruction = buildSelectionInstruction(['src/App.tsx', 'src/lib/spendLedger.ts'], 'add a credit meter', 3);
  assert.match(instruction, /add a credit meter/);
  assert.match(instruction, /src\/App\.tsx/);
  assert.match(instruction, /at most 3 paths/i);
  assert.match(instruction, /Never invent/);
  assert.match(instruction, /only the paths/i);
});

test('exact paths are kept in the order the model chose', () => {
  const allowed = ['src/App.tsx', 'src/components/Sender.tsx', 'src/lib/spendLedger.ts'];
  const answer = 'src/components/Sender.tsx\nsrc/App.tsx\n';
  assert.deepEqual(parseSelectedPaths(answer, allowed, 5), ['src/components/Sender.tsx', 'src/App.tsx']);
});

test('an invented path is dropped instead of repaired', () => {
  const allowed = ['src/App.tsx'];
  assert.deepEqual(parseSelectedPaths('src/App.tsx\nsrc/components/TopBar.tsx', allowed, 5), ['src/App.tsx']);
});

test('decoration around a path does not hide it', () => {
  const allowed = ['src/App.tsx', 'src/lib/spendLedger.ts'];
  const answer = '- `src/App.tsx`\n2. "src/lib/spendLedger.ts"';
  assert.deepEqual(parseSelectedPaths(answer, allowed, 5), ['src/App.tsx', 'src/lib/spendLedger.ts']);
});

test('a unique basename resolves, an ambiguous one does not', () => {
  const allowed = ['src/components/Sender.tsx', 'src/lib/spendLedger.ts'];
  assert.deepEqual(parseSelectedPaths('Sender.tsx', allowed, 5), ['src/components/Sender.tsx']);
  assert.deepEqual(parseSelectedPaths('Sender.tsx\nspendLedger.ts\nSender.tsx', allowed, 2), [
    'src/components/Sender.tsx',
    'src/lib/spendLedger.ts'
  ]);
  const ambiguous = ['a/Widget.tsx', 'b/Widget.tsx'];
  assert.deepEqual(parseSelectedPaths('Widget.tsx', ambiguous, 5), []);
});

test('repeats are collapsed and the cap is honoured', () => {
  const allowed = ['src/App.tsx', 'src/lib/spendLedger.ts'];
  assert.deepEqual(parseSelectedPaths('src/App.tsx\nsrc/App.tsx\nsrc/lib/spendLedger.ts', allowed, 5), [
    'src/App.tsx',
    'src/lib/spendLedger.ts'
  ]);
  assert.deepEqual(parseSelectedPaths('src/App.tsx\nsrc/lib/spendLedger.ts', allowed, 1), ['src/App.tsx']);
});

test('prose lines and empty answers select nothing', () => {
  const allowed = ['src/App.tsx'];
  assert.deepEqual(parseSelectedPaths('', allowed, 5), []);
  assert.deepEqual(parseSelectedPaths('I would look at the app file first.', allowed, 5), []);
});

test('a selection can never add a file the shortlist did not offer', () => {
  const shortlist = ['src/App.tsx', 'src/lib/spendLedger.ts'];
  assert.deepEqual(applySelection(shortlist, ['src/lib/spendLedger.ts', 'src/other.ts']), ['src/lib/spendLedger.ts']);
  assert.deepEqual(applySelection(shortlist, ['src/other.ts']), []);
});
