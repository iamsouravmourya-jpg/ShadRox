import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTypeFixPrompt,
  filterIntroducedDiagnostics,
  selectFixableDiagnostics,
  summarizeTypeFix,
  type TypeFixFile,
} from './typeErrorRefine.js';
import type { DesktopDiagnostic } from './desktop.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function diag(
  file: string,
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  line = 1,
  character = 0,
): DesktopDiagnostic {
  return { file, code, message, severity, line, character, endLine: line, endCharacter: character };
}

// ── filterIntroducedDiagnostics ──────────────────────────────────────────────

test('returns only new errors in changed files', () => {
  const before = [diag('src/a.ts', 'TS2304', "Cannot find name 'Foo'")];
  const after = [
    diag('src/a.ts', 'TS2304', "Cannot find name 'Foo'"),
    diag('src/a.ts', 'TS2322', "Type 'string' is not assignable to type 'number'"),
  ];
  const result = filterIntroducedDiagnostics(before, after, ['src/a.ts']);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'TS2322');
});

test('ignores new errors in files that were not changed', () => {
  const before: DesktopDiagnostic[] = [];
  const after = [diag('src/b.ts', 'TS2322', 'Type mismatch')];
  const result = filterIntroducedDiagnostics(before, after, ['src/a.ts']);
  assert.equal(result.length, 0);
});

test('ignores warnings even when they are new', () => {
  const before: DesktopDiagnostic[] = [];
  const after = [diag('src/a.ts', 'TS7006', 'Missing type', 'warning')];
  const result = filterIntroducedDiagnostics(before, after, ['src/a.ts']);
  assert.equal(result.length, 0);
});

test('deduplicates the same error appearing twice in after list', () => {
  const before: DesktopDiagnostic[] = [];
  const after = [
    diag('src/a.ts', 'TS2304', "Cannot find name 'X'", 'error', 1),
    diag('src/a.ts', 'TS2304', "Cannot find name 'X'", 'error', 5), // same code+message, different line
  ];
  // key excludes line, so both hash to the same key → only one result
  const result = filterIntroducedDiagnostics(before, after, ['src/a.ts']);
  assert.equal(result.length, 1);
});

test('returns empty when nothing changed', () => {
  const shared = [diag('src/a.ts', 'TS2304', "Cannot find name 'X'")];
  const result = filterIntroducedDiagnostics(shared, shared, ['src/a.ts']);
  assert.equal(result.length, 0);
});

test('returns empty when after list is empty', () => {
  const before = [diag('src/a.ts', 'TS2304', 'error')];
  const result = filterIntroducedDiagnostics(before, [], ['src/a.ts']);
  assert.equal(result.length, 0);
});

// ── selectFixableDiagnostics ─────────────────────────────────────────────────

test('keeps only known fixable codes', () => {
  const diagnostics = [
    diag('a.ts', 'TS2304', 'missing name'),
    diag('a.ts', 'TS9999', 'unknown code'),  // not in FIXABLE_CODES
    diag('a.ts', 'TS2322', 'type mismatch'),
  ];
  const result = selectFixableDiagnostics(diagnostics);
  assert.equal(result.length, 2);
  assert.ok(result.every((d) => ['TS2304', 'TS2322'].includes(d.code)));
});

test('respects the limit parameter', () => {
  const diagnostics = Array.from({ length: 10 }, (_, i) =>
    diag('a.ts', 'TS2304', `error ${i}`),
  );
  const result = selectFixableDiagnostics(diagnostics, 3);
  assert.equal(result.length, 3);
});

test('default limit is 8', () => {
  const diagnostics = Array.from({ length: 12 }, (_, i) =>
    diag('a.ts', 'TS2304', `error ${i}`),
  );
  const result = selectFixableDiagnostics(diagnostics);
  assert.equal(result.length, 8);
});

test('deduplicates identical diagnostics', () => {
  const diagnostics = [
    diag('a.ts', 'TS2304', "Cannot find name 'X'"),
    diag('a.ts', 'TS2304', "Cannot find name 'X'"), // duplicate
  ];
  const result = selectFixableDiagnostics(diagnostics);
  assert.equal(result.length, 1);
});

test('returns empty array when all codes are unknown', () => {
  const result = selectFixableDiagnostics([diag('a.ts', 'TS9999', 'unknown')]);
  assert.equal(result.length, 0);
});

// ── buildTypeFixPrompt ───────────────────────────────────────────────────────

test('returns null when diagnostics list is empty', () => {
  const files: TypeFixFile[] = [{ name: 'src/App.tsx', content: 'const x = 1;\n' }];
  assert.equal(buildTypeFixPrompt({ files, diagnostics: [] }), null);
});

test('returns null when files list is empty', () => {
  const diagnostics = [diag('a.ts', 'TS2304', 'error')];
  assert.equal(buildTypeFixPrompt({ files: [], diagnostics }), null);
});

test('returns null when no file matches a diagnostic', () => {
  const files: TypeFixFile[] = [{ name: 'src/App.tsx', content: 'const x = 1;\n' }];
  const diagnostics = [diag('src/Other.tsx', 'TS2304', 'error')];
  assert.equal(buildTypeFixPrompt({ files, diagnostics }), null);
});

