import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExportIndex, planAutoImportFixes, type WorkspaceTextFile } from './autoFix.js';
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
