'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyChangeSet, CHANGE_VERIFY_LIMITS } = require('./change-verify.cjs');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function verify(root, files) {
  return verifyChangeSet({ root, files });
}

test('limits are exported with the documented values', () => {
  assert.deepEqual({ ...CHANGE_VERIFY_LIMITS }, {
    maxFiles: 50,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    maxIssues: 200
  });
});

test('valid TypeScript passes', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: 'src/math.ts',
    content: 'export interface Point {\n  x: number;\n  y: number;\n}\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n'
  }]);

  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.skipped, []);
});

test('a TypeScript syntax error reports the 0-based line and character', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: 'src/broken.ts',
    content: 'const ok = 1;\nconst bad: = 2;\n'
  }]);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 1);
  assert.equal(result.issues.length, 1);
  const [issue] = result.issues;
  assert.equal(issue.path, 'src/broken.ts');
  assert.equal(issue.line, 1);
  assert.equal(issue.character, 11);
  assert.equal(issue.severity, 'error');
  assert.equal(issue.code, 'TS1110');
  assert.match(issue.message, /Type expected/);
});

test('JSX passes in .tsx and fails in .ts', (t) => {
  const root = makeRoot(t);
  const jsx = 'export function App() {\n  return <div className="x">hi</div>;\n}\n';

  const tsx = verify(root, [{ path: 'src/App.tsx', content: jsx }]);
  assert.equal(tsx.ok, true);
  assert.equal(tsx.checked, 1);
  assert.deepEqual(tsx.issues, []);

  const ts = verify(root, [{ path: 'src/App.ts', content: jsx }]);
  assert.equal(ts.ok, false);
  assert.ok(ts.issues.length >= 1);
  assert.equal(ts.issues[0].path, 'src/App.ts');
  assert.equal(ts.issues[0].line, 1);
  assert.equal(ts.issues[0].severity, 'error');
});

test('broken JSON reports the parse position', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: 'package.json',
    content: '{\n  "name": "app",\n}\n'
  }]);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 1);
  assert.equal(result.issues.length, 1);
  const [issue] = result.issues;
  assert.equal(issue.line, 2);
  assert.equal(issue.character, 0);
  assert.equal(issue.code, 'JSON_PARSE_ERROR');
  assert.equal(issue.severity, 'error');
  assert.match(issue.message, /position/i);
});

test('valid JSONC with comments passes and keeps strings intact', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: '.vscode/settings.jsonc',
    content: [
      '{',
      '  // A line comment with { and }',
      '  "url": "https://example.test/*not-a-comment*/",',
      '  /* a block comment',
      '     spanning lines */',
      '  "count": 2',
      '}',
      ''
    ].join('\n')
  }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.skipped, []);
});

test('unbalanced CSS braces are reported and balanced ones are not', (t) => {
  const root = makeRoot(t);

  const unclosed = verify(root, [{ path: 'src/a.css', content: '.card {\n  color: red;\n' }]);
  assert.equal(unclosed.ok, false);
  assert.equal(unclosed.issues.length, 1);
  assert.equal(unclosed.issues[0].line, 0);
  assert.equal(unclosed.issues[0].character, 6);
  assert.equal(unclosed.issues[0].code, 'CSS_UNBALANCED_BRACE');

  const extra = verify(root, [{ path: 'src/b.css', content: '.a { color: red; }\n}\n' }]);
  assert.equal(extra.ok, false);
  assert.equal(extra.issues.length, 1);
  assert.equal(extra.issues[0].line, 1);
  assert.equal(extra.issues[0].character, 0);

  const balanced = verify(root, [{
    path: 'src/c.scss',
    content: [
      '// .ghost { commented out }',
      '.a {',
      '  content: "}{";',
      '  background: url(http://example.test/a.png);',
      '}',
      '/* trailing { comment */',
      ''
    ].join('\n')
  }]);
  assert.equal(balanced.ok, true, JSON.stringify(balanced.issues));
  assert.deepEqual(balanced.issues, []);
});

