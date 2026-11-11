import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applySearchReplaceBlocks,
	assessRewriteRisk,
	computeClinePatchChanges,
	extractUnifiedPatchScan,
	extractUnifiedPatches,
	findBlockRange,
	formatApplyFailure,
	locateBlock,
	looksLikeClinePatch,
	parseSearchReplaceBlocks,
	resolvePatchContent
} from './patchEngine';
import { countDiffLines, makeUnifiedDiff } from './patch/clineUiDiff';
import { clineSectionsToPatches, parseClinePatchSections, refusalReason } from './patch/clinePatchApply';

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

const level = (content: string, original: string) => {
  const match = locateBlock(content, original);
  return match.status === 'found' ? match.via : match.status;
};

test('the cascade is ordered: verbatim first, then trimmed lines, then stripped', () => {
  const content = 'if (x) {\n    callA();\n    callB();\n}\n';
  assert.equal(level(content, '    callB();'), 'exact');
  assert.equal(level(content, '      callB();'), 'lines');
  assert.equal(level(content, 'callB( ) ;'), 'stripped');
  assert.equal(level(content, 'callC();'), 'not-found');
});

test('a block whose indentation drifted still lands, replacing whole lines', () => {
  const content = 'function f() {\n  return total / count;\n}\n';
  const result = applySearchReplaceBlocks(content, [
    { original: '    return total / count;', updated: '  return count ? total / count : 0;' }
  ]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.content, 'function f() {\n  return count ? total / count : 0;\n}\n');
});

test('a block anchored to a blank line matches on trimmed lines', () => {
  const content = 'const a = 1;\n\n    const b = 2;\n';
  assert.equal(level(content, 'const a = 1;\n\nconst b = 2;'), 'lines');
});

test('two trimmed-line candidates are refused, not silently picked', () => {
  const content = '  y();\n\t\t\ty();\n';
  assert.equal(level(content, '   y();'), 'not-unique');
});

