import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'dist_staging', 'out', 'reference', 'vibe_images', 'landing']);
const TEST_FILE = /\.test\.(ts|cts|mts|cjs|mjs)$/;

const files = [];
for (const dir of ['src', 'electron', 'api']) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) continue;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (TEST_FILE.test(entry.name)) {
        files.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(base);
}

files.sort();
if (files.length === 0) {
  console.error('run-tests: no test files discovered under src/, electron/, api/');
  process.exit(1);
}

console.log(`run-tests: ${files.length} test files`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
