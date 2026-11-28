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
  hydrateFileTagsCache,
  hydrateFileTagsFromJson,
  LARGE_REPO_THRESHOLD,
  persistFileTagsCache,
  renderOryTree,
  repoMapCacheSize,
  serializeFileTagsCache
} from './repoMap';
import { hashContent } from '../agents/targetLock';
import { type MapInputFile } from '../repoMap';
import type { ShadRoxDesktopAPI } from '../desktop';

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

test('buildOryTree prioritizes src/server code over 1,500+ asset files and surfaces Python/Go/Prisma domains cleanly', async () => {
  clearRepoMapCache();
  const assets: MapInputFile[] = Array.from({ length: 1520 }, (_, i) => ({
    name: `assets/item-${String(i).padStart(4, '0')}.ts`,
    content: `const item${i} = ${i};\n`
  }));
  const core: MapInputFile[] = [
    { name: 'src/core/engine.py', content: 'def compute_score(n):\n    return n * 2\n\ndef _private_helper():\n    return 0\n' },
    { name: 'server/routers/health.go', content: 'func CheckHealth() bool {\n  return true\n}\nfunc internalPing() {}\n' },
    { name: 'prisma/schema.ts', content: 'export const usersModel = "users";\n' }
  ];
  const tree = await buildOryTree('', { files: [...assets, ...core] });
  const allPaths = tree.domains.flatMap((d) => d.files.map((f) => f.relFname));
  assert.ok(allPaths.includes('src/core/engine.py'), 'src file must survive 1,500 node cap ahead of assets/');
  assert.ok(allPaths.includes('server/routers/health.go'), 'server file must survive 1,500 node cap ahead of assets/');

  const pyNode = tree.domains.flatMap((d) => d.files).find((f) => f.relFname === 'src/core/engine.py');
  assert.ok(pyNode?.symbols.includes('compute_score'));
  assert.ok(!pyNode?.symbols.includes('_private_helper'));

  const goNode = tree.domains.flatMap((d) => d.files).find((f) => f.relFname === 'server/routers/health.go');
  assert.ok(goNode?.symbols.includes('CheckHealth'));
  assert.ok(!goNode?.symbols.includes('internalPing'));

  assert.equal(classifyOryDomain('prisma/schema.ts', ['usersModel']), 'API');
});

test('classifyOryDomain uses shared concept-synonym graph for hidden filenames', () => {
  assert.equal(classifyOryDomain('src/middleware/session_gatekeeper.ts', ['verifyCredentialGuard']), 'AUTH');
  assert.equal(classifyOryDomain('src/webhooks/razorpay_webhook.ts', ['handleInvoiceEvent']), 'BILLING');
  assert.equal(classifyOryDomain('src/data/drizzle_repository.ts', ['queryUsersTable']), 'API');
});