test('CRLF files keep their line endings through the trimmed-line level', () => {
  const content = 'const a = 1;\r\n    const b = 2;\r\n';
  assert.equal(level(content, '      const b = 2;'), 'lines');
  const result = applySearchReplaceBlocks(content, [{ original: '      const b = 2;', updated: 'const B = 2;' }]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.content, 'const a = 1;\r\nconst B = 2;\r\n');
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

// --- rewrite guard ---------------------------------------------------------

test('a fragment rewrite of an existing file is refused', () => {
  const original = Array.from({ length: 40 }, (_, index) => `<div class="row-${index}"></div>`).join('\n');
  const warning = assessRewriteRisk('form.html', '<div>new</div>\n<script>submit()</script>', original);

  assert.ok(warning, 'expected the guard to refuse a 2-line replacement for a 40-line file');
  assert.match(warning!, /form\.html/);
  assert.match(warning!, /2-line replacement for a 40-line file/);
});

test('a rewrite that keeps most of the file is allowed', () => {
  const original = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const updated = original.replace('const value3 = 3;', 'const value3 = 33;');
  assert.equal(assessRewriteRisk('app.ts', updated, original), null);
});

test('rewrites of new or small files are never blocked', () => {
  assert.equal(assessRewriteRisk('app.ts', 'const a = 1;', undefined), null);
  assert.equal(assessRewriteRisk('app.ts', 'let a = 1;\nlet b = 2;', 'let a;\nlet b;'), null);
});

/* ========================================================================== *
 * Cline apply-patch port (Apache-2.0; src/lib/patch/*).
 *
 * The "ported" cases below are the scenarios from
 * reference/cline-main/sdk/packages/core/src/extensions/tools/executors/
 * apply-patch.test.ts, adapted from Cline's disk-writing vitest executor to
 * ShadRox's diskless compute seam (contents in, changes out, zero writes).
 * ========================================================================== */

const PAGE_TSX = [
  'export default function Page() {',
  '\treturn (',
  '\t\t<div>',
  '\t\t\t<button onClick={() => console.log("clicked")}>Click me</button>',
  '\t\t</div>',
  '\t);',
  '}',
].join('\n');

test('ported from Cline: applies the documented freeform patch format without shell wrappers', () => {
  const { changes, fuzz } = computeClinePatchChanges(
    [
      '*** Update File: page.tsx',
      '@@',
      ' export default function Page() {',
      ' \treturn (',
      ' \t\t<div>',
      ' \t\t\t<button onClick={() => console.log("clicked")}>Click me</button>',
      '+\t\t\t<button onClick={() => console.log("cancel clicked")}>Cancel</button>',
      ' \t\t</div>',
      ' \t);',
      ' }',
    ].join('\n'),
    { 'page.tsx': PAGE_TSX }
  );
  assert.equal(fuzz, 0);
  assert.ok(changes['page.tsx'].newContent!.includes('console.log("cancel clicked")'));
});

test('ported from Cline: accepts the legacy %%bash apply_patch <<EOF wrapper', () => {
  const { changes } = computeClinePatchChanges(
    [
      '%%bash',
      'apply_patch <<"EOF"',
      '*** Begin Patch',
      '*** Add File: note.txt',
      '+hello',
      '*** End Patch',
      'EOF',
    ].join('\n'),
    {}
  );
  assert.equal(changes['note.txt'].type, 'add');
  assert.equal(changes['note.txt'].newContent, 'hello');
});

test('ported from Cline: does not strip valid patch lines that begin with wrapper tokens', () => {
  const { changes } = computeClinePatchChanges(
    [
      '*** Update File: note.txt',
      '@@',
      ' alpha',
      ' EOF literal',
      ' ``` fence',
      '+tail',
      ' omega',
    ].join('\n'),
    { 'note.txt': ['alpha', 'EOF literal', '``` fence', 'omega'].join('\n') }
  );
  assert.equal(changes['note.txt'].newContent, ['alpha', 'EOF literal', '``` fence', 'tail', 'omega'].join('\n'));
});

test('ported from Cline: accepts an end sentinel with trailing whitespace', () => {
  const { changes } = computeClinePatchChanges(
    ['*** Begin Patch', '*** Add File: note.txt', '+hello', '*** End Patch '].join('\n'),
    {}
  );
  assert.equal(changes['note.txt'].newContent, 'hello');
});

test('ported from Cline: preserves CRLF line endings when updating a CRLF file', () => {
  const { changes } = computeClinePatchChanges(
    ['*** Update File: note.txt', '@@', ' alpha', '-beta', '+BETA', '+inserted', ' gamma'].join('\n'),
    { 'note.txt': 'alpha\r\nbeta\r\ngamma' }
  );
  // Models emit LF-only patch text even for CRLF files; the file's own EOL
  // must come back on the output (github.com/cline/cline/issues/13504).
  assert.equal(changes['note.txt'].newContent, 'alpha\r\nBETA\r\ninserted\r\ngamma');
});

test('ported from Cline: updates a pure-LF file without introducing CRLF', () => {
  const { changes } = computeClinePatchChanges(
    ['*** Update File: lf.txt', '@@', ' one', '-two', '+TWO', ' three'].join('\n'),
    { 'lf.txt': 'one\ntwo\nthree' }
  );
  assert.equal(changes['lf.txt'].newContent, 'one\nTWO\nthree');
});

test('ported from Cline: refuses to add a file that already exists', () => {
  assert.throws(
    () =>
      computeClinePatchChanges(
        ['*** Begin Patch', '*** Add File: note.txt', '+overwritten', '*** End Patch'].join('\n'),
        { 'note.txt': 'important data' }
      ),
    /Add File Error: File already exists: note\.txt/
  );
});

test('ported from Cline: rejects incomplete patch sentinels', () => {
  assert.throws(
    () => computeClinePatchChanges('*** Begin Patch\n*** Add File: note.txt\n+hello', {}),
    /Invalid patch text - incomplete sentinels/
  );
});

test('ported from Cline: rejects a patch when a hunk context does not match — and yields no changes at all', () => {
  assert.throws(
    () =>
      computeClinePatchChanges(
        ['*** Update File: note.txt', '@@', ' unrelated heading', ' missing middle', '+replacement', ' absent footer'].join('\n'),
        { 'note.txt': 'alpha\nbeta\ngamma' }
      ),
    /note\.txt: hunk 1: Could not find matching context/
  );
});

test('ported from Cline: a Move to section computes the renamed content, and the auto-apply pipeline refuses the rename', () => {
  const { changes } = computeClinePatchChanges(
    ['*** Update File: old.txt', '*** Move to: new.txt', '@@', ' one', '-two', '+TWO'].join('\n'),
    { 'old.txt': 'one\r\ntwo' }
  );
  assert.equal(changes['old.txt'].movePath, 'new.txt');
  assert.equal(changes['old.txt'].newContent, 'one\r\nTWO');

  // ShadRox deliberately drops Cline's rename-on-write: the pipeline has no
  // delete kind, so a move surfaces as a guaranteed refusal instead of a
  // silent half-rename.
  const patches = extractUnifiedPatches(
    '```\n*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n one\n-two\n+TWO\n*** End Patch\n```',
    [{ name: 'old.txt', content: 'one\r\ntwo' }]
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].kind, 'searchReplace');
  const resolved = resolvePatchContent(patches[0], 'one\r\ntwo');
  assert.equal(resolved.content, 'one\r\ntwo', 'zero bytes: the move must never partially land');
  assert.equal(resolved.failures[0].reason, 'not-found');
});

test('ported from Cline: the @@ defStr anchor and similarity levels count as fuzz in the compute seam', () => {
  // The defStr anchors a function signature the file writes with extra
  // indentation — matched only after trimming, so Cline's fuzz counter rises.
  const defStr = computeClinePatchChanges(
    ['*** Update File: f.ts', '@@ function f() {', '-    return 1;', '+    return 2;'].join('\n'),
    { 'f.ts': 'class C {\n  function f() {\n    return 1;\n  }\n}\n' }
  );
  assert.equal(defStr.changes['f.ts'].newContent, 'class C {\n  function f() {\n    return 2;\n  }\n}\n');
  assert.ok(defStr.fuzz >= 1, 'expected the trimmed defStr anchor to raise fuzz');

  // A one-character drift that survives every strict pass lands via the
  // similarity pass (>= 0.66) — and only because the window is unique.
  const similar = computeClinePatchChanges(
    ['*** Update File: g.ts', '@@', '-const total = sum(values);', '+const total = sum(values.slice(1));'].join('\n'),
    { 'g.ts': 'const totals = sum(values);\nexport default totals;\n' }
  );
  assert.ok(similar.fuzz >= 1000, 'expected similarity-level placement to raise fuzz by 1000');
});

test('ported with safety change: a similarity pass with two >= 0.66 windows is refused, not picked first', () => {
  // The deleted line is fuzzy-similar to ALL THREE windows (0.89 / 0.75 /
  // 0.79); Cline's original pass took the first. The port collects every
  // candidate and refuses — the throw means computeClinePatchChanges never
  // returns a change set, so no bytes.
  assert.throws(
    () =>
      computeClinePatchChanges(
        ['*** Update File: d.ts', '@@', '-const alpha = compute(a);', '+const alpha = compute(a, b);'].join('\n'),
        { 'd.ts': 'const alpha = compute(a, x);\nconst betaX = compute(a, x);\nconst gamma = compute(a, x);\n' }
      ),
    /Could not find matching context/
  );
});

/* -------------------------------------------------------------------------- *
 * Extraction: Cline grammar → ShadRox SEARCH/REPLACE blocks (adapted, not
 * Cline: positioning is always re-verified by locateBlock at plan time).
 * -------------------------------------------------------------------------- */

const clineFence = (body: string): string => '```diff\n' + body + '\n```';

test('extraction turns a Cline update hunk into verified search/replace blocks', () => {
  const reply = clineFence([
    '*** Begin Patch',
    '*** Update File: page.tsx',
    '@@',
    ' export default function Page() {',
    ' \treturn (',
    ' \t\t<div>',
    ' \t\t\t<button onClick={() => console.log("clicked")}>Click me</button>',
    '+\t\t\t<button onClick={() => console.log("cancel clicked")}>Cancel</button>',
    ' \t\t</div>',
    ' \t);',
    ' }',
    '*** End Patch',
  ].join('\n'));
  const patches = extractUnifiedPatches(reply, [{ name: 'page.tsx', content: PAGE_TSX + '\n' }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].kind, 'searchReplace');
  const blocks = (patches[0].blocks ?? []);
  assert.equal(blocks.length, 1);
  const resolved = resolvePatchContent(patches[0], PAGE_TSX + '\n');
  assert.deepEqual(resolved.failures, []);
  assert.ok(resolved.content.includes('Cancel</button>'));
  assert.ok(resolved.content.endsWith('\n'), 'the file keeps its trailing newline');
});

test('extraction routes Add File into the pipeline create path and rejects an Add over an existing file', () => {
  const fresh = extractUnifiedPatches(
    clineFence(['*** Begin Patch', '*** Add File: src/new/Widget.ts', '+export const widget = 7;', '*** End Patch'].join('\n')),
    []
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].kind, 'rewrite');
  assert.equal(fresh[0].path, 'src/new/Widget.ts');

  const clash = extractUnifiedPatches(
    clineFence(['*** Begin Patch', '*** Add File: src/App.tsx', '+trampling rewrite', '*** End Patch'].join('\n')),
    [{ name: 'src/App.tsx', content: 'export const a = 1;\n' }]
  );
  assert.equal(clash.length, 1);
  const resolved = resolvePatchContent(clash[0], 'export const a = 1;\n');
  assert.equal(resolved.content, 'export const a = 1;\n', 'the existing file is not touched');
  assert.equal(resolved.failures[0].reason, 'not-found');
});

