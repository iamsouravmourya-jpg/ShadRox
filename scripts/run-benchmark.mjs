import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// The benchmark is graded by the same code the tests use, so it runs through
// tsx rather than a build step: no bundling, no environment, no key.
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', path.join('src', 'lib', 'benchmark', 'cli.ts'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
