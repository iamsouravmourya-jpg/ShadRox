import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySearchReplaceBlocks,
  extractUnifiedPatches,
  findBlockRange,
  formatApplyFailure,
  locateBlock,
  parseSearchReplaceBlocks,
  resolvePatchContent
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

/* ------------------------------------------------------------------ *
 * Ambiguity: a SEARCH block that fits more than one place is refused.
 * ------------------------------------------------------------------ */

test('refuses a duplicate SEARCH block instead of silently editing the first hit', () => {
  const content = 'x(1);\nx(1);\n';
  const result = applySearchReplaceBlocks(content, [{ original: 'x(1);', updated: 'y(1);' }]);
  assert.deepEqual(result.failures, [{ blockIndex: 0, reason: 'ambiguous', matches: 2 }]);
  assert.equal(result.content, content, 'an ambiguous block must not change the file at all');
});

test('counts exact duplicates explicitly, not through the stripped fallback', () => {
  const content = 'call();\ncall();\ncall();\n';
  const match = locateBlock(content, 'call();');
  assert.equal(match.status, 'ambiguous');
  assert.equal(match.matches, 3);
  assert.equal(findBlockRange(content, 'call();'), 'ambiguous');
});

test('still applies when the block is made unique by surrounding context', () => {
  const content = 'a();\nx(1);\nb();\nx(1);\n';
  const result = applySearchReplaceBlocks(content, [{ original: 'b();\nx(1);', updated: 'b();\ny(1);' }]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.content, 'a();\nx(1);\nb();\ny(1);\n');
});

test('a duplicated block that rewrites text to itself is safe to place anywhere', () => {
  const content = 'x(1);\nx(1);\n';
  const result = applySearchReplaceBlocks(content, [{ original: 'x(1);', updated: 'x(1);' }]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.content, content);
});

test('an ambiguous block fails alone while its unique sibling still applies', () => {
  const content = 'const a = 1;\nconst b = 2;\nconst b = 2;\n';
  const result = applySearchReplaceBlocks(content, [
    { original: 'const a = 1;', updated: 'const A = 1;' },
    { original: 'const b = 2;', updated: 'const B = 2;' }
  ]);
  assert.equal(result.content, 'const A = 1;\nconst b = 2;\nconst b = 2;\n');
  assert.deepEqual(
    result.failures.map((failure) => [failure.blockIndex, failure.reason]),
    [[1, 'ambiguous']]
  );
});

test('the ambiguity reason tells the user to add surrounding lines', () => {
  assert.match(
    formatApplyFailure({ blockIndex: 1, reason: 'ambiguous', matches: 3 }),
    /block 2: matches 3 places — add surrounding lines/
  );
  assert.match(formatApplyFailure({ blockIndex: 0, reason: 'not-found' }), /text not found/);
});

test('regression: CRLF files match verbatim and keep their line endings', () => {
  const content = 'const a = 1;\r\nconst b = 2;\r\n';
  const single = applySearchReplaceBlocks(content, [{ original: 'const b = 2;', updated: 'const B = 2;' }]);
  assert.equal(single.failures.length, 0);
  assert.equal(single.content, 'const a = 1;\r\nconst B = 2;\r\n');

  const multi = applySearchReplaceBlocks(content, [{ original: 'const a = 1;\r\nconst b = 2;', updated: 'const c = 3;' }]);
  assert.equal(multi.failures.length, 0);
  assert.equal(multi.content, 'const c = 3;\r\n');

  // A CR is not whitespace here: the verbatim block still wins over the
  // stripped fallback, and duplicates are still caught in CRLF files.
  assert.deepEqual(locateBlock('x(1);\r\nx(1);\r\n', 'x(1);'), {
    status: 'ambiguous',
    matches: 2,
    occurrences: [
      { start: 0, end: 5 },
      { start: 7, end: 12 }
    ]
  });
});

test('a search/replace patch for a file that does not exist reports not-found and writes nothing', () => {
  // App passes the file's current content; a missing file arrives as empty, and
  // the engine must refuse rather than materialise a one-block fragment.
  const resolved = resolvePatchContent(
    { kind: 'searchReplace', blocks: [{ original: 'const a = 1;', updated: 'const A = 1;' }] },
    ''
  );
  assert.equal(resolved.content, '');
  assert.deepEqual(resolved.failures, [{ blockIndex: 0, reason: 'not-found' }]);

  // A search/replace block that names an unknown file is still extracted — that
  // is how a `path=` fence creates a new file — but it can never resolve,
  // because there is nothing to search.
  const reply = [
    '```ts path=src/ghost.ts',
    '<<<<<<< ORIGINAL',
    'const a = 1;',
    '=======',
    'const A = 1;',
    '>>>>>>> UPDATED',
    '```'
  ].join('\n');
  const patches = extractUnifiedPatches(reply, [{ name: 'src/App.tsx', content: 'const a = 1;\n' }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, 'src/ghost.ts');
  const againstNothing = resolvePatchContent(patches[0], '');
  assert.equal(againstNothing.content, '');
  assert.equal(againstNothing.failures[0].reason, 'not-found');
});

test('an empty ORIGINAL never inserts at position zero', () => {
  const result = applySearchReplaceBlocks('const a = 1;\n', [{ original: '', updated: 'INJECTED' }]);
  assert.equal(result.content, 'const a = 1;\n');
  assert.equal(result.failures[0].reason, 'not-found');
});
