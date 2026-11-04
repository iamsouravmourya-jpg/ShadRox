/**
 * Tests for the aider-style ranked repo map. The fixtures are real mini
 * projects on disk (temp dirs), so the graph ranking must earn its keep:
 * the hub file only wins if the identifier edges point at it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildRepoMap,
  estimateTokens,
  filterImportantFiles,
  isDemotedFile,
  pageRank,
  type RepoMapOptions
} from './repoMap';
import { type MapInputFile, type MapTreeEntry } from '../repoMap';

// ---------------------------------------------------------------------------
// Fixture: one hub, three leaves, a loner, a test file re-declaring the hub's
// names, and a README. Only the hub is referenced by others.
// ---------------------------------------------------------------------------

const CORE_TS = [
  "import { clamp } from './util';",
  'export function createScheduler(limit: number) {',
  '  return { tick: clamp(limit) };',
  '}',
  'export function dispatchTask(task: string, scheduler: object) {',
  '  return scheduler;',
  '}',
  'function internalSpin() {',
  '  return 0;',
  '}'
].join('\n');

const UTIL_TS = 'export function clamp(value: number) {\n  return Math.min(value, 100);\n}\n';

const leaf = (name: string): string => [
  `import { createScheduler, dispatchTask } from './core';`,
  `export function run${name}() {`,
  `  const scheduler = createScheduler(4);`,
  `  return dispatchTask('${name}', scheduler);`,
  `}`
].join('\n');

const SOLO_TS = 'export function standAloneWidget() {\n  return 1;\n}\n';

// Defines the hub's own names so the demotion must break the (otherwise exact) tie.
const CORE_TEST_TS = [
  "import { createScheduler } from './core';",
  'export function createScheduler() {',
  '  return createSchedulerReal();',
  '}',
  'function createSchedulerReal() {',
  '  return null;',
  '}'
].join('\n');

const README_MD = '# demo\n\nThis project schedules tasks with a small core.\n';

const FIXTURE: Record<string, string> = {
  'src/core.ts': CORE_TS,
  'src/util.ts': UTIL_TS,
  'src/runA.ts': leaf('A'),
  'src/runB.ts': leaf('B'),
  'src/runC.ts': leaf('C'),
  'src/solo.ts': SOLO_TS,
  'src/core.test.ts': CORE_TEST_TS,
  'README.md': README_MD
};

async function writeFixture(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'repomap-fixture-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const target = path.join(root, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }
  return root;
}

async function listTree(root: string): Promise<MapTreeEntry[]> {
  const entries: MapTreeEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) await walk(abs);
      else entries.push({ path: path.relative(root, abs).replace(/\\/g, '/'), size: (await fsp.stat(abs)).size });
    }
  };
  await walk(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const inputFiles = (): MapInputFile[] =>
  Object.entries(FIXTURE).map(([name, content]) => ({ name, content }));

const diskMap = async (root: string, opts: RepoMapOptions = {}): Promise<string> =>
  buildRepoMap(root, {
    ...opts,
    listFiles: () => listTree(root),
    readFile: (rel) => fsp.readFile(path.join(root, rel), 'utf8').catch(() => null)
  });

const posOf = (text: string, needle: string): number => text.indexOf(needle);

// ---------------------------------------------------------------------------

test('graph ranking puts the hub over its leaves, with snippets read from disk', async () => {
  const root = await writeFixture();
  // Zero open tabs: the map is the whole context, and every shown line is disk bytes.
  const map = await diskMap(root, { tokenBudget: 4096 });

  const hub = posOf(map, 'src/core.ts:');
  assert.ok(hub >= 0, `hub missing from:\n${map}`);
  for (const leafName of ['src/runA.ts', 'src/runB.ts', 'src/runC.ts']) {
    const at = posOf(map, `${leafName}:`);
    assert.ok(at > hub, `${leafName} should rank below the hub`);
  }
  assert.ok(map.includes('export function createScheduler(limit: number) {'), 'the hub snippet is real file text');
  assert.ok(hub < posOf(map, 'src/solo.ts'), 'an unreferenced loner ranks below the hub');
});

test('aider behavior: files already in the chat are excluded from the map', async () => {
  const root = await writeFixture();
  const map = await diskMap(root, { tokenBudget: 2048, openTabs: ['src/core.ts', `${root}/src/util.ts`] });
  assert.ok(!map.includes('src/core.ts'), 'chat file appears nowhere, not even as a bare path');
  assert.ok(!map.includes('src/util.ts'), 'absolute tab paths normalize to the same file');
  assert.ok(map.includes('src/runA.ts'), 'the rest of the repo still maps');
});

test('token budget packs the ranked tags and truncates the tail', async () => {
  const files = inputFiles();
  const big = await buildRepoMap('/fixture-root', { files, tokenBudget: 4096 });
  const small = await buildRepoMap('/fixture-root', { files, tokenBudget: 48 });

  assert.ok(small.length < big.length, 'a smaller budget renders less');
  assert.ok(estimateTokens(small) <= estimateTokens(big), 'estimate is monotone in the budget');
  // The budget cut drops the tail of the ranking, never the top: the hub survives truncation.
  assert.ok(small.includes('src/core.ts:'), 'top-ranked hub stays when the budget is tight');
  assert.ok(big.includes('src/solo.ts'), 'loners show up only while there is room');
  assert.ok(!small.includes('src/solo.ts'), 'the ranked tail is what the cut removes');
});

test('demotion: a test file re-declaring the hub name ranks below the real hub', async () => {
  const files = inputFiles();
  const map = await buildRepoMap('/fixture-root', { files, tokenBudget: 4096 });
  assert.ok(posOf(map, 'src/core.ts:') < posOf(map, 'src/core.test.ts:'), 'aider common-file demotion transfers');
  assert.ok(isDemotedFile('src/core.test.ts') && isDemotedFile('README.md') && !isDemotedFile('src/core.ts'));
});

test('mentioned identifiers boost their edges, like aider mentioned_idents', async () => {
  const rival = 'export function renderDashboard(limit: number) {\n  return limit;\n}\n';
  const other = 'export function exportPreview(limit: number) {\n  return limit;\n}\n';
  const caller = [
    "import { renderDashboard } from './rival';",
    "import { exportPreview } from './other';",
    'export function boot() {',
    '  renderDashboard(1);',
    '  return exportPreview(2);',
    '}'
  ].join('\n');
  const files: MapInputFile[] = [
    { name: 'src/rival.ts', content: rival },
    { name: 'src/other.ts', content: other },
    { name: 'src/boot.ts', content: caller }
  ];
  const without = await buildRepoMap('/root', { files, tokenBudget: 512 });
  const withMention = await buildRepoMap('/root', { files, tokenBudget: 512, mentionedIdents: ['exportPreview'] });

  assert.ok(posOf(without, 'src/rival.ts:') < posOf(without, 'src/other.ts:'), 'long camel names tie-break by path');
  assert.ok(posOf(withMention, 'src/other.ts:') < posOf(withMention, 'src/rival.ts:'), 'the mentioned ident wins the slot');
});

test('important files earn a bare path line at the top', async () => {
  const files: MapInputFile[] = [
    { name: 'src/core.ts', content: CORE_TS },
    { name: 'src/runA.ts', content: leaf('A') },
    { name: 'README.md', content: README_MD }
  ];
  const map = await buildRepoMap('/root', { files, tokenBudget: 1024 });
  assert.equal(map.split('\n')[0], 'README.md', 'aider prepends special_fnames');
  assert.ok(filterImportantFiles(['README.md', 'src/core.ts', 'Dockerfile']).join(',') === 'README.md,Dockerfile');
});

test('aider behavior: an empty graph still renders the bare path inventory', async () => {
  const files: MapInputFile[] = [
    { name: 'data/notes.txt', content: 'plain prose, no symbols at all here\n' },
    { name: 'data/items.txt', content: 'more prose without any identifiers that rank\n' }
  ];
  const map = await buildRepoMap('/root', { files, tokenBudget: 256 });
  assert.ok(map.includes('data/notes.txt'), 'files with no graph earn a name-only entry, not silence');
  assert.ok(map.includes('data/items.txt'));
  assert.ok(!map.includes('plain prose'), 'name-only entries carry the path, not the bytes');
});

test('a file the user mentions earns its slot back under a tight budget', async () => {
  const files = inputFiles();
  const without = await buildRepoMap('/fixture-root', { files, tokenBudget: 48 });
  const withMention = await buildRepoMap('/fixture-root', {
    files,
    tokenBudget: 48,
    query: 'what does solo.ts export?'
  });
  assert.ok(!without.includes('src/solo.ts'), 'unmentioned, the loner is cut by the budget');
  assert.ok(withMention.includes('src/solo.ts'), 'aider personalizes toward cited files');
});

test('page_rank port: damping 0.85, normalized mass, hubs accumulate', () => {
  const rank = pageRank(
    ['a', 'b', 'c'],
    [
      { src: 'a', dst: 'b', ident: 'x', weight: 1 },
      { src: 'c', dst: 'b', ident: 'x', weight: 1 }
    ]
  );
  assert.ok(rank.get('b')! > rank.get('a')!, 'the referenced node accumulates');
  assert.ok(rank.get('b')! > rank.get('c')!);
  let sum = 0;
  for (const value of rank.values()) sum += value;
  assert.ok(Math.abs(sum - 1) < 1e-6, 'rank mass is conserved (normalized)');

  const uniform = pageRank(['a', 'b'], []);
  assert.ok(Math.abs((uniform.get('a') ?? 0) - 0.5) < 1e-9, 'an edgeless graph falls back to the uniform prior');

  const pinned = pageRank(
    ['a', 'b', 'c'],
    [
      { src: 'a', dst: 'b', ident: 'x', weight: 1 },
      { src: 'b', dst: 'c', ident: 'x', weight: 1 },
      { src: 'c', dst: 'a', ident: 'x', weight: 1 }
    ],
    new Map([['c', 100]])
  );
  assert.ok((pinned.get('c') ?? 0) > (pinned.get('a') ?? 0), 'personalization pulls toward the pinned node');
});