test('extraction refuses a Delete hunk — the pipeline has no delete kind', () => {
  const patches = extractUnifiedPatches(
    clineFence(['*** Begin Patch', '*** Delete File: src/gone.ts', '*** End Patch'].join('\n')),
    [{ name: 'src/gone.ts', content: 'export const gone = 1;\n' }]
  );
  assert.equal(patches.length, 1);
  const resolved = resolvePatchContent(patches[0], 'export const gone = 1;\n');
  assert.equal(resolved.content, 'export const gone = 1;\n');
  assert.equal(resolved.failures[0].reason, 'not-found');
});

test('a malformed Cline patch blocks the plan instead of being dropped', () => {
  const patches = extractUnifiedPatches(
    clineFence(['*** Begin Patch', '*** Update File: src/a.ts', '@@', ' line one', '-missing line', '*** End Patch'].join('\n')),
    [{ name: 'src/a.ts', content: 'line one\n' }]
  );
  assert.equal(patches.length, 1);
  const resolved = resolvePatchContent(patches[0], 'line one\n');
  assert.equal(resolved.content, 'line one\n', 'zero bytes: a broken anchor never silently vanishes');
  assert.equal(resolved.failures[0].reason, 'not-found');
});

test('safety: an extracted Cline block that fits several places is refused, not applied to the first', () => {
  const content = 'x(1);\nx(1);\nx(1);\n';
  const patches = extractUnifiedPatches(
    clineFence(['*** Update File: dup.ts', '@@', '-x(1);', '+y(1);'].join('\n')),
    [{ name: 'dup.ts', content }]
  );
  assert.equal(patches.length, 1);
  const resolved = resolvePatchContent(patches[0], content);
  assert.equal(resolved.content, content, 'an ambiguous anchor must not change the file at all');
  assert.equal(resolved.failures[0].reason, 'ambiguous');
  assert.equal(resolved.failures[0].matches, 3);
});

