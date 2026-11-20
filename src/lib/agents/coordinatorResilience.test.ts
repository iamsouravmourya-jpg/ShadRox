import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATOR_BACKOFF_BASE_MS,
  isRateLimitError,
  isRetryableCoordinatorError,
  parseRetryAfterMs,
  rateLimitPacingDelayMs,
  repairCoordinatorPlanJson,
  withCoordinatorBackoff
} from './coordinatorResilience';

test('withCoordinatorBackoff retries 429 rate limits with 2s -> 4s -> 8s exponential backoff + jitter', async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await withCoordinatorBackoff(
    async () => {
      calls += 1;
      if (calls <= 3) throw new Error('HTTP 429 Too Many Requests: Rate limit reached');
      return 'ok';
    },
    {
      rng: () => 0.5, // zero jitter delta -> exact base timings
      sleep: async (ms) => {
        delays.push(ms);
      }
    }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(delays, [...COORDINATOR_BACKOFF_BASE_MS]);
});

test('withCoordinatorBackoff fails immediately on permanent 401/403 auth errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withCoordinatorBackoff(
        async () => {
          calls += 1;
          throw new Error('401 Unauthorized: invalid api key');
        },
        { sleep: async () => undefined }
      ),
    /401 Unauthorized/
  );
  assert.equal(calls, 1);
});

test('withCoordinatorBackoff honors Retry-After hints and retries malformed result validations', async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await withCoordinatorBackoff(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('429 rate limit — Retry-After: 5 seconds');
      return calls === 2 ? 'not-json' : '[{"id":"t1"}]';
    },
    {
      rng: () => 0.5,
      validateResult: (text) => (text.startsWith('[') ? null : 'Invalid JSON output'),
      sleep: async (ms) => {
        delays.push(ms);
      }
    }
  );

  assert.equal(result, '[{"id":"t1"}]');
  assert.equal(delays[0], 5000);
  assert.equal(delays[1], 4000);
});

test('repairCoordinatorPlanJson recovers markdown-fenced, trailing-comma, and truncated JSON arrays', () => {
  const fenced = 'Here is the plan:\n```json\n[\n  {"id": "t1", "title": "API", "assignee": "backend",},\n]\n```';
  const r1 = repairCoordinatorPlanJson(fenced);
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(Array.isArray(r1.value), true);

  const truncated = '[{"id":"t1","title":"Route","assignee":"backend"},{"id":"t2","title":"partial';
  const r2 = repairCoordinatorPlanJson(truncated);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(Array.isArray(r2.value), true);
    assert.equal((r2.value as Array<{ id: string }>).length, 1);
  }
});

test('rateLimitPacingDelayMs paces free-tier and bursty providers sequentially', () => {
  assert.equal(rateLimitPacingDelayMs({ isFreeTier: true }), 1200);
  assert.equal(rateLimitPacingDelayMs({ provider: 'groq' }), 1200);
  assert.equal(rateLimitPacingDelayMs({ recentRateLimit: true, isFreeTier: false }), 3000);
  assert.equal(rateLimitPacingDelayMs({ provider: 'custom', isFreeTier: false }), 0);
  assert.equal(isRateLimitError('Quota exceeded (429)'), true);
  assert.equal(isRetryableCoordinatorError('403 forbidden'), false);
  assert.equal(parseRetryAfterMs('Please try again in 3.5s'), 3500);
});