test('absolute, UNC, drive-lettered and escaping paths are rejected without reading disk', (t) => {
  const root = makeRoot(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-verify-outside-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  // This file exists and is broken; if the gate ever read it, a TS diagnostic
  // would appear alongside the path issue.
  const outsideFile = path.join(outsideRoot, 'outside.ts');
  fs.writeFileSync(outsideFile, 'const bad: = 1;\n');

  const result = verify(root, [
    { path: outsideFile, content: 'const bad: = 1;\n' },
    { path: '../escape.ts', content: 'const bad: = 1;\n' },
    { path: 'src/../../escape.ts', content: 'const bad: = 1;\n' },
    { path: 'C:/Windows/win.ini', content: 'const bad: = 1;\n' },
    { path: 'C:relative.ts', content: 'const bad: = 1;\n' },
    { path: '\\\\server\\share\\a.ts', content: 'const bad: = 1;\n' },
    { path: '/etc/passwd', content: 'const bad: = 1;\n' }
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.issues.length, 7);
  for (const issue of result.issues) {
    assert.equal(issue.severity, 'error');
    assert.equal(issue.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(issue.message, 'outside the opened workspace');
    assert.equal(issue.line, 0);
    assert.equal(issue.character, 0);
  }
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes('../escape.ts'));
  assert.ok(paths.includes('src/../../escape.ts'));
  assert.ok(paths.includes('C:/Windows/win.ini'));
  assert.ok(paths.includes('/etc/passwd'));
  assert.ok(!result.issues.some((issue) => issue.code.startsWith('TS')));
});

test('a file over the per-file limit is skipped and fails the gate', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: 'src/huge.ts',
    content: `const a = 1;\n// ${'x'.repeat(CHANGE_VERIFY_LIMITS.maxFileBytes)}`
  }]);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.skipped, ['src/huge.ts']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'FILE_TOO_LARGE');
  assert.equal(result.issues[0].path, 'src/huge.ts');
});

test('more than the maximum number of files is rejected', (t) => {
  const root = makeRoot(t);
  const files = Array.from(
    { length: CHANGE_VERIFY_LIMITS.maxFiles + 1 },
    (_, index) => ({ path: `src/f${index}.ts`, content: 'export const value = 1;\n' })
  );
  assert.throws(
    () => verify(root, files),
    /at most 50 files/
  );
});

test('the total byte budget is enforced', (t) => {
  const root = makeRoot(t);
  const chunk = `.a {}\n/*${'y'.repeat(CHANGE_VERIFY_LIMITS.maxFileBytes - 10)}*/`;
  assert.equal(Buffer.byteLength(chunk, 'utf8'), CHANGE_VERIFY_LIMITS.maxFileBytes);
  const files = Array.from(
    { length: 5 },
    (_, index) => ({ path: `src/style${index}.css`, content: chunk })
  );

  const result = verify(root, files);
  assert.equal(result.ok, false);
  assert.equal(result.checked, 4);
  assert.deepEqual(result.skipped, ['src/style4.css']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'CHANGE_SET_TOO_LARGE');
  assert.equal(result.issues[0].path, 'src/style4.css');
});

test('empty and whitespace-only content is skipped', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [
    { path: 'src/empty.ts', content: '' },
    { path: 'src/blank.ts', content: '  \n\t\r\n' }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.skipped, ['src/empty.ts', 'src/blank.ts']);
});

test('unknown extensions are skipped', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [
    { path: 'notes.txt', content: 'unbalanced { brace' },
    { path: 'assets/logo.png', content: 'not really a png' }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.skipped, ['notes.txt', 'assets/logo.png']);
});

test('the gate judges the proposed content, never the copy on disk, and touches nothing', (t) => {
  const root = makeRoot(t);
  const appPath = path.join(root, 'src', 'App.ts');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  // Disk holds valid code, the proposal is broken: the gate must fail closed
  // on the proposal — this is the content that would land, so this is what
  // must be judged.
  fs.writeFileSync(appPath, 'export const a = 1;\n', 'utf8');
  const brokenProposal = verify(root, [{ path: 'src/App.ts', content: 'const bad: = 2;\n' }]);
  assert.equal(brokenProposal.ok, false);
  assert.equal(brokenProposal.issues[0].code, 'TS1110');
  assert.equal(brokenProposal.checked, 1);

  // Disk holds broken code, the proposal is the fix: the gate must pass on
  // the proposal alone — it never reads the pre-image.
  fs.writeFileSync(appPath, 'const bad: = 1;\n', 'utf8');
  const validProposal = verify(root, [{ path: 'src/App.ts', content: 'export const a = 1;\n' }]);
  assert.equal(validProposal.ok, true);
  assert.deepEqual(validProposal.issues, []);

  // Verification is pure: the workspace is byte-identical afterwards, and no
  // temporary or side-effect files were created anywhere.
  assert.equal(fs.readFileSync(appPath, 'utf8'), 'const bad: = 1;\n');
  const strays = fs.readdirSync(path.join(root, 'src')).filter((name) => name.startsWith('.shadrox-'));
  assert.deepEqual(strays, []);
});