test('safety: an external edit that breaks the hunk anchor mid-stream is refused', () => {
  const generated = PAGE_TSX + '\n';
  const patches = extractUnifiedPatches(
    clineFence([
      '*** Update File: page.tsx',
      '@@',
      '-\t\t\t<button onClick={() => console.log("clicked")}>Click me</button>',
      '+\t\t\t<button onClick={() => console.log("clicked")}>Cancel</button>',
    ].join('\n')),
    [{ name: 'page.tsx', content: generated }]
  );
  assert.equal(patches.length, 1);
  // Somebody edited the button line outside ShadRox before the apply click.
  // The one-line anchor never reaches the fuzzy level (short-block gate),
  // so the drifted file is refused verbatim.
  const drifted = generated.replace('console.log("clicked")', 'console.log("CONFIRMED")');
  const resolved = resolvePatchContent(patches[0], drifted);
  assert.equal(resolved.content, drifted, 'the external edit must survive untouched');
  assert.ok(resolved.failures.length > 0);
});

test('looksLikeClinePatch recognizes the grammar and nothing else', () => {
  assert.equal(looksLikeClinePatch('*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch'), true);
  assert.equal(looksLikeClinePatch('*** Update File: a.txt\n@@\n-a\n+b'), true);
  assert.equal(looksLikeClinePatch('<<<<<<< ORIGINAL\na\n=======\nb\n>>>>>>> UPDATED'), false);
  assert.equal(looksLikeClinePatch('export const a = 1;\n// mentions *** Update File: deep in a comment'), false);
});

