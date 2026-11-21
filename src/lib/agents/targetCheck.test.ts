import assert from 'node:assert/strict';
import test from 'node:test';

import { findMissingExplicitTargets, findMissingTaskTargets } from './targetCheck';
import type { TeamTask } from './types';

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    title: 'Fix auth handler',
    instruction: 'Fix token validation in src/auth/missing.ts',
    expectedFiles: ['src/auth/missing.ts'],
    dependsOn: [],
    assignee: 'backend',
    status: 'pending',
    attempts: 0,
    lastReport: null,
    report: '',
    patchesApplied: 0,
    patchFailures: [],
    ...overrides
  };
}

test('flags missing existing target files when user asks to modify or fix them', () => {
  const missing = findMissingExplicitTargets(
    'Refactor error handling in src/api/nonexistent.ts and update src/routes/present.ts',
    ['src/routes/present.ts', 'package.json'],
    false
  );
  assert.deepEqual(missing, ['src/api/nonexistent.ts']);
});

test('allows creating a brand-new file path explicitly requested with creation intent', () => {
  const missing = findMissingExplicitTargets(
    'Create new file src/utils/rateLimiter.ts with a token bucket',
    ['src/index.ts'],
    false
  );
  assert.deepEqual(missing, []);
});

test('handles Windows case-insensitive existing target paths cleanly', () => {
  const missing = findMissingExplicitTargets(
    'Fix bug in src/Components/Header.tsx',
    ['src/components/header.tsx'],
    true
  );
  assert.deepEqual(missing, []);
});

test('findMissingTaskTargets ignores files created by upstream dependencies', () => {
  const creator = makeTask({
    id: 't0',
    title: 'Create service',
    instruction: 'Create new file src/auth/session.ts',
    expectedFiles: ['src/auth/session.ts']
  });
  const dependent = makeTask({
    id: 't1',
    instruction: 'Update src/auth/session.ts with expiry checks',
    dependsOn: ['t0']
  });
  const missing = findMissingTaskTargets([creator, dependent], ['src/index.ts'], false);
  assert.deepEqual(missing, []);

  const orphanTask = makeTask({
    id: 't2',
    instruction: 'Update src/auth/missing.ts with expiry checks',
    dependsOn: []
  });
  const flagged = findMissingTaskTargets([creator, orphanTask], ['src/index.ts'], false);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].path, 'src/auth/missing.ts');
});