test('enterprise scale guard (>3,000 files) switches to Active-Package + Priority-Root mode with directory summary', async () => {
  clearRepoMapCache();
  assert.equal(LARGE_REPO_THRESHOLD, 3_000);

  const synthetic: MapInputFile[] = [];
  for (let i = 0; i < 2_600; i += 1) {
    synthetic.push({ name: `packages/legacy/mod_${String(i).padStart(4, '0')}.ts`, content: `export const legacy${i} = ${i};\n` });
  }
  for (let i = 0; i < 2_500; i += 1) {
    synthetic.push({ name: `services/analytics/job_${String(i).padStart(4, '0')}.ts`, content: `export const job${i} = ${i};\n` });
  }
  synthetic.push(
    {
      name: 'packages/checkout/src/cart.ts',
      content: "import { computeTax } from './pricing';\nexport function checkoutCart() { return computeTax(); }\n"
    },
    {
      name: 'packages/checkout/src/pricing.ts',
      content: 'export function computeTax() { return 10; }\n'
    },
    {
      name: 'src/auth/session.ts',
      content: 'export function activeSession() { return true; }\n'
    }
  );

  const tree = await buildOryTree('', {
    files: synthetic,
    activeFile: 'packages/checkout/src/cart.ts',
    totalFileCount: 50_000
  });

  assert.equal(tree.enterpriseMode, true);
  assert.equal(tree.totalWorkspaceFiles, 50_000);
  assert.ok(tree.fileCount <= 1_500, `scoped deep index must cap at 1,500 files, got ${tree.fileCount}`);
  assert.ok(tree.directoryIndex && tree.directoryIndex.length >= 3);
  assert.equal(tree.directoryIndex[0].dir, 'packages/legacy/');
  assert.equal(tree.directoryIndex[0].fileCount, 2_600);

  const indexedPaths = tree.domains.flatMap((d) => d.files.map((f) => f.relFname));
  assert.ok(indexedPaths.includes('packages/checkout/src/cart.ts'));
  assert.ok(indexedPaths.includes('packages/checkout/src/pricing.ts'));
  assert.ok(indexedPaths.includes('src/auth/session.ts'));

  const rendered = renderOryTree(tree, 2_048);
  assert.match(rendered, /\[ENTERPRISE REPO MODE:/);
  assert.match(rendered, /50000/);

  // Also verify disk-adapter path never calls readFile for all 5,000+ entries.
  let diskReads = 0;
  const listEntries = synthetic.map((f) => ({ path: f.name, size: f.content.length }));
  const contentByPath = new Map(synthetic.map((f) => [f.name, f.content]));
  const diskTree = await buildOryTree('', {
    activeFile: 'packages/checkout/src/cart.ts',
    listFiles: async () => listEntries,
    readFile: async (rel) => {
      diskReads += 1;
      return contentByPath.get(rel) ?? null;
    }
  });
  assert.equal(diskTree.enterpriseMode, true);
  assert.ok(diskReads <= 1_500, `enterprise readFile must stay <= 1,500 reads, got ${diskReads}`);
});

test('FileTags cache persists beyond 1.5MB via workspace cache and validates FNV-1a file hashes on hydrate', async () => {
  clearRepoMapCache();
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const diskCache = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    shadroxDesktop: {
      readWorkspaceCache: async (id: string, key: string) => diskCache.get(`${id}:${key}`) ?? null,
      writeWorkspaceCache: async (id: string, key: string, data: string) => {
        diskCache.set(`${id}:${key}`, data);
        return true;
      }
    } as unknown as ShadRoxDesktopAPI
  };

  try {
    const expectedHashes = new Map<string, string>();
    // Populate >1.5MB serialized FileTags cache across 2,500 entries (12 functions each).
    for (let i = 0; i < 2_500; i += 1) {
      const rel = `src/enterprise/module_${String(i).padStart(4, '0')}.ts`;
      const lines = Array.from(
        { length: 12 },
        (_, k) => `export function enterpriseHandler_${i}_${k}(arg_${k}: number) { return arg_${k} + refTarget_${i}_${k}; }`
      );
      const body = `${lines.join('\n')}\n`;
      extractFileTagsCached(rel, body);
      expectedHashes.set(rel, hashContent(body));
    }
    const serialized = serializeFileTagsCache();
    assert.ok(serialized.length > 1_500_000, `expected >1.5MB snapshot, got ${serialized.length}`);

    await persistFileTagsCache('ws-tags-big');
    assert.ok((diskCache.get('ws-tags-big:ory-tags')?.length ?? 0) > 1_500_000);

    // Mutate one file hash so hydrate rejects that stale entry while restoring the rest.
    expectedHashes.set('src/enterprise/module_0000.ts', '00000000');
    clearRepoMapCache();
    assert.equal(repoMapCacheSize(), 0);

    const restored = await hydrateFileTagsCache('ws-tags-big', expectedHashes);
    assert.equal(restored, 2_499, 'stale FNV-1a hash must be skipped while valid entries restore');
    assert.equal(repoMapCacheSize(), 2_499);
    assert.equal(hydrateFileTagsFromJson('not json'), 0);
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
  }
});