test('parseClinePatchSections / clineSectionsToPatches are importable standalone seams', () => {
  const sections = parseClinePatchSections(
    ['*** Update File: src/a.ts', '@@', ' keep', '-old', '+new', ' tail', '*** Add File: src/b.ts', '+made'].join('\n')
  );
  assert.equal(sections.updates.length, 1);
  assert.equal(sections.adds.length, 1);
  const entries = clineSectionsToPatches(sections, {});
  const update = entries.find((entry) => entry.path === 'src/a.ts');
  const add = entries.find((entry) => entry.path === 'src/b.ts');
  assert.equal(update?.kind, 'searchReplace');
  assert.equal(add?.kind, 'rewrite');
});

/* -------------------------------------------------------------------------- *
 * Fuzzy locate level (Cline similarity math inside ShadRox's cascade).
 * -------------------------------------------------------------------------- */

const FUZZY_FILE = [
  'function summarize(rows) {',
  '  const total = rows.reduce((sum, row) => sum + row.value, 0);',
  '  return { count: rows.length, total };',
  '}',
  '',
].join('\n');

const FUZZY_WANTED = [
  'function summarize(rows) {',
  '  const total = rows.reduce((sum, row) => sum + row.value, 0);',
  '  return { count: rows.length, total: Math.round(total) };',
  '}',
].join('\n');

test('a multi-line drifted block lands through the fuzzy level', () => {
  const match = locateBlock(FUZZY_FILE, FUZZY_WANTED);
  assert.equal(match.status, 'found');
  assert.equal(match.via, 'fuzzy');
  const result = applySearchReplaceBlocks(FUZZY_FILE, [{ original: FUZZY_WANTED, updated: 'function summarize(rows) { /* replaced */ }' }]);
  assert.equal(result.failures.length, 0);
  assert.ok(result.content.includes('/* replaced */'));
});

test('two similar windows for a fuzzy block are refused as not-unique', () => {
  const doubled = FUZZY_FILE + FUZZY_FILE;
  const match = locateBlock(doubled, FUZZY_WANTED);
  assert.equal(match.status, 'not-unique');
});

test('short blocks never reach the fuzzy level — a 0.66 ratio on one line is a coin flip', () => {
  // 'callC();' is 87.5% similar to 'callA();'; the gate keeps that out.
  const content = 'if (x) {\n    callA();\n    callB();\n}\n';
  const match = locateBlock(content, 'callC();');
  assert.equal(match.status, 'not-found');
  // Two lines is still under the three-line gate.
  const twoLine = locateBlock(FUZZY_FILE, 'function summarize(rowsX {\n  const totals = rows.reduce((sum, row) => sum + row.valueX, 9);\n');
  assert.equal(twoLine.status, 'not-found');
});

/* -------------------------------------------------------------------------- *
 * Cline UI diff renderer (pure text; ported for the review rail).
 * -------------------------------------------------------------------------- */

