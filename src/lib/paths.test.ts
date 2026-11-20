import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalPathKey,
  dedupePaths,
  findPathIndex,
  hasTrackedPath,
  mergeTrackedPaths,
  normalizeRepoPath,
  pathsEqual,
  resolveCanonicalPath
} from './paths';

test('normalizeRepoPath standardizes slashes and removes leading ./', () => {
  assert.equal(normalizeRepoPath('.\\src\\\\utils\\rateLimiter.ts'), 'src/utils/rateLimiter.ts');
  assert.equal(normalizeRepoPath('./src/a.ts'), 'src/a.ts');
});

test('dedupePaths collapses Windows case-only duplicates while preserving first disk casing', () => {
  const result = dedupePaths(
    ['src/utils/rateLimiter.ts', 'src\\utils\\ratelimiter.ts', './src/Utils/RateLimiter.ts', 'src/index.ts'],
    true
  );
  assert.deepEqual(result, ['src/utils/rateLimiter.ts', 'src/index.ts']);
});

test('dedupePaths keeps distinct-cased paths when case-sensitive', () => {
  const result = dedupePaths(['src/utils/rateLimiter.ts', 'src/utils/ratelimiter.ts'], false);
  assert.deepEqual(result, ['src/utils/rateLimiter.ts', 'src/utils/ratelimiter.ts']);
});

test('resolveCanonicalPath and mergeTrackedPaths preserve existing casing across retries', () => {
  const existing = ['src/utils/rateLimiter.ts', 'src/routes/auth.ts'];
  assert.equal(resolveCanonicalPath('src/utils/ratelimiter.ts', existing, true), 'src/utils/rateLimiter.ts');
  assert.equal(resolveCanonicalPath('src/routes/users.ts', existing, true), 'src/routes/users.ts');

  const merged = mergeTrackedPaths(existing, ['src\\utils\\RATELIMITER.ts', 'src/routes/users.ts'], true);
  assert.deepEqual(merged, ['src/utils/rateLimiter.ts', 'src/routes/auth.ts', 'src/routes/users.ts']);
});

test('findPathIndex, hasTrackedPath, pathsEqual, and canonicalPathKey match cleanly', () => {
  const list = ['src/utils/rateLimiter.ts', 'README.md'];
  assert.equal(findPathIndex(list, 'SRC\\UTILS\\ratelimiter.ts', true), 0);
  assert.equal(hasTrackedPath(list, 'src/utils/ratelimiter.ts', true), true);
  assert.equal(hasTrackedPath(list, 'src/other.ts', true), false);
  assert.equal(pathsEqual('./src/a.ts', 'src\\A.ts', true), true);
  assert.equal(canonicalPathKey('src\\A.ts', true), 'src/a.ts');
  assert.equal(canonicalPathKey('src\\A.ts', false), 'src/A.ts');
});
