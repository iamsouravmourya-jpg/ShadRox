import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPlaceholderCheckedFile,
  lintPlaceholderCode,
  placeholderDiagnostics
} from './placeholderLint';

test('isPlaceholderCheckedFile targets JS/TS source files and skips docs/config', () => {
  assert.equal(isPlaceholderCheckedFile('src/routes/enroll.ts'), true);
  assert.equal(isPlaceholderCheckedFile('src/App.tsx'), true);
  assert.equal(isPlaceholderCheckedFile('README.md'), false);
  assert.equal(isPlaceholderCheckedFile('styles.css'), false);
});

test('lintPlaceholderCode catches empty string placeholder with trailing "if needed" comment', () => {
  const code = [
    'export function buildEnrollment(id: string) {',
    "  return { id, courseTitle: '', // Retrieve course title if needed",
    '  };',
    '}'
  ].join('\n');

  const issues = lintPlaceholderCode('src/routes/enroll.ts', code);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
  assert.match(issues[0].message, /Placeholder/i);
});

test('lintPlaceholderCode catches TODO comments paired with empty values, stubs, and truncation markers', () => {
  const code = [
    '// TODO: implement parser',
    "const body = '';",
    'export function verifyToken() {',
    '  // FIXME placeholder',
    "  throw new Error('Not implemented yet');",
    '}',
    '// ... rest of file unchanged'
  ].join('\n');

  const issues = lintPlaceholderCode('src/auth.ts', code);
  assert.ok(issues.length >= 3, `expected at least 3 placeholder issues, got ${issues.length}`);
  const diags = placeholderDiagnostics('src/auth.ts', code);
  assert.equal(diags.every((d) => d.severity === 'error' && d.path === 'src/auth.ts'), true);
});

test('lintPlaceholderCode allows legitimate empty strings without TODO/placeholder comments', () => {
  const code = [
    '// Initialize filter string before user types',
    "const initialQuery = '';",
    "const sep = ''; // empty delimiter for join",
    'export function joinParts(parts: string[]) {',
    '  return parts.join(sep);',
    '}'
  ].join('\n');

  assert.deepEqual(lintPlaceholderCode('src/utils/format.ts', code), []);
});