test('ported from Cline: makeUnifiedDiff renders whole-file and fragment diffs with honest headers', () => {
  const whole = makeUnifiedDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma', 'note.txt');
  assert.ok(whole.includes('--- a/note.txt'));
  assert.ok(whole.includes('+++ b/note.txt'));
  assert.ok(whole.includes('@@ -1,3 +1,3 @@'));
  assert.ok(whole.includes('-beta'));
  assert.ok(whole.includes('+BETA'));

  const fragment = makeUnifiedDiff('beta', 'BETA', 'note.txt', 3, { fragment: true });
  assert.ok(fragment.includes('@@ … @@'), 'fragments must not fabricate line-1 positions');

  assert.deepEqual(countDiffLines(whole), { additions: 1, deletions: 1 });
});

/* -------------------------------------------------------------------------- *
 * Regressions from the packaged app: duplicate paths, silent empty bodies,
 * and refused deletions that surfaced as a generic "text not found".
 * -------------------------------------------------------------------------- */

test('the same file emitted twice yields ONE patch and the LAST block wins', () => {
  const reply = [
    '```ts path=test.txt',
    'export const value = 1;',
    '```',
    '',
    'Adding the file again after a tool round:',
    '',
    '```ts path=test.txt',
    'export const value = 2;',
    '```'
  ].join('\n');

  const patches = extractUnifiedPatches(reply, []);
  assert.equal(patches.length, 1, 'one row per file, not one per re-emitted block');
  assert.equal(patches[0].kind, 'rewrite');
  assert.equal((patches[0] as { content: string }).content, 'export const value = 2;');
});

test('path spelling variants (case, ./, backslashes) still count as one file', () => {
  const sr = (updated: string) =>
    ['<<<<<<< ORIGINAL', 'const old = 1;', '=======', updated, '>>>>>>> UPDATED'].join('\n');
  const reply = [
    '```ts path=src/App.tsx',
    sr('const next = 2;'),
    '```',
    '',
    '```ts path=./src\\App.tsx',
    sr('const next = 3;'),
    '```'
  ].join('\n');

  const patches = extractUnifiedPatches(reply, [{ name: 'src/App.tsx', content: 'const old = 1;\n' }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, 'src/App.tsx', 'the first spelling is kept');
  const resolved = resolvePatchContent(patches[0], 'const old = 1;\n');
  assert.equal(resolved.content, 'const next = 3;\n', 'the later block is the final state');
});

test('a declared file with an empty body is reported, never silently dropped', () => {
  const scan = extractUnifiedPatchScan('```ts path=test.txt\n```', []);
  assert.equal(scan.patches.length, 1, 'the declared path still reaches review');
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].path, 'test.txt');
  assert.equal(scan.rejected[0].code, 'EMPTY_BODY');
  assert.match(scan.rejected[0].reason, /deletion/i);

  // Nothing is written: the refusal block never matches, and the reason is
  // carried out of resolvePatchContent instead of a generic anchor failure.
  const onDisk = 'still here\n';
  const resolved = resolvePatchContent(scan.patches[0], onDisk);
  assert.equal(resolved.content, onDisk);
  assert.equal(resolved.refusal?.code, 'EMPTY_BODY');
  assert.match(resolved.refusal?.reason ?? '', /left untouched/);
  assert.match(resolved.refusal?.reason ?? '', /file tree|ask the agent/);
});

test('an empty body with no resolvable path stays unmapped (no invented target)', () => {
  const scan = extractUnifiedPatchScan('```ts\n```', []);
  assert.deepEqual(scan.patches, []);
  assert.deepEqual(scan.rejected, []);
});

test('a Cline Delete File refusal is typed and says what to do instead', () => {
  const scan = extractUnifiedPatchScan(
    '```diff\n*** Begin Patch\n*** Delete File: src/gone.ts\n*** End Patch\n```',
    [{ name: 'src/gone.ts', content: 'export const gone = 1;\n' }]
  );
  assert.equal(scan.patches.length, 1);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].code, 'DELETE_NOT_A_PATCH');
  assert.match(scan.rejected[0].reason, /Deletion is not applied from a patch/);
  assert.match(scan.rejected[0].reason, /file tree/);
  assert.match(scan.rejected[0].reason, /ask the agent/);

  const onDisk = 'export const gone = 1;\n';
  const resolved = resolvePatchContent(scan.patches[0], onDisk);
  assert.equal(resolved.content, onDisk, 'zero bytes: a deletion is never invented from a patch');
  assert.equal(resolved.refusal?.code, 'DELETE_NOT_A_PATCH');
  assert.match(resolved.refusal?.reason ?? '', /src\/gone\.ts was left untouched/);
});

