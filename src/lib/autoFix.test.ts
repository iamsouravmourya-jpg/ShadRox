import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExportIndex,
  classifyCommandFailure,
  formatCommandFailureLine,
  planAutoImportFixes,
  type CommandFailureInput,
  type WorkspaceTextFile
} from './autoFix.js';
import type { DesktopDiagnostic } from './desktop.js';

function diagnostic(file: string, message: string, code: string, line: number): DesktopDiagnostic {
  return { file, message, code, line, character: 0, endLine: line, endCharacter: 0, severity: 'error' };
}

// ── buildExportIndex ──────────────────────────────────────────────────────────

test('indexes a named export function', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function formatDate() {}\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('formatDate');
  assert.ok(entries && entries.length === 1);
  assert.equal(entries[0].kind, 'named');
  assert.equal(entries[0].file, 'src/utils.ts');
});

test('indexes a named export const', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/config.ts', content: 'export const API_URL = "http://localhost";\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('API_URL');
  assert.ok(entries && entries[0].kind === 'named');
});

test('indexes a default export class', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/App.tsx', content: 'export default class App {}\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('App');
  assert.ok(entries && entries[0].kind === 'default');
});

test('indexes a type export', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/types.ts', content: 'export type UserId = string;\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('UserId');
  assert.ok(entries && entries[0].kind === 'type');
});

test('indexes interface as type', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/types.ts', content: 'export interface UserProfile { name: string }\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('UserProfile');
  assert.ok(entries && entries[0].kind === 'type');
});

test('indexes braced named re-export', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/index.ts', content: "export { useState, useEffect } from 'react';\n" },
  ];
  const index = buildExportIndex(files);
  assert.ok(index.has('useState'));
  assert.ok(index.has('useEffect'));
});

test('indexes braced type re-export', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/index.ts', content: "export type { Foo, Bar } from './types';\n" },
  ];
  const index = buildExportIndex(files);
  assert.equal(index.get('Foo')?.[0].kind, 'type');
  assert.equal(index.get('Bar')?.[0].kind, 'type');
});

test('ignores non-exported declarations', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'function helper() {}\nconst x = 1;\n' },
  ];
  const index = buildExportIndex(files);
  assert.equal(index.size, 0);
});

test('handles multiple files and same symbol in multiple files', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/a.ts', content: 'export function log() {}\n' },
    { name: 'src/b.ts', content: 'export function log() {}\n' },
  ];
  const index = buildExportIndex(files);
  const entries = index.get('log');
  assert.equal(entries?.length, 2);
});

test('ignores export of "default" as a name', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/x.ts', content: "export { default } from './y';\n" },
  ];
  const index = buildExportIndex(files);
  assert.ok(!index.has('default'));
});

// ── planAutoImportFixes ───────────────────────────────────────────────────────

test('resolves a missing TS2304 diagnostic with a named import', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function formatDate() {}\n' },
    { name: 'src/App.tsx', content: 'const x = formatDate();\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'formatDate'", 'TS2304', 1)],
    files,
  );
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].symbol, 'formatDate');
  assert.equal(result.patches.length, 1);
  assert.ok(result.patches[0].content.includes("import { formatDate }"));
  assert.equal(result.unresolved.length, 0);
});

test('resolves a type import correctly', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/types.ts', content: 'export type UserId = string;\n' },
    { name: 'src/App.tsx', content: 'const id: UserId = "1";\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'UserId'", 'TS2304', 1)],
    files,
  );
  assert.equal(result.resolved.length, 1);
  assert.ok(result.patches[0].content.includes("import type { UserId }"));
});

test('leaves non-TS2304 diagnostics as unresolved', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/App.tsx', content: 'const x = 1;\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Type 'string' is not assignable", 'TS2322', 1)],
    files,
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.patches.length, 0);
});

test('marks ambiguous symbol (exported from 2+ files) as unresolved', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/a.ts', content: 'export function log() {}\n' },
    { name: 'src/b.ts', content: 'export function log() {}\n' },
    { name: 'src/App.tsx', content: 'log();\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'log'", 'TS2304', 1)],
    files,
  );
  assert.equal(result.unresolved.length, 1);
  assert.ok(result.notes.some((n) => n.includes('Ambiguous')));
});

test('skips self-import when symbol is declared in the same file', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function helper() {}\nconst x = helper();\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/utils.ts', "Cannot find name 'helper'", 'TS2304', 2)],
    files,
  );
  assert.equal(result.patches.length, 0);
  assert.ok(result.notes.some((n) => n.includes('self-import')));
});

test('skips symbol that is already imported in the target file', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function helper() {}\n' },
    { name: 'src/App.tsx', content: "import { helper } from './utils';\nhelper();\n" },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'helper'", 'TS2304', 2)],
    files,
  );
  assert.equal(result.patches.length, 0);
  assert.ok(result.notes.some((n) => n.includes('already imported')));
});

