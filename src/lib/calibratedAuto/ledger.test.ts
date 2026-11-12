import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listOutcomes, recordOutcome, routeIsProven, routeProfiles } from './ledger';
import { MIN_VERIFIED_RUNS } from './statistics';
import type { OutcomeRecord } from './types';

const KEY = 'shadrox.calibrated-auto.outcomes';

/**
 * The ledger reads `window.localStorage` directly, so the renderer global is
 * installed per test and removed afterwards — Node has neither.
 */
function withStorage(run: (values: Map<string, string>) => void): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        }
      }
    }
  });
  try {
    run(values);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

function record(overrides: Partial<Omit<OutcomeRecord, 'id' | 'createdAt'>> = {}): Omit<OutcomeRecord, 'id' | 'createdAt'> {
  return {
    taskType: 'chat',
    route: 'writer',
    model: 'google/gemini-2.5-flash-lite',
    passed: true,
    verified: true,
    reason: '2 file(s) saved, 3 check(s) ran',
    repairIterations: 0,
    inputTokens: 1000,
    outputTokens: 200,
    latencyMs: 4000,
    ...overrides
  };
}

describe('the outcome ledger', () => {
  it('writes a record and reads it back newest first', () => {
    withStorage(() => {
      const first = recordOutcome(record({ model: 'a/one' }));
      const second = recordOutcome(record({ model: 'a/two' }));
      const listed = listOutcomes();
      assert.equal(listed.length, 2);
      assert.ok(first.id !== second.id);
      assert.ok(listed[0].createdAt >= listed[1].createdAt);
      assert.equal(listed[0].reason, '2 file(s) saved, 3 check(s) ran');
    });
  });

  it('starts empty when there is no window at all', () => {
    assert.deepEqual(listOutcomes(), []);
  });

  it('survives a corrupted entry instead of poisoning every average', () => {
    withStorage((values) => {
      values.set(KEY, '{"not":"an array"}');
      assert.deepEqual(listOutcomes(), []);
      values.set(KEY, 'not json at all');
      assert.deepEqual(listOutcomes(), []);
    });
  });

  it('drops a record that cannot say what happened', () => {
    withStorage((values) => {
      values.set(KEY, JSON.stringify([
        { model: 'a/kept', route: 'writer', passed: true, verified: false, reason: 'ok' },
        { model: 'a/no-verdict', route: 'writer', reason: 'no passed/verified fields' },
        'a string',
        null
      ]));
      const listed = listOutcomes();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].model, 'a/kept');
      // Absent numbers are read as zero, never as NaN.
      assert.equal(listed[0].inputTokens, 0);
      assert.equal(listed[0].latencyMs, 0);
    });
  });

  it('gives an old record a reason that admits it has none', () => {
    withStorage((values) => {
      values.set(KEY, JSON.stringify([{ model: 'a/legacy', route: 'writer', passed: true, verified: true }]));
      assert.match(listOutcomes()[0].reason, /before outcomes carried a reason/);
    });
  });

  it('keeps an unknown task type out of every bucket rather than guessing', () => {
    withStorage((values) => {
      values.set(KEY, JSON.stringify([{ model: 'a/one', route: 'writer', passed: true, verified: true, taskType: 'welding' }]));
      assert.equal(listOutcomes()[0].taskType, 'chat');
    });
  });
});

describe('routeProfiles', () => {
  it('draws the rate from verified turns only', () => {
    withStorage(() => {
      recordOutcome(record({ route: 'writer', verified: true, passed: true }));
      recordOutcome(record({ route: 'writer', verified: true, passed: false }));
      // Two unchecked answers: they must not sit in the denominator.
      recordOutcome(record({ route: 'writer', verified: false, passed: true }));
      recordOutcome(record({ route: 'writer', verified: false, passed: true }));
      const writer = routeProfiles('chat').find((profile) => profile.route === 'writer');
      assert.equal(writer?.attempts, 4);
      assert.equal(writer?.verifiedAttempts, 2);
      assert.equal(writer?.unverifiedAttempts, 2);
    });
  });

  it('reports no rate and no score for a route nobody has verified', () => {
    withStorage(() => {
      recordOutcome(record({ route: 'frontier', verified: false }));
      const frontier = routeProfiles('chat').find((profile) => profile.route === 'frontier');
      assert.equal(frontier?.passRate, null);
      assert.equal(frontier?.score, null);
      assert.equal(routeIsProven(frontier), false);
    });
  });

  it('shrinks a tiny verified sample toward the pool instead of quoting it raw', () => {
    withStorage(() => {
      // The pool is every verified run on this task type, the reader's own
      // lucky run included: 7 passes over 11 runs.
      for (let index = 0; index < 10; index += 1) {
        recordOutcome(record({ route: 'writer', verified: true, passed: index < 6 }));
      }
      recordOutcome(record({ route: 'reader', verified: true, passed: true }));
      const reader = routeProfiles('chat').find((profile) => profile.route === 'reader');
      // (1 + (7/11)*3) / (1 + 3) = 0.7273 — the lucky single run is reported as
      // the pool's opinion plus a hint of its own, never as 100%.
      assert.ok(
        Math.abs((reader?.passRate ?? 0) - (1 + (7 / 11) * 3) / 4) < 1e-9,
        `expected ${(1 + (7 / 11) * 3) / 4}, got ${reader?.passRate}`
      );
      assert.equal(routeIsProven(reader), false);
    });
  });

  it('calls a route proven once it has the minimum verified runs', () => {
    withStorage(() => {
      for (let index = 0; index < MIN_VERIFIED_RUNS; index += 1) {
        recordOutcome(record({ route: 'writer', verified: true, passed: index < 4 }));
      }
      const writer = routeProfiles('chat').find((profile) => profile.route === 'writer');
      assert.equal(routeIsProven(writer), true);
      assert.ok(writer?.score !== null);
    });
  });

  it('averages cost and latency over every logged turn, checked or not', () => {
    withStorage(() => {
      recordOutcome(record({ route: 'writer', verified: true, latencyMs: 1000, inputTokens: 100, outputTokens: 100, repairIterations: 2 }));
      recordOutcome(record({ route: 'writer', verified: false, latencyMs: 3000, inputTokens: 300, outputTokens: 300, repairIterations: 4 }));
      const writer = routeProfiles('chat').find((profile) => profile.route === 'writer');
      assert.equal(writer?.averageLatencyMs, 2000);
      assert.equal(writer?.averageTokens, 400);
      assert.equal(writer?.averageRepairs, 3);
    });
  });

  it('filters by task type so a refactor record never speaks for chat', () => {
    withStorage(() => {
      recordOutcome(record({ taskType: 'refactor', route: 'writer', verified: true, passed: false }));
      recordOutcome(record({ taskType: 'chat', route: 'writer', verified: true, passed: true }));
      assert.equal(routeProfiles('refactor').find((profile) => profile.route === 'writer')?.verifiedAttempts, 1);
      assert.equal(routeProfiles('chat').find((profile) => profile.route === 'writer')?.verifiedAttempts, 1);
      assert.equal(routeProfiles().find((profile) => profile.route === 'writer')?.verifiedAttempts, 2);
    });
  });
});
