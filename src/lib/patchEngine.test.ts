import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySearchReplaceBlocks,
  extractUnifiedPatches,
  findBlockRange,
  parseSearchReplaceBlocks
} from './patchEngine';

const SR_SAMPLE = [
  '<<<<<<< ORIGINAL',
  'const old = 1;',
  '=======',
  'const next = 2;',
  '>>>>>>> UPDATED'
].join('\n');

test('parses complete search/replace blocks', () => {
  const blocks = parseSearchReplaceBlocks(SR_SAMPLE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].original, 'const old = 1;');
  assert.equal(blocks[0].updated, 'const next = 2;');
});

test('parses multiple blocks and drops an unfinished trailing one', () => {
  const text = [
    SR_SAMPLE,
    '',
    '<<<<<<< ORIGINAL',
    'const a = 1;',
    '=======',
    'const b = 2;',
    '>>>>>>> UPDATED',
    '',
    '<<<<<<< ORIGINAL',
    'const half = 1;',
    '=======',
    'const never finished;'
  ].join('\n');

  const blocks = parseSearchReplaceBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].updated, 'const b = 2;');
});

test('tolerates a half-written block before a complete one', () => {
  const text = [
    '<<<<<<< ORIGINAL',
    'const a = 1;',
    '<<<<<<< ORIGINAL',
    'const b = 2;',
    '=======',
    'const c = 3;',
    '>>>>>>> UPDATED'
  ].join('\n');
  const blocks = parseSearchReplaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].original, 'const b = 2;');
});

test('finds exact ranges with and without trailing newlines', () => {
  const content = 'line one\nconst old = 1;\nline three\n';
  const range = findBlockRange(content, 'const old = 1;');
  assert.deepEqual(range, { start: 9, end: 23 });
  const trailing = findBlockRange(content, 'const old = 1;\n');
  assert.ok(trailing);
});

test('falls back to a unique whitespace-stripped match', () => {
  const content = 'if (x) {\n    callA();\n}\n';
  const range = findBlockRange(content, 'callA( ) ;');
  assert.ok(typeof range !== 'string');
  assert.equal(content.slice(range.start, range.end), '    callA();');
});

test('applies non-overlapping blocks right-to-left', () => {
  const content = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const result = applySearchReplaceBlocks(content, [
    { original: 'const a = 1;', updated: 'const A = 1;' },
    { original: 'const c = 3;', updated: 'const C = 3;' }
  ]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.content, 'const A = 1;\nconst b = 2;\nconst C = 3;\n');
});

test('reports failed blocks while still applying the valid ones', () => {
  const content = 'const a = 1;\nconst b = 2;\n';
  const result = applySearchReplaceBlocks(content, [
    { original: 'does not exist', updated: 'x' },
    { original: 'const a = 1;', updated: 'const A = 1;' }
  ]);
  assert.equal(result.content, 'const A = 1;\nconst b = 2;\n');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'not-found');
});

test('rejects overlapping blocks and keeps the file untouched', () => {
  const content = 'const a = 1;\nconst b = 2;\n';
  const result = applySearchReplaceBlocks(content, [
    { original: 'const a = 1;\nconst b = 2;', updated: 'x' },
    { original: 'const b = 2;', updated: 'y' }
  ]);
  assert.equal(result.content, content);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every((failure) => failure.reason === 'overlap'));
});

test('extracts multi-file patches from a reply with fenced S/R blocks', () => {
  const reply = [
    'Updating both files now:',
    '',
    '```tsx path=src/App.tsx',
    '<<<<<<< ORIGINAL',
    'const old = 1;',
    '=======',
    'const next = 2;',
    '>>>>>>> UPDATED',
    '```',
    '',
    '```css path=src/index.css',
    'body { color: red; }',
    '```'
  ].join('\n');

  const files = [
    { name: 'src/App.tsx', content: 'const old = 1;\n' },
    { name: 'src/index.css', content: 'body { color: blue; }\n' }
  ];
  const patches = extractUnifiedPatches(reply, files);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].kind, 'searchReplace');
  assert.equal(patches[0].path, 'src/App.tsx');
  assert.equal(patches[1].kind, 'rewrite');
  assert.equal(patches[1].path, 'src/index.css');
});

test('resolves a path from the first line of the block', () => {
  const reply = [
    '```',
    'src/App.tsx',
    '<<<<<<< ORIGINAL',
    'const old = 1;',
    '=======',
    'const next = 2;',
    '>>>>>>> UPDATED',
    '```'
  ].join('\n');
  const patches = extractUnifiedPatches(reply, [{ name: 'src/App.tsx', content: 'const old = 1;\n' }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, 'src/App.tsx');
  assert.equal(patches[0].kind, 'searchReplace');
});

test('ignores blocks that name no known file', () => {
  const reply = [
    '```tsx',
    '<<<<<<< ORIGINAL',
    'const old = 1;',
    '=======',
    'const next = 2;',
    '>>>>>>> UPDATED',
    '```'
  ].join('\n');
  const files = [
    { name: 'src/App.tsx', content: '' },
    { name: 'src/index.css', content: '' }
  ];
  assert.equal(extractUnifiedPatches(reply, files).length, 0);
});