test('adds import before existing imports when file has imports', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function foo() {}\n' },
    {
      name: 'src/App.tsx',
      content: "import React from 'react';\nconst x = foo();\n",
    },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'foo'", 'TS2304', 2)],
    files,
  );
  assert.equal(result.patches.length, 1);
  const lines = result.patches[0].content.split('\n');
  // The new import must appear before or right after the React import, not at the bottom
  const importLineIdx = lines.findIndex((l) => l.includes("import { foo }"));
  const reactLineIdx = lines.findIndex((l) => l.includes("import React"));
  assert.ok(importLineIdx < lines.length - 1, 'import should not be at the very end');
  assert.ok(importLineIdx <= reactLineIdx + 1, 'import should be near existing imports');
});

test('does not modify file content when no imports are needed', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/App.tsx', content: 'const x = 1;\n' },
  ];
  const result = planAutoImportFixes([], files);
  assert.equal(result.patches.length, 0);
  assert.equal(result.resolved.length, 0);
});

test('handles symbol not found in any file', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/App.tsx', content: 'const x = unknownSymbol();\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/App.tsx', "Cannot find name 'unknownSymbol'", 'TS2304', 1)],
    files,
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.patches.length, 0);
  assert.ok(result.notes.some((n) => n.includes('No workspace export found')));
});

test('handles diagnostic for a file not in the workspace files list', () => {
  const files: WorkspaceTextFile[] = [
    { name: 'src/utils.ts', content: 'export function foo() {}\n' },
  ];
  const result = planAutoImportFixes(
    [diagnostic('src/ghost.tsx', "Cannot find name 'foo'", 'TS2304', 1)],
    files,
  );
  assert.equal(result.unresolved.length, 1);
  assert.ok(result.notes.some((n) => n.includes('No workspace file found')));
});

// ── classifyCommandFailure ────────────────────────────────────────────────────

function failure(stderr: string, exitCode: number | null, stdout = ''): CommandFailureInput {
  return { command: 'npm run check', exitCode, stdout, stderr };
}

test('classifies a missing module as missing-dependency', () => {
  const result = classifyCommandFailure(failure(
    "node:internal/modules/cjs/loader:1143\n  throw err;\n ^\n\nError: Cannot find module 'express'\nRequire stack:\n- /app/server.js\n",
    1,
  ));
  assert.equal(result.class, 'missing-dependency');
  assert.equal(result.rule, 'dependency');
  assert.match(result.detail, /Cannot find module 'express'/);
  assert.equal(result.retryable, false);
  assert.ok(result.repairHints.some((hint) => /install/i.test(hint)));
  assert.equal(result.command, 'npm run check');
});

test('classifies a missing python module and an uninstalled tool', () => {
  assert.equal(classifyCommandFailure(failure("ModuleNotFoundError: No module named 'ruff'", 1)).class, 'missing-dependency');
  assert.equal(classifyCommandFailure(failure("Error: Cannot find package '@vercel/analytics' imported from /app/a.ts", 1)).class, 'missing-dependency');
  assert.equal(classifyCommandFailure(failure('error TS2307: Cannot find module \'./gen/schema\' or its corresponding type declarations.', 2)).class, 'missing-dependency');
});

test('classifies failing test output as test-assertion', () => {
  const result = classifyCommandFailure(failure(
    'FAIL src/widgets.test.ts\n  \u25cf widgets \u203a paints\n\n    expect(received).toBe(expected)\n\n    Expected: "red"\n    Received: "blue"\n\nTests:       1 failed, 4 passed, 5 total\n',
    1,
  ));
  assert.equal(result.class, 'test-assertion');
  assert.equal(result.explanation, 'The suite ran and at least one assertion failed.');
  assert.ok(result.repairHints.length >= 2);
});

test('classifies pytest, go test and tap styles as test-assertion', () => {
  assert.equal(classifyCommandFailure(failure('FAILED tests/test_parser.py::parse_empty - assert 3 == 4\n=== 1 failed, 12 passed in 0.42s ===', 1)).class, 'test-assertion');
  assert.equal(classifyCommandFailure(failure('--- FAIL: TestRoundTrip (0.00s)\n    roundtrip_test.go:31: mismatch', 1)).class, 'test-assertion');
  assert.equal(classifyCommandFailure(failure('not ok 1 - adds two numbers', 1)).class, 'test-assertion');
});

test('a test run that died on an unresolvable import is a dependency problem first', () => {
  const result = classifyCommandFailure(failure('FAIL src/api.test.ts\nError: Cannot find module \'./server\'\nTests: 1 failed\n', 1));
  assert.equal(result.class, 'missing-dependency');
});

