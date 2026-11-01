import assert from 'node:assert/strict';
import test from 'node:test';
import { readContextFiles, selectContextCandidates } from './contextCandidates';
import type { WorkspaceFileEntry } from './types';

function tree(...paths: string[]): WorkspaceFileEntry[] {
  return paths.map((path) => ({ path, size: 4096 }));
}

const BASE = { maxFiles: 6, maxBytesPerFile: 60_000 };

test('a project-level query earns the manifests before anything else', () => {
  const entries = tree(
    'package.json',
    'tsconfig.json',
    'src/App.tsx',
    'src/components/ChatPanel.tsx',
    'electron/main.cjs'
  );
  const chosen = selectContextCandidates(entries, 'explain this project architecture', BASE);
  assert.equal(chosen[0], 'package.json');
  assert.ok(chosen.includes('tsconfig.json'));
});

test('a file-specific query reads that file, not the manifest', () => {
  const entries = tree('package.json', 'src/App.tsx', 'src/components/ChatPanel.tsx', 'README.md');
  const chosen = selectContextCandidates(entries, 'fix the resize bug in ChatPanel', BASE);
  assert.equal(chosen[0], 'src/components/ChatPanel.tsx');
});

test('files the editor already has in a buffer are not re-read', () => {
  const entries = tree('src/App.tsx', 'src/lib/retrieval.ts');
  const chosen = selectContextCandidates(entries, 'the retrieval scorer', { ...BASE, loadedPaths: ['src/App.tsx'] });
  assert.deepEqual(chosen, ['src/lib/retrieval.ts']);
});

test('binaries, empty files and oversized files are never candidates', () => {
  const entries: WorkspaceFileEntry[] = [
    { path: 'assets/logo.png', size: 4096 },
    { path: 'src/empty.ts', size: 0 },
    { path: 'src/huge.ts', size: 5_000_000 },
    { path: 'src/App.tsx', size: 4096 }
  ];
  const chosen = selectContextCandidates(entries, 'src/App.tsx huge.ts logo.png empty.ts', BASE);
  assert.deepEqual(chosen, ['src/App.tsx']);
});

test('the file cap is honoured', () => {
  const entries = tree('a1.ts', 'a2.ts', 'a3.ts', 'a4.ts', 'a5.ts', 'a6.ts', 'a7.ts');
  assert.equal(selectContextCandidates(entries, 'a1 a2 a3 a4 a5 a6 a7', { ...BASE, maxFiles: 3 }).length, 3);
});

test('reading context files survives a per-file failure', async () => {
  const failures: string[] = [];
  const read = await readContextFiles(
    ['src/App.tsx', 'src/blocked.ts', 'src/main.ts'],
    async (path) => {
      if (path === 'src/blocked.ts') throw new Error('Binary and generated files cannot be opened as text.');
      return path;
    },
    (failure) => failures.push(failure.path)
  );
  assert.deepEqual(read.sort(), ['src/App.tsx', 'src/main.ts']);
  assert.deepEqual(failures, ['src/blocked.ts']);
});