test('a missing or non-directory root throws', (t) => {
  const root = makeRoot(t);
  const missing = path.join(root, 'does-not-exist');
  assert.throws(() => verify(missing, []), /workspace root does not exist/i);

  const file = path.join(root, 'file.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  assert.throws(() => verify(file, []), /not a directory/i);

  assert.throws(() => verifyChangeSet({ files: [] }), /workspace root directory/i);
  assert.throws(() => verify(root, 'nope'), /array of \{ path, content \} entries/i);
  assert.throws(() => verify(root, [null]), /must be an object/i);
});

test('HTML documents are checked for closing script and html tags', (t) => {
  const root = makeRoot(t);

  const missingHtml = verify(root, [{
    path: 'index.html',
    content: '<!doctype html>\n<html>\n  <body>hi</body>\n'
  }]);
  assert.equal(missingHtml.ok, false);
  assert.equal(missingHtml.issues.length, 1);
  assert.equal(missingHtml.issues[0].code, 'HTML_MISSING_CLOSE_HTML');

  const unclosedScript = verify(root, [{
    path: 'page.html',
    content: '<html>\n<script src="app.js">\n</html>\n'
  }]);
  assert.equal(unclosedScript.ok, false);
  assert.equal(unclosedScript.issues.length, 1);
  assert.equal(unclosedScript.issues[0].code, 'HTML_UNBALANCED_SCRIPT');
  assert.equal(unclosedScript.issues[0].line, 1);

  const extraClose = verify(root, [{
    path: 'frag.html',
    content: '<!DOCTYPE html>\n<html>\n</script>\n</html>\n'
  }]);
  assert.equal(extraClose.ok, false);
  assert.equal(extraClose.issues[0].code, 'HTML_UNBALANCED_SCRIPT');

  // Fragments and partials are not documents, so they are left alone.
  const fragment = verify(root, [{
    path: 'partial.html',
    content: '<div class="card">hi</div>'
  }]);
  assert.equal(fragment.ok, true);
  assert.deepEqual(fragment.issues, []);

  const valid = verify(root, [{
    path: 'ok.html',
    content: '<!DOCTYPE html>\n<html>\n<script>console.log(1)</script>\n</html>\n'
  }]);
  assert.equal(valid.ok, true);
});

test('issues are sorted by path, then line, then character', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [
    { path: 'src/b.ts', content: 'const bad: = 1;\nconst good = 2;\nconst bad: = 3;\n' },
    { path: 'src/a.ts', content: 'const a = 1;\nconst bad: = 2;\n' }
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.map((issue) => [issue.path, issue.line, issue.character]),
    [
      ['src/a.ts', 1, 11],
      ['src/b.ts', 0, 11],
      ['src/b.ts', 2, 11]
    ]
  );
});

test('issue output is truncated at the documented cap', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{
    path: 'src/many.ts',
    content: Array.from({ length: 240 }, () => 'const a = ;').join('\n')
  }]);

  assert.equal(result.ok, false);
  assert.equal(result.issues.length, CHANGE_VERIFY_LIMITS.maxIssues);
  assert.equal(result.issues[0].line, 0);
  assert.equal(result.issues[CHANGE_VERIFY_LIMITS.maxIssues - 1].line, CHANGE_VERIFY_LIMITS.maxIssues - 1);
});

test('module variants pick the matching script kind', (t) => {
  const root = makeRoot(t);

  const mjs = verify(root, [{ path: 'src/a.mjs', content: 'await Promise.resolve();\nexport const a = 1;\n' }]);
  assert.equal(mjs.ok, true);

  const cjs = verify(root, [{ path: 'src/a.cjs', content: "const path = require('node:path');\nmodule.exports = path;\n" }]);
  assert.equal(cjs.ok, true);

  const mts = verify(root, [{ path: 'src/a.mts', content: 'export const a: number = 1;\n' }]);
  assert.equal(mts.ok, true);

  const jsxInJs = verify(root, [{ path: 'src/a.jsx', content: 'export const a = <span>hi</span>;\n' }]);
  assert.equal(jsxInJs.ok, true);

  const jsxInJsFile = verify(root, [{ path: 'src/a.js', content: 'export const a = <span>hi</span>;\n' }]);
  assert.equal(jsxInJsFile.ok, false);
  assert.equal(jsxInJsFile.issues.length, 1);
  assert.equal(jsxInJsFile.issues[0].code, 'JSX_NOT_ALLOWED');
  assert.equal(jsxInJsFile.issues[0].line, 0);
  assert.equal(jsxInJsFile.issues[0].character, 17);

  const plainJs = verify(root, [{ path: 'src/b.js', content: 'export const a = 1;\n' }]);
  assert.equal(plainJs.ok, true);

  // Comparison operators must not look like JSX tags.
  const comparisons = verify(root, [{
    path: 'src/compare.js',
    content: 'export const smaller = a < b;\nexport const chained = a<b>c;\nexport const ternary = a < b ? c : d;\n'
  }]);
  assert.equal(comparisons.ok, true, JSON.stringify(comparisons.issues));
});