test('prompt includes the diagnostic info', () => {
  const files: TypeFixFile[] = [
    { name: 'src/App.tsx', content: 'const x: number = "hello";\n' },
  ];
  const diagnostics = [diag('src/App.tsx', 'TS2322', "Type 'string' is not assignable")];
  const prompt = buildTypeFixPrompt({ files, diagnostics });
  assert.ok(prompt !== null);
  assert.ok(prompt.user.includes('TS2322'));
  assert.ok(prompt.user.includes('src/App.tsx'));
});

test('prompt system instructs SEARCH/REPLACE only', () => {
  const files: TypeFixFile[] = [{ name: 'a.ts', content: 'let x = 1;\n' }];
  const diagnostics = [diag('a.ts', 'TS2304', 'error')];
  const prompt = buildTypeFixPrompt({ files, diagnostics });
  assert.ok(prompt !== null);
  assert.ok(prompt.system.includes('SEARCH/REPLACE'));
  assert.ok(prompt.system.includes('Do not refactor'));
});

test('returned diagnostics match only included files', () => {
  const files: TypeFixFile[] = [
    { name: 'a.ts', content: 'code a\n' },
    { name: 'b.ts', content: 'code b\n' },
  ];
  const diagnostics = [
    diag('a.ts', 'TS2304', 'error in a'),
    diag('b.ts', 'TS2322', 'error in b'),
    diag('c.ts', 'TS2304', 'error in c'), // c.ts not in files
  ];
  const prompt = buildTypeFixPrompt({ files, diagnostics, maxFiles: 2 });
  assert.ok(prompt !== null);
  assert.ok(prompt.diagnostics.every((d) => ['a.ts', 'b.ts'].includes(d.file)));
});

test('prioritises files with more diagnostics', () => {
  const files: TypeFixFile[] = [
    { name: 'busy.ts', content: 'code\n' },
    { name: 'quiet.ts', content: 'code\n' },
  ];
  const diagnostics = [
    diag('busy.ts', 'TS2304', 'e1'),
    diag('busy.ts', 'TS2322', 'e2'),
    diag('busy.ts', 'TS2339', 'e3'),
    diag('quiet.ts', 'TS2304', 'e4'),
  ];
  // maxFiles=1 — only busiest file kept
  const prompt = buildTypeFixPrompt({ files, diagnostics, maxFiles: 1 });
  assert.ok(prompt !== null);
  assert.ok(prompt.diagnostics.every((d) => d.file === 'busy.ts'));
});

test('truncates very long file content', () => {
  const longContent = 'x'.repeat(8000);
  const files: TypeFixFile[] = [{ name: 'big.ts', content: longContent }];
  const diagnostics = [diag('big.ts', 'TS2304', 'error')];
  const prompt = buildTypeFixPrompt({ files, diagnostics });
  assert.ok(prompt !== null);
  assert.ok(prompt.user.includes('truncated'));
});

test('respects maxChars by dropping lower-priority files', () => {
  const files: TypeFixFile[] = [
    { name: 'a.ts', content: 'a'.repeat(100) },
    { name: 'b.ts', content: 'b'.repeat(100) },
  ];
  const diagnostics = [
    diag('a.ts', 'TS2304', 'e1'),
    diag('a.ts', 'TS2322', 'e2'),
    diag('b.ts', 'TS2304', 'e3'),
  ];
  // Tiny maxChars forces dropping b.ts
  const prompt = buildTypeFixPrompt({ files, diagnostics, maxChars: 200 });
  assert.ok(prompt !== null);
  // Should still return something (a.ts is highest priority)
  assert.ok(prompt.diagnostics.length > 0);
});

// ── summarizeTypeFix ─────────────────────────────────────────────────────────

test('reports improved on first attempt when count drops', () => {
  const result = summarizeTypeFix(5, 3, 1);
  assert.equal(result.improved, true);
  assert.equal(result.remaining, 3);
  assert.ok(result.message.includes('Fixed 2'));
});

test('reports not improved when count stays same', () => {
  const result = summarizeTypeFix(3, 3, 1);
  assert.equal(result.improved, false);
  assert.ok(result.message.includes('did not reduce'));
});

test('reports not improved when count goes up', () => {
  const result = summarizeTypeFix(2, 4, 1);
  assert.equal(result.improved, false);
});

test('remaining is clamped to 0 minimum for fixed count', () => {
  const result = summarizeTypeFix(3, 0, 1);
  assert.equal(result.remaining, 0);
  assert.ok(result.message.includes('Fixed 3'));
});

test('shows remaining count on subsequent attempts', () => {
  const result = summarizeTypeFix(5, 2, 2);
  assert.ok(result.message.includes('2 remaining'));
});

test('uses singular "error" when exactly 1 fixed', () => {
  const result = summarizeTypeFix(2, 1, 1);
  assert.ok(result.message.includes('Fixed 1 type error') && !result.message.includes('errors'));
});
