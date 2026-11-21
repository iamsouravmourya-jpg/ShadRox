'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanJunk, classifyUnusedConfidence } = require('./junk-scanner.cjs');

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-junk-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? '', 'utf8');
  }
  return root;
}

test('preserves serverless, edge, worker, prisma, drizzle, and script entry points plus their imports', async () => {
  const root = makeWorkspace({
    'src/main.ts': "import './app';\n",
    'src/app.ts': 'export const ok = true;\n',
    'supabase/functions/webhook/index.ts': "import { verifySig } from '../_shared/sig.ts';\nexport default verifySig;\n",
    'supabase/functions/_shared/sig.ts': 'export function verifySig() { return true; }\n',
    'netlify/functions/hello.ts': "import { fmt } from '../../src/utils/fmt';\nexport const handler = fmt;\n",
    'functions/edge.js': 'export default () => {};\n',
    'workers/sync.worker.ts': "import { step } from './helper';\nexport { step };\n",
    'workers/helper.ts': 'export const step = 1;\n',
    'src/search.worker.ts': 'self.onmessage = () => {};\n',
    'service-worker.js': 'self.addEventListener("install", () => {});\n',
    'scripts/seed.mjs': 'console.log("seed");\n',
    'prisma/seed.ts': 'export const seed = 1;\n',
    'drizzle/0000_init.sql': 'CREATE TABLE t (id INT);\n',
    'src/utils/fmt.ts': 'export const fmt = () => "ok";\n',
    'src/dead/orphan.ts': 'export const dead = true;\n',
    'docs/old-notes.md': '# Old notes\n'
  });

  const result = await scanJunk(root);
  const unusedPaths = result.unusedFiles.map((f) => f.path).sort();

  assert.deepEqual(unusedPaths, ['docs/old-notes.md', 'src/dead/orphan.ts']);
  assert.deepEqual(result.deadFolders, ['src/dead', 'docs']);

  const orphan = result.unusedFiles.find((f) => f.path === 'src/dead/orphan.ts');
  const notes = result.unusedFiles.find((f) => f.path === 'docs/old-notes.md');
  assert.equal(orphan.confidence, 'high');
  assert.equal(notes.confidence, 'review');
  assert.equal(result.stats.highConfidenceCount, 1);
  assert.equal(result.stats.reviewCount, 1);
});

test('marks dynamically string-referenced assets and folders as reachable', async () => {
  const root = makeWorkspace({
    'src/main.tsx': "export const logo = '/assets/brand.png'; export const badge = './icons/check.svg';\n",
    'src/icons/check.svg': '<svg></svg>',
    'assets/brand.png': 'PNGDATA',
    'assets/unused-banner.png': 'OLD'
  });

  const result = await scanJunk(root);
  const unusedPaths = result.unusedFiles.map((f) => f.path);

  assert.ok(!unusedPaths.includes('assets/brand.png'), 'leading-slash root asset is preserved');
  assert.ok(!unusedPaths.includes('src/icons/check.svg'), 'relative string asset is preserved');
  assert.ok(unusedPaths.includes('assets/unused-banner.png'));
  assert.ok(!result.deadFolders.includes('assets'), 'assets folder is alive because brand.png is referenced');
  assert.equal(classifyUnusedConfidence('assets/unused-banner.png'), 'review');
});