/* -------------------------------------------------------------------------- *
 * Named checks and explicit skips: "not applicable" must never read as
 * "did not pass". A created plain-text file is the reported false warning.
 * -------------------------------------------------------------------------- */

test('a newly created plain-text file is skipped with a reason and never fails the gate', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{ path: 'notes/test.txt', content: 'hello\n' }]);

  assert.equal(result.ok, true, 'nothing is wrong with a plain-text file');
  assert.equal(result.checked, 0);
  assert.deepEqual(result.skipped, ['notes/test.txt']);
  assert.deepEqual(result.results, [{
    path: 'notes/test.txt',
    status: 'skipped',
    skipped: true,
    reason: 'no static check for .txt files',
    code: 'NO_STATIC_CHECK'
  }]);

  const syntax = result.checks.find((check) => check.id === 'static-syntax');
  assert.equal(syntax.ran, false, 'no checker ran');
  assert.equal(syntax.ok, true, 'not applicable is not a failure');
  assert.match(syntax.details, /Nothing to parse/);
  assert.deepEqual(result.failedChecks, []);
});

test('an empty created file is skipped with an explicit reason instead of an ok', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{ path: 'notes/empty.txt', content: '' }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{
    path: 'notes/empty.txt',
    status: 'skipped',
    skipped: true,
    reason: 'empty content — nothing to verify',
    code: 'EMPTY_CONTENT'
  }]);
  assert.deepEqual(result.failedChecks, []);
});

test('a real syntax error names the check that failed', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [
    { path: 'src/broken.ts', content: 'const bad: = 1;\n' },
    { path: 'notes/test.txt', content: 'unbalanced { brace\n' }
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failedChecks, ['static-syntax']);
  const syntax = result.checks.find((check) => check.id === 'static-syntax');
  assert.equal(syntax.ran, true);
  assert.equal(syntax.ok, false);
  assert.equal(syntax.failures, 1);
  assert.match(syntax.details, /1 file\(s\) checked, 1 skipped/);
  assert.equal(result.results.find((entry) => entry.path === 'notes/test.txt').skipped, true);
  assert.equal(result.results.find((entry) => entry.path === 'src/broken.ts').status, 'checked');
});

test('boundary and size refusals name their own checks', (t) => {
  const root = makeRoot(t);
  const boundary = verify(root, [{ path: '/etc/passwd', content: 'x\n' }]);
  assert.deepEqual(boundary.failedChecks, ['path-boundary']);
  assert.equal(boundary.results[0].skipped, false);
  assert.equal(boundary.results[0].code, 'PATH_OUTSIDE_WORKSPACE');

  const huge = verify(root, [{
    path: 'src/huge.ts',
    content: `const a = 1;\n// ${'x'.repeat(CHANGE_VERIFY_LIMITS.maxFileBytes)}`
  }]);
  assert.deepEqual(huge.failedChecks, ['size-limits']);
  assert.deepEqual(huge.results, [{
    path: 'src/huge.ts',
    status: 'skipped',
    skipped: true,
    reason: `larger than the ${CHANGE_VERIFY_LIMITS.maxFileBytes} byte verification limit`,
    code: 'FILE_TOO_LARGE'
  }]);
});

test('every documented check is always present with a name and a ran flag', (t) => {
  const root = makeRoot(t);
  const result = verify(root, [{ path: 'src/a.ts', content: 'export const a = 1;\n' }]);
  assert.deepEqual(
    result.checks.map((check) => [check.id, check.name, check.ok, check.ran]),
    [
      ['path-boundary', 'Workspace boundary', true, true],
      ['content-shape', 'Change shape', true, true],
      ['size-limits', 'Size limits', true, true],
      ['static-syntax', 'Static syntax validation', true, true],
      ['report-limit', 'Issue report limit', true, false]
    ]
  );
  assert.deepEqual(result.results, [{
    path: 'src/a.ts',
    status: 'checked',
    skipped: false,
    check: 'TypeScript/JavaScript syntax',
    reason: 'checked as TypeScript/JavaScript syntax'
  }]);
});
