import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chooseCalibratedRoute, explainModelChoice, rankModels, rankModelsByOutcome } from './router';
import { recordOutcome } from './ledger';
import { MIN_VERIFIED_RUNS } from './statistics';
import type { CalibratedTaskType, OutcomeRecord } from './types';

const PIN_KEY = 'shadrox.calibrated-auto.preferences';
const OUTCOME_KEY = 'shadrox.calibrated-auto.outcomes';

function withStorage(seed: Record<string, unknown> = {}, run: () => void): void {
  const values = new Map<string, string>(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
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
    run();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

function outcome(model: string, overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    id: `outcome-${model}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: 1,
    taskType: 'chat',
    route: 'writer',
    model,
    passed: true,
    verified: true,
    reason: '2 file(s) saved',
    repairIterations: 0,
    inputTokens: 1000,
    outputTokens: 200,
    latencyMs: 4000,
    ...overrides
  };
}

/** `count` verified runs of which `passes` passed. */
function runs(model: string, count: number, passes: number, overrides: Partial<OutcomeRecord> = {}): OutcomeRecord[] {
  return Array.from({ length: count }, (_, index) => outcome(model, { ...overrides, passed: index < passes }));
}

function taskTypeList(): CalibratedTaskType[] {
  return ['chat', 'bugfix', 'refactor', 'feature', 'test'];
}

describe('rankModels', () => {
  it('puts a model with no verified history behind one with a thin record, and says price decides', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['a/never', 'a/thin'],
      outcomes: runs('a/thin', 2, 2),
      pinned: null
    });
    assert.deepEqual(ranked.map((entry) => entry.model), ['a/thin', 'a/never']);
    assert.match(ranked[1].reason, /no verified run yet, so price decides/);
    assert.equal(ranked[1].passRate, null);
  });

  it('refuses to let one lucky run outrank a proven model', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['a/lucky', 'a/proven'],
      outcomes: [...runs('a/lucky', 1, 1), ...runs('a/proven', MIN_VERIFIED_RUNS + 3, MIN_VERIFIED_RUNS)],
      pinned: null
    });
    assert.equal(ranked[0].model, 'a/proven');
    assert.equal(ranked[1].model, 'a/lucky');
    assert.equal(ranked[1].proven, false);
    assert.match(ranked[1].reason, new RegExp(`under the ${MIN_VERIFIED_RUNS} checked runs needed to lead the ranking`));
  });

  it('shrinks the rate toward the pool and prints both numbers', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['a/one'],
      outcomes: runs('a/one', 1, 1),
      pinned: null
    });
    // A pool of one is that model, so the shrunk estimate equals the observed
    // one here — the reason text still quotes the sample size out loud.
    assert.equal(ranked[0].passRate, 1);
    assert.match(ranked[0].reason, /1\/1 verified runs passed \(100%\)/);
  });

  it('keeps an unproven model honest about a pool it is being shrunk against', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['a/second', 'a/first'],
      outcomes: [...runs('a/first', 10, 5), ...runs('a/second', 1, 1)],
      pinned: null
    });
    const second = ranked.find((entry) => entry.model === 'a/second');
    // Pool prior (5 + 1) / (10 + 1) = 6/11: (1 + 6/11*3) / 4 = 0.659…
    assert.ok(second && second.passRate !== null);
    assert.ok(Math.abs((second.passRate ?? 0) - (1 + (6 / 11) * 3) / 4) < 1e-9);
    assert.match(second.reason, /shrunk to 66% against the pool's 55%/);
  });

  it('honours the pin above the record', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['a/best', 'a/pinned'],
      outcomes: [...runs('a/best', 20, 20), ...runs('a/pinned', 20, 1)],
      pinned: 'a/pinned'
    });
    assert.equal(ranked[0].model, 'a/pinned');
    assert.equal(ranked[0].pinned, true);
    assert.match(ranked[0].reason, /pinned by you for chat turns — your choice outranks the record/);
  });

  it('breaks a tie on repairs, then on the name, so the order never shuffles', () => {
    const ranked = rankModels({
      taskType: 'chat',
      models: ['z/same', 'a/same', 'b/noisy'],
      outcomes: [
        ...runs('a/same', 6, 6),
        ...runs('z/same', 6, 6),
        ...runs('b/noisy', 6, 6).map((record) => ({ ...record, repairIterations: 3 }))
      ],
      pinned: null
    });
    assert.deepEqual(ranked.map((entry) => entry.model), ['a/same', 'z/same', 'b/noisy']);
    assert.equal(ranked[2].averageRepairs, 3);
  });

  it('is deterministic for the same evidence', () => {
    const input = {
      taskType: 'chat' as const,
      models: ['m/c', 'm/a', 'm/b'],
      outcomes: [...runs('m/a', 1, 0), ...runs('m/b', 7, 6)],
      pinned: null
    };
    assert.deepEqual(rankModels(input).map((entry) => entry.model), rankModels(input).map((entry) => entry.model));
  });

  it('ignores a record from a different task type', () => {
    const ranked = rankModels({
      taskType: 'bugfix',
      models: ['m/only'],
      outcomes: runs('m/only', 9, 9, { taskType: 'chat' }),
      pinned: null
    });
    assert.equal(ranked[0].verifiedAttempts, 0);
    assert.equal(ranked[0].passRate, null);
  });

  it('counts a model’s verified reader passes in the same table as its writer turns', () => {
    // The picker pass writes route 'reader'; the ranking is per model, so a
    // cheap model that only ever selects files is still ranked on real work.
    const ranked = rankModels({
      taskType: 'chat',
      models: ['m/picker', 'm/writer'],
      outcomes: [
        ...runs('m/picker', MIN_VERIFIED_RUNS, MIN_VERIFIED_RUNS, { route: 'reader', reason: '6 of 40 candidate(s) named were real paths' }),
        ...runs('m/writer', MIN_VERIFIED_RUNS, MIN_VERIFIED_RUNS - 1)
      ],
      pinned: null
    });
    assert.equal(ranked[0].model, 'm/picker');
    assert.equal(ranked[0].proven, true);
    assert.match(ranked[0].reason, /5\/5 verified runs passed \(100%\)/);
  });

  it('reads the pin and the ledger from storage when the caller supplies neither', () => {
    withStorage({ [PIN_KEY]: { chat: 'm/pinned' }, [OUTCOME_KEY]: runs('m/pinned', 1, 0) }, () => {
      const ranked = rankModels({ taskType: 'chat', models: ['m/other', 'm/pinned'] });
      assert.equal(ranked[0].model, 'm/pinned');
      assert.equal(ranked[0].verifiedAttempts, 1);
    });
  });

  it('drops an empty model id without dropping the list', () => {
    const ranked = rankModels({ taskType: 'chat', models: ['', 'm/real'], pinned: null });
    assert.deepEqual(ranked.map((entry) => entry.model), ['m/real']);
  });

  it('gives every rank a number a panel can render', () => {
    const ranked = rankModels({ taskType: 'chat', models: ['m/a', 'm/b'], pinned: null });
    assert.deepEqual(ranked.map((entry) => entry.rank), [0, 1]);
  });
});

describe('rankModelsByOutcome', () => {
  it('is the ordering the router takes as its preference list', () => {
    withStorage({ [OUTCOME_KEY]: [...runs('m/winner', 8, 8), ...runs('m/loser', 8, 1)] }, () => {
      assert.deepEqual(rankModelsByOutcome('chat', ['m/loser', 'm/winner']), ['m/winner', 'm/loser']);
    });
  });

  it('leaves a ledger with no verified run in the caller’s own order', () => {
    withStorage({}, () => {
      assert.deepEqual(rankModelsByOutcome('test', ['m/z', 'm/a']), ['m/z', 'm/a']);
    });
  });
});

describe('explainModelChoice', () => {
  it('answers for the model actually used', () => {
    const explanation = explainModelChoice(
      { taskType: 'refactor', models: ['m/a', 'm/b'], outcomes: runs('m/b', 6, 5, { taskType: 'refactor' }), pinned: null },
      'm/b'
    );
    assert.match(explanation, /^m\/b: 5\/6 verified runs passed/);
  });

  it('says so when the model is not on the key', () => {
    assert.match(explainModelChoice({ taskType: 'chat', models: ['m/a'], pinned: null }, 'm/absent'), /not among the models offered/);
  });

  it('does not invent a reason for no model', () => {
    assert.match(explainModelChoice({ taskType: 'chat', models: [], pinned: null }, ''), /no model was chosen/);
  });
});

describe('chooseCalibratedRoute', () => {
  it('leaves the default route standing until something has been verified', () => {
    withStorage({ [OUTCOME_KEY]: runs('m/a', 3, 3, { route: 'frontier', verified: false }) }, () => {
      const choice = chooseCalibratedRoute('chat');
      assert.equal(choice.route, 'writer');
      assert.match(choice.reason, /no chat run has been verified on writer yet/);
    });
  });

  it('takes the route the verified evidence favours', () => {
    withStorage({
      [OUTCOME_KEY]: [
        ...runs('m/a', 8, 8, { route: 'writer' }),
        ...runs('m/b', 8, 1, { route: 'frontier' })
      ]
    }, () => {
      const choice = chooseCalibratedRoute('chat', ['writer', 'frontier']);
      assert.equal(choice.route, 'writer');
      // Pool 9/16, so writer's 8/8 is quoted at 88% — the verified count is
      // stated next to it, which is what the line is for.
      assert.match(choice.reason, /8 verified chat run\(s\) at 88% after shrinking, 0\.0 average repairs/);
    });
  });

  it('will not rank a route that only has unchecked turns', () => {
    withStorage({ [OUTCOME_KEY]: [...runs('m/a', 6, 6, { route: 'reader', verified: false }), ...runs('m/b', 6, 3, { route: 'writer' })] }, () => {
      const choice = chooseCalibratedRoute('bugfix', ['reader', 'writer']);
      // reader has six turns logged and nothing checked; writer has real data.
      assert.equal(choice.route, 'writer');
    });
  });

  it('quotes the sample it shrank, not the raw rate', () => {
    withStorage({ [OUTCOME_KEY]: runs('m/a', 6, 6, { route: 'writer' }) }, () => {
      const choice = chooseCalibratedRoute('chat');
      // Pool prior 1.0 with one route, so 100% — the point of the line is that
      // the verified count is stated next to it.
      assert.match(choice.reason, /^6 verified chat run\(s\) at 100% after shrinking, 0\.0 average repairs/);
    });
  });

  it('covers every task type the ledger writes', () => {
    withStorage({ [OUTCOME_KEY]: runs('m/a', 2, 2, { route: 'writer' }) }, () => {
      for (const taskType of taskTypeList()) {
        assert.equal(chooseCalibratedRoute(taskType).route, 'writer');
      }
    });
  });
});
