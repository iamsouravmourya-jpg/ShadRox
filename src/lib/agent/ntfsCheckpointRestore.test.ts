import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NTFS_RETRY_DELAYS_MS,
  evaluateZeroChangeRestore,
  extractFsErrorCode,
  withNtfsRetry
} from './ntfsCheckpointRestore';

test('withNtfsRetry retries transient EBUSY and EPERM/EACCES locks with exponential backoff and clears read-only attribute', async () => {
  let attempts = 0;
  let clearedPath: string | null = null;
  const delaysSeen: number[] = [];

  const result = await withNtfsRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      if (attempts === 2) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return 'unlocked';
    },
    {
      targetPath: 'C:\\Users\\Alice\\repo\\file.ts',
      clearReadOnly: async (target) => {
        clearedPath = target;
      },
      sleep: async (ms) => {
        delaysSeen.push(ms);
      }
    }
  );

  assert.equal(result, 'unlocked');
  assert.equal(attempts, 3);
  assert.equal(clearedPath, 'C:\\Users\\Alice\\repo\\file.ts');
  assert.deepEqual(delaysSeen, [NTFS_RETRY_DELAYS_MS[0], NTFS_RETRY_DELAYS_MS[1]]);
});

test('withNtfsRetry stops immediately on non-retryable errors like ENOENT or EXDEV', async () => {
  let attempts = 0;
  await assert.rejects(
    withNtfsRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      },
      { sleep: async () => {} }
    ),
    { code: 'EXDEV' }
  );
  assert.equal(attempts, 1);
  assert.equal(extractFsErrorCode(new Error('EBUSY while scanning')), 'EBUSY');
});

test('evaluateZeroChangeRestore returns a clean noop outcome for zero-change turns', () => {
  const noop = evaluateZeroChangeRestore({
    filesCount: 0,
    gitChanged: false,
    addedPreviewsCount: 0,
    omissionsCount: 0,
    canRestore: false,
    overlapped: false,
    alreadyRestored: false
  });
  assert.deepEqual(noop, {
    ok: true,
    status: 'noop',
    message: 'No file changes in this turn to undo.'
  });

  const nonZero = evaluateZeroChangeRestore({
    filesCount: 2,
    gitChanged: false,
    addedPreviewsCount: 0,
    omissionsCount: 0,
    canRestore: true,
    overlapped: false,
    alreadyRestored: false
  });
  assert.equal(nonZero, null);
});