test('classifies permission denied and EACCES as permission', () => {
  const result = classifyCommandFailure(failure(
    "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'\n",
    1,
  ));
  assert.equal(result.class, 'permission');
  assert.match(result.detail, /EACCES: permission denied/);

  assert.equal(classifyCommandFailure(failure('rm: cannot remove /etc/hosts: Permission denied', 1)).class, 'permission');
  assert.equal(classifyCommandFailure(failure('./deploy.sh: Operation not permitted', 126)).class, 'permission');
  assert.equal(classifyCommandFailure(failure('git: /repo/.git: access is denied', 1)).class, 'permission');
});

test('classifies command not found as not-found', () => {
  const result = classifyCommandFailure(failure('/bin/bash: line 1: pytest: command not found\n', 127));
  assert.equal(result.class, 'not-found');
  assert.match(result.detail, /pytest: command not found/);

  assert.equal(classifyCommandFailure(failure("'yarn' is not recognized as the name of a cmdlet, function, script file, or operable program.", 1)).class, 'not-found');
  assert.equal(classifyCommandFailure(failure('sh: 1: ./scripts/build.sh: not found', 127)).class, 'not-found');
  assert.equal(classifyCommandFailure(failure("can't open file 'train.py': [Errno 2] No such file or directory", 2)).class, 'not-found');
});

test('classifies network failures as retryable', () => {
  const result = classifyCommandFailure(failure(
    'curl: (7) Failed to connect to registry.npmjs.org port 443 after 30005 ms: Could not connect to server\n',
    7,
  ));
  assert.equal(result.class, 'network');
  assert.equal(result.retryable, true);
  assert.ok(result.repairHints.some((hint) => /environmental/i.test(hint)));

  assert.equal(classifyCommandFailure(failure('FetchError: request to https://api.example.com failed, reason: connect ECONNREFUSED 127.0.0.1:443', 1)).class, 'network');
  assert.equal(classifyCommandFailure(failure('Temporary failure in name resolution while fetching index', 1)).class, 'network');
});

test('classifies timeouts and kills as timeout', () => {
  assert.equal(classifyCommandFailure(failure('Command timed out after 90 seconds', 124)).class, 'timeout');
  assert.equal(classifyCommandFailure(failure('Killed', 137)).class, 'timeout');
  assert.equal(classifyCommandFailure(failure('Test timed out in 5000ms.', 1)).class, 'timeout');
});

test('classifies parse and syntax problems as syntax', () => {
  assert.equal(classifyCommandFailure(failure("SyntaxError: Unexpected token '}' (12:7)", 1)).class, 'syntax');
  assert.equal(classifyCommandFailure(failure('  File "app.py", line 4\n    if x = 1\n       ^^\nSyntaxError: invalid syntax', 1)).class, 'syntax');
  assert.equal(classifyCommandFailure(failure('main.go:8:2: expected declaration, found \'package\'', 1)).class, 'syntax');
});

test('an unclassifiable failure is reported as unknown, never thrown', () => {
  const result = classifyCommandFailure(failure('something happened that we do not recognise', 3));
  assert.equal(result.class, 'unknown');
  assert.equal(result.rule, 'unknown');
  assert.match(result.explanation, /exit 3/);
  assert.equal(result.detail, 'something happened that we do not recognise');

  const empty = classifyCommandFailure({ command: 'make', exitCode: null });
  assert.equal(empty.class, 'unknown');
  assert.match(empty.explanation, /exit unknown/);
  assert.equal(classifyCommandFailure(undefined as unknown as CommandFailureInput).class, 'unknown');
});

test('a successful exit is classified as none', () => {
  const result = classifyCommandFailure(failure('Everything is fine, 5 passed', 0));
  assert.equal(result.class, 'none');
  assert.equal(result.rule, 'success');
  assert.deepEqual(result.repairHints, []);
});

test('classification ignores ANSI colour codes and reads the tail of long output', () => {
  const coloured = classifyCommandFailure(failure('\x1b[31mPermission denied\x1b[0m', 1));
  assert.equal(coloured.class, 'permission');
  assert.equal(coloured.detail, 'Permission denied');

  const noisy = `${'filler line\n'.repeat(4000)}Error: Cannot find module 'late-dep'\n`;
  assert.equal(classifyCommandFailure(failure(noisy, 1)).class, 'missing-dependency');
});

test('formatCommandFailureLine is a compact single line', () => {
  const line = formatCommandFailureLine(classifyCommandFailure(failure("Error: Cannot find module 'express'", 1)));
  assert.equal(line, 'missing-dependency \u00b7 Error: Cannot find module \'express\' (exit 1)');
  assert.doesNotMatch(line, /[\r\n]/);
});
