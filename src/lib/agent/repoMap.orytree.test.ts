/**
 * OryTree tests: feature-domain grouping, blast-radius (`[refs: N]`) badges,
 * the incremental content-hash cache, and downstream-dependent lookup. All
 * fixtures are passed as pre-read bytes, so no disk adapter runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOryTree,
  classifyOryDomain,
  clearRepoMapCache,
  dependentsFromGraph,
  extractFileTagsCached,
  renderOryTree,
  repoMapCacheSize
} from './repoMap';
import { type MapInputFile } from '../repoMap';

const FILES: MapInputFile[] = [
  { name: 'src/auth/login.ts', content: "import { getSession } from './session';\nexport function LoginForm() { return getSession(); }\n" },
  { name: 'src/auth/session.ts', content: 'export function getSession() { return 1; }\n' },
  { name: 'src/billing/checkout.ts', content: "import { apiClient } from '../api/client';\nexport function Checkout() { return apiClient(); }\n" },
  { name: 'src/api/client.ts', content: 'export function apiClient() { return 0; }\n' },
  { name: 'src/dashboard/overview.ts', content: "import { apiClient } from '../api/client';\nimport { getSession } from '../auth/session';\nexport function Overview() { apiClient(); return getSession(); }\n" },
  { name: 'src/shared/util.ts', content: 'export function clamp(value: number) { return value; }\n' },
  { name: 'src/settings/profile.ts', content: 'export function Profile() { return 1; }\n' }
];

test('classifyOryDomain maps paths and symbols to product domains', () => {
  assert.equal(classifyOryDomain('src/auth/login.ts', ['LoginForm']), 'AUTH');
  assert.equal(classifyOryDomain('src/billing/checkout.ts', ['Checkout']), 'BILLING');
  assert.equal(classifyOryDomain('src/api/client.ts', ['apiClient']), 'API');
  assert.equal(classifyOryDomain('src/dashboard/overview.ts', ['Overview']), 'DASHBOARD');
  assert.equal(classifyOryDomain('src/settings/profile.ts', ['Profile']), 'SETTINGS');
  assert.equal(classifyOryDomain('src/shared/util.ts', ['clamp']), 'SHARED');
  // A SHARED file that only references AUTH inherits AUTH from the import edge.
  assert.equal(classifyOryDomain('src/shared/helper.ts', ['helper'], ['AUTH', 'AUTH', 'SHARED']), 'AUTH');
});

test('buildOryTree groups files into the right domains', async () => {
  clearRepoMapCache();
  const tree = await buildOryTree('', { files: FILES });
  const domainOf = (rel: string): string | undefined =>
    tree.domains.find((domain) => domain.files.some((node) => node.relFname === rel))?.id;
  assert.equal(domainOf('src/auth/login.ts'), 'AUTH');
  assert.equal(domainOf('src/auth/session.ts'), 'AUTH');
  assert.equal(domainOf('src/billing/checkout.ts'), 'BILLING');
  assert.equal(domainOf('src/api/client.ts'), 'API');
  assert.equal(domainOf('src/dashboard/overview.ts'), 'DASHBOARD');
  assert.equal(domainOf('src/settings/profile.ts'), 'SETTINGS');
  assert.equal(domainOf('src/shared/util.ts'), 'SHARED');
  // Every file lands in exactly one domain.
  const assigned = tree.domains.reduce((sum, domain) => sum + domain.files.length, 0);
  assert.equal(assigned, FILES.length);
});

test('blast-radius badges count distinct referencers and render as [refs: N]', async () => {
  clearRepoMapCache();
  const tree = await buildOryTree('', { files: FILES });
  // apiClient is referenced by checkout.ts and overview.ts -> refs 2.
  assert.equal(tree.refCounts.get('src/api/client.ts'), 2);
  // getSession is referenced by login.ts and overview.ts -> refs 2.
  assert.equal(tree.refCounts.get('src/auth/session.ts'), 2);
  // A leaf nobody imports has no badge count.
  assert.equal(tree.refCounts.get('src/shared/util.ts') ?? 0, 0);

  const rendered = renderOryTree(tree, 4096);
  assert.match(rendered, /\[API \/ BACKEND\]/);
  assert.match(rendered, /client\.ts \[refs: 2\]/);
  assert.match(rendered, /apiClient/, 'top exported symbol is shown on the node');
});

test('renderOryTree honours the token budget and keeps the first domain', async () => {
  clearRepoMapCache();
  const tree = await buildOryTree('', { files: FILES });
  const full = renderOryTree(tree, 4096);
  const tiny = renderOryTree(tree, 8);
  assert.ok(tiny.length < full.length, 'a tighter budget renders less');
  assert.ok(tiny.length > 0, 'the first domain header always survives');
});

test('incremental cache reuses tags for unchanged files and refreshes changed ones', () => {
  clearRepoMapCache();
  const content = 'export function alpha() { return 1; }\n';
  const first = extractFileTagsCached('src/x.ts', content);
  const second = extractFileTagsCached('src/x.ts', content);
  assert.equal(first, second, 'an unchanged file returns the cached tags object (no re-tokenize)');
  assert.equal(repoMapCacheSize(), 1, 'one file is cached');
  const changed = extractFileTagsCached('src/x.ts', 'export function beta() { return 2; }\n');
  assert.notEqual(changed, first, 'changed bytes produce fresh tags');
  assert.ok(changed.defs.some((tag) => tag.name === 'beta'));
});

test('dependentsFromGraph lists exact downstream consumers of a shared file', async () => {
  clearRepoMapCache();
  const tree = await buildOryTree('', { files: FILES });
  const dependents = dependentsFromGraph(tree.graph, ['src/api/client.ts'], 10);
  const files = dependents.map((entry) => entry.file).sort();
  assert.deepEqual(files, ['src/billing/checkout.ts', 'src/dashboard/overview.ts']);
  // Each dependent used the apiClient symbol.
  assert.ok(dependents.every((entry) => entry.symbols.includes('apiClient')));
  // A file with no dependents returns nothing.
  assert.deepEqual(dependentsFromGraph(tree.graph, ['src/shared/util.ts'], 10), []);
});