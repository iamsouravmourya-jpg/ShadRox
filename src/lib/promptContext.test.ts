import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildFileTreeMap } from './retrieval';
import { describeWorkspaceForPrompt, mergeInventory } from './contextCandidates';
import { selectContextCandidates } from './contextCandidates';
import type { WorkspaceFileEntry } from './types';

/**
 * Regression cover for the defect where a folder workspace contributed nothing
 * to the prompt: the editor keeps no buffers until a tab is opened, and the
 * content-based repo map therefore rendered an empty string.
 */

function syntheticTree(fileCount: number): WorkspaceFileEntry[] {
  const directories = ['src', 'src/components', 'src/hooks', 'src/lib', 'electron', 'api', 'api/ai'];
  return Array.from({ length: fileCount }, (_, index) => ({
    path: `${directories[index % directories.length]}/Module${index}.tsx`,
    size: 1024 + index
  }));
}

test('a folder with no open tabs still produces a repo map', () => {
  const map = buildFileTreeMap(syntheticTree(219));
  assert.ok(map.length > 0, 'the inventory must never be empty when files exist');
  assert.match(map, /219 file\(s\), contents not included unless shown below:/);
  assert.match(map, /src\/components\/ —/);
  assert.ok(map.includes('Module0.tsx'));
});

test('an empty tree produces an empty map, not a stray header', () => {
  assert.equal(buildFileTreeMap([]), '');
});

test('the map stays inside its budget and says what it dropped', () => {
  // Many small directories, so the budget runs out on breadth, not on one folder.
  const entries = Array.from({ length: 600 }, (_, directory) =>
    Array.from({ length: 3 }, (unused, file) => ({
      path: `src/pkg${directory}/Module${file}.ts`,
      size: 600
    }))
  ).flat();
  const map = buildFileTreeMap(entries, 2_000);
  assert.ok(map.length <= 2_000, `expected under 2000 chars, got ${map.length}`);
  assert.match(map, /not listed \(path list truncated at this budget\)/);
  // Truncation is reported honestly instead of implying the list was complete.
  assert.match(map, /^(\d+) of 1800 file\(s\) listed by path/);
  assert.ok(Number(map.match(/^(\d+)/)?.[1]) < 1800);
});

test('every directory is mentioned before any of them is detailed', () => {
  // One directory holds 300 files and the other 3; a per-directory dump would
  // let the big one fill the budget and hide the small one entirely.
  const entries = [
    ...Array.from({ length: 300 }, (_, index) => ({ path: `src/big/File${index}.ts`, size: 500 })),
    ...Array.from({ length: 3 }, (_, index) => ({ path: `src/small/Only${index}.ts`, size: 500 }))
  ];
  const map = buildFileTreeMap(entries, 400);
  assert.match(map, /src\/big\/ —/);
  assert.match(map, /\+292 more/);
  assert.match(map, /src\/small\/ — Only0\.ts, Only1\.ts, Only2\.ts/);
});

test('the root directory is listed in full', () => {
  // The root holds the manifests and entry points, and a model cannot ask for
  // a file whose name it was never shown — an in-app run lost the analysis of
  // six root files exactly because the per-directory cap treated them like
  // leaf files.
  const entries = Array.from({ length: 30 }, (_, index) => ({ path: `Config${index}.ts`, size: 500 }));
  const map = buildFileTreeMap(entries);
  assert.doesNotMatch(map, /\(root\).*more/);
  assert.match(map, /Config29\.ts/);
});

test('Windows separators and root-level files are normalised', () => {
  const map = buildFileTreeMap([
    { path: 'package.json', size: 900 },
    { path: 'src\\App.tsx', size: 1200 }
  ]);
  assert.match(map, /\(root\) — package\.json/);
  assert.match(map, /src\/ — App\.tsx/);
});

test('a real folder with no open tabs still gives the prompt paths and readable files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src/components'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{ "name": "demo", "scripts": { "dev": "tsx server.ts" } }');
  await fs.writeFile(path.join(root, 'src/App.tsx'), 'export default function App() { return null; }');
  await fs.writeFile(path.join(root, 'src/components/ChatPanel.tsx'), 'export function ChatPanel() { return null; }');
  await fs.writeFile(path.join(root, 'node_modules/pkg/index.js'), 'must never reach the prompt');

  // Loaded through a URL because tsx cannot statically resolve a sibling .cjs
  // module from TypeScript, and this test proves the Electron layer's listing
  // feeds the renderer's prompt builder.
  const workspaceModulePath = pathToFileURL(path.resolve(process.cwd(), 'electron/workspace.cjs')).href;
  const { createWorkspaceAccess } = (await import(workspaceModulePath)) as {
    createWorkspaceAccess: () => { openFolder: (root: string) => Promise<{ files: unknown[]; fileTree: WorkspaceFileEntry[] }> };
  };
  const opened = await createWorkspaceAccess().openFolder(root);
  assert.deepEqual(opened.files, [], 'the folder is still opened lazily — no eager bulk read');

  const tree = opened.fileTree as WorkspaceFileEntry[];
  const map = buildFileTreeMap(tree);
  assert.match(map, /src\/components\/ — ChatPanel\.tsx/);
  assert.match(map, /\(root\) — package\.json/);
  assert.doesNotMatch(map, /node_modules/, 'generated directories stay out of the prompt');

  const candidates = selectContextCandidates(tree, 'wire the credit meter into ChatPanel', {
    maxFiles: 3,
    maxBytesPerFile: 60_000
  });
  assert.ok(candidates.includes('src/components/ChatPanel.tsx'), JSON.stringify(candidates));
});

test('a folder workspace with no open tabs still yields workspace lines for the prompt', () => {
  const lines = describeWorkspaceForPrompt({
    name: 'lernexai-saas',
    path: 'C:/projects/lernexai-saas',
    inventory: syntheticTree(219),
    contentsIncluded: 0
  });
  assert.equal(lines.length, 2, 'a workspace line and a repo map, never an empty pair');
  assert.match(lines[0], /Workspace: lernexai-saas at C:\/projects\/lernexai-saas — 219 file\(s\)/);
  assert.match(lines[1], /^REPO MAP \(paths in this workspace\):\n219 file\(s\)/);
});

test('a folder with nothing in it says so instead of printing an empty map', () => {
  const lines = describeWorkspaceForPrompt({ name: 'empty', path: '/tmp/empty', inventory: [], contentsIncluded: 0 });
  assert.deepEqual(lines, ['Workspace: empty at /tmp/empty — 0 file(s), contents included for 0 of them (the open editor tabs plus the files most relevant to this request).']);
});

test('files created during the session are inventoried from their buffers', () => {
  const inventory = mergeInventory(
    [{ path: 'src/App.tsx', size: 500 }, { path: 'src/Deleted.tsx', size: 500 }],
    [{ name: 'src/App.tsx', content: 'export default 1;' }, { name: 'src/NewCard.tsx', content: 'export const a = 1;' }]
  );
  assert.deepEqual(
    inventory.map((entry) => entry.path),
    ['src/App.tsx', 'src/Deleted.tsx', 'src/NewCard.tsx'],
    'the stale listing is extended, never replaced'
  );
});
