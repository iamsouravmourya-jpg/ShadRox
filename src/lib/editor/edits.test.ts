import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceTextEdit } from '../desktop';
import { applyTextEdits, groupEditsByFile, offsetFromPosition, planFileEdits, reanchorEditRange, resolveEdits } from './edits';

const edit = (
  file: string,
  line: number,
  character: number,
  endLine: number,
  endCharacter: number,
  newText: string
): WorkspaceTextEdit => ({ file, line, character, endLine, endCharacter, newText });

test('offsetFromPosition converts 0-based line/character and clamps past the line end', () => {
  const text = 'alpha\nbeta\ngamma';
  assert.equal(offsetFromPosition(text, 0, 0), 0);
  assert.equal(offsetFromPosition(text, 1, 0), 6);
  assert.equal(offsetFromPosition(text, 2, 3), 14);
  // Past the end of a line stops at its newline, never bleeding into the next.
  assert.equal(offsetFromPosition(text, 1, 99), 10);
  // Past the last line stops at the end of the document.
  assert.equal(offsetFromPosition(text, 99, 0), text.length);
});

test('applyTextEdits stays correct when a later edit shifts an earlier offset', () => {
  const before = 'const alpha = 1;\nconst beta = alpha + 1;\nconst gamma = alpha + beta;\n';
  // Line 1 is rewritten first, so line 2's offsets move even though they were
  // computed against the original text.
  const edits = [
    edit('src/a.ts', 0, 6, 0, 11, 'alphaRenamed'),
    edit('src/a.ts', 1, 13, 1, 18, 'alphaRenamed'),
    edit('src/a.ts', 2, 14, 2, 19, 'alphaRenamed')
  ];

  assert.equal(
    applyTextEdits(before, edits),
    'const alphaRenamed = 1;\nconst beta = alphaRenamed + 1;\nconst gamma = alphaRenamed + beta;\n'
  );
});

test('resolveEdits orders edits back-to-front', () => {
  const text = 'aaa\nbbb\n';
  const resolved = resolveEdits(text, [edit('f', 0, 0, 0, 3, 'x'), edit('f', 1, 0, 1, 3, 'y')]);
  assert.deepEqual(
    resolved.map((item) => item.from),
    [4, 0]
  );
});

test('applyTextEdits drops an edit that overlaps one already applied', () => {
  const before = 'const value = 1;\n';
  const edits = [edit('f', 0, 6, 0, 11, 'other'), edit('f', 0, 8, 0, 11, 'overlap')];
  // The wider span at `from = 6` wins; the inner one is discarded, not merged.
  assert.equal(applyTextEdits(before, edits), 'const other = 1;\n');
});

test('groupEditsByFile folds paths that differ only by case or slash direction', () => {
  const groups = groupEditsByFile([
    edit('C:\\Repo\\src\\a.ts', 0, 0, 0, 1, 'x'),
    edit('c:/repo/src/A.TS', 1, 0, 1, 1, 'y'),
    edit('C:/Repo/src/b.ts', 0, 0, 0, 1, 'z')
  ]);

  assert.equal(groups.size, 2);
  assert.equal(groups.get('C:\\Repo\\src\\a.ts')?.length, 2);
  assert.equal(groups.get('C:/Repo/src/b.ts')?.length, 1);
});

test('planFileEdits rewrites each affected file and skips the ones it cannot read', () => {
  const edits = [
    edit('/root/src/a.ts', 0, 6, 0, 11, 'sum'),
    edit('/root/src/b.ts', 0, 6, 0, 11, 'sum'),
    edit('/root/src/gone.ts', 0, 0, 0, 1, 'x')
  ];
  const buffers: Record<string, string> = {
    '/root/src/a.ts': 'const alpha = 1;\n',
    '/root/src/b.ts': 'const alpha = 2;\n'
  };

  const plans = planFileEdits(edits, (file) => buffers[file] ?? null);
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => plan.file).sort(),
    ['/root/src/a.ts', '/root/src/b.ts']
  );
  assert.equal(plans.find((plan) => plan.file.endsWith('a.ts'))?.content, 'const sum = 1;\n');
  assert.equal(plans.find((plan) => plan.file.endsWith('b.ts'))?.content, 'const sum = 2;\n');
});

test('planFileEdits reports nothing for a file whose content already matches', () => {
  const plans = planFileEdits([edit('/root/a.ts', 0, 0, 0, 0, '')], () => 'unchanged');
  assert.deepEqual(plans, []);
});

test('reanchorEditRange keeps a span that still matches the document', () => {
  const text = 'const alpha = 1;\nconst beta = 2;\n';
  assert.deepEqual(reanchorEditRange(text, { from: 0, to: 16 }, 'const alpha = 1;'), {
    ok: true,
    from: 0,
    to: 16,
    moved: false,
    reason: ''
  });
});

test('reanchorEditRange clamps a span whose tail ran off a shortened document', () => {
  // The model was shown two lines; the user deleted one while it answered.
  const text = 'const alpha = 1;';
  const span = reanchorEditRange(text, { from: 0, to: 40 }, 'const alpha = 1;');
  assert.deepEqual(span, { ok: true, from: 0, to: 16, moved: true, reason: '' });
  assert.ok(span.to <= text.length, 'a dispatched span can never exceed the document');
});

test('reanchorEditRange follows the text when edits above shifted its offsets', () => {
  const text = 'x\nconst alpha = 1;\n';
  assert.deepEqual(reanchorEditRange(text, { from: 0, to: 16 }, 'const alpha = 1;'), {
    ok: true,
    from: 2,
    to: 18,
    moved: true,
    reason: ''
  });
});

test('reanchorEditRange refuses when the code it wrote against is gone or doubled', () => {
  const deleted = reanchorEditRange('const beta = 2;\n', { from: 0, to: 16 }, 'const alpha = 1;');
  assert.equal(deleted.ok, false);
  assert.match(deleted.reason, /no longer in the file/);

  const doubled = reanchorEditRange('foo\nbar\nfoo\n', { from: 4, to: 7 }, 'foo');
  assert.equal(doubled.ok, false);
  assert.match(doubled.reason, /more than once/);
});

test('reanchorEditRange turns a stale caret insertion into an in-bounds caret', () => {
  assert.deepEqual(reanchorEditRange('short', { from: 90, to: 90 }, ''), {
    ok: true,
    from: 5,
    to: 5,
    moved: true,
    reason: ''
  });
});