test('refusalReason reads the typed marker and ignores ordinary SEARCH blocks', () => {
  assert.equal(refusalReason({ original: 'const a = 1;', updated: 'const b = 2;' }), null);
  const parsed = refusalReason({
    original: '[apply-patch refused: MOVE_NOT_SUPPORTED: rename by hand]',
    updated: ''
  });
  assert.deepEqual(parsed, { code: 'MOVE_NOT_SUPPORTED', reason: 'rename by hand' });
});

test('a reply cut off mid SEARCH/REPLACE fence is a typed refusal, never a silent drop', () => {
  const reply = [
    'Here is the fix:',
    '```ts path=src/a.ts',
    '<<<<<<< ORIGINAL',
    'const a = 1;',
    '=======',
    'const a = 2;'
  ].join('\n');
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: 'const a = 1;\n' }]);
  assert.equal(scan.patches.length, 1, 'the edit intent still reaches review');
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].path, 'src/a.ts');
  assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');

  const onDisk = 'const a = 1;\n';
  const resolved = resolvePatchContent(scan.patches[0], onDisk);
  assert.equal(resolved.content, onDisk, 'zero bytes: a half-streamed edit never lands');
  assert.equal(resolved.refusal?.code, 'TRUNCATED_BLOCK');
});

test('a truncated fence whose first line names the file is still reported', () => {
  const reply = ['```ts', 'src/a.ts', '<<<<<<< ORIGINAL', 'const a = 1;'].join('\n');
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: 'const a = 1;\n' }]);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');
  assert.equal(scan.rejected[0].path, 'src/a.ts');
});

test('a truncated example fence without edit intent is not an edit attempt', () => {
  const reply = ['```ts', 'const example = 1;'].join('\n');
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: 'const a = 1;\n' }]);
  assert.deepEqual(scan.patches, []);
  assert.deepEqual(scan.rejected, []);
});

test('a truncated apply_patch fence with a declared path is reported', () => {
  const reply = ['```diff path=src/a.ts', '*** Begin Patch', '*** Update File: src/a.ts', '@@', '-const a = 1;'].join('\n');
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: 'const a = 1;\n' }]);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');
});

test('SEARCH markers without a complete block refuse instead of rewriting raw markers into the file', () => {
  const reply = ['```ts path=src/a.ts', '<<<<<<< ORIGINAL', 'const a = 1;', '```'].join('\n');
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: 'const a = 1;\n' }]);
  assert.equal(scan.patches.length, 1);
  assert.equal(scan.patches[0].kind, 'searchReplace', 'never a whole-file rewrite of raw markers');
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].code, 'MALFORMED_SEARCH_REPLACE');

  const onDisk = 'const a = 1;\n';
  const resolved = resolvePatchContent(scan.patches[0], onDisk);
  assert.equal(resolved.content, onDisk, 'raw markers never reach the file');
  assert.equal(resolved.refusal?.code, 'MALFORMED_SEARCH_REPLACE');
});

test('a complete block followed by a cut-off block refuses the file with a typed reason', () => {
  const reply = [
    '```ts path=src/a.ts',
    '<<<<<<< ORIGINAL',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '>>>>>>> UPDATED',
    '<<<<<<< ORIGINAL',
    'const b = 1;',
    '```'
  ].join('\n');
  const onDisk = 'const a = 1;\nconst b = 1;\n';
  const scan = extractUnifiedPatchScan(reply, [{ name: 'src/a.ts', content: onDisk }]);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');
  assert.match(scan.rejected[0].reason, /1 of 2/);

  const resolved = resolvePatchContent(scan.patches[0], onDisk);
  assert.equal(resolved.refusal?.code, 'TRUNCATED_BLOCK');
  assert.ok(resolved.failures.length > 0, 'the plan fails, so auto-apply writes zero bytes');
});
