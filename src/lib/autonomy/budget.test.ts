import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ceilingReached,
  toolCallsReported,
  workUsageOf
} from './budget';
import { DEFAULT_MAX_TOOL_ROUNDS, MAX_CALLS_PER_ROUND } from '../agent/toolLoop';
import { DEFAULT_RUN_BUDGET, type RunBudget } from './types';

const CEILINGS: RunBudget = { ...DEFAULT_RUN_BUDGET };
const FRESH = { turns: 0, toolCalls: 0, elapsedMs: 0 };

test('the default tool-call ceiling survives four full tool-heavy turns', () => {
  // The loop runs DEFAULT_MAX_TOOL_ROUNDS rounds of up to MAX_CALLS_PER_ROUND
  // calls; the run cap must still afford four such turns, as it did when the
  // loop was smaller. 60 rounds x 16 calls = 960 per turn, four turns = 3840.
  assert.equal(DEFAULT_RUN_BUDGET.maxToolCalls, 3840);
  assert.ok(
    DEFAULT_RUN_BUDGET.maxToolCalls >= 4 * DEFAULT_MAX_TOOL_ROUNDS * MAX_CALLS_PER_ROUND,
    'two tool-heavy turns must not exhaust the run cap'
  );
  assert.equal(DEFAULT_RUN_BUDGET.maxTurns, 24);
  assert.equal(DEFAULT_RUN_BUDGET.maxAttemptsPerMilestone, 3);
  assert.equal(DEFAULT_RUN_BUDGET.maxMilestones, 8);
  assert.equal(DEFAULT_RUN_BUDGET.maxWallClockMs, 20 * 60 * 1000);
});

test('a run that has used none of its ceilings is free to take another turn', () => {
  assert.equal(ceilingReached(CEILINGS, FRESH), null);
});

test('the turn cap stops the run and names the number it stopped on', () => {
  const stop = ceilingReached({ ...CEILINGS, maxTurns: 4 }, { ...FRESH, turns: 4 });
  assert.equal(stop?.kind, 'turns');
  assert.match(stop?.message ?? '', /turn cap of 4/);
});

test('the tool-call cap only counts calls the host actually reported', () => {
  assert.equal(toolCallsReported([{ }, { }]), null, 'a host that reports nothing gives nothing to count');
  assert.equal(toolCallsReported([{ toolCalls: 0 }, { }]), 0, 'one real zero is still a measurement');
  assert.equal(toolCallsReported([{ toolCalls: 3 }, { toolCalls: 4 }]), 7);

  const unmeasured = ceilingReached({ ...CEILINGS, maxToolCalls: 5 }, { turns: 1, toolCalls: null, elapsedMs: 0 });
  assert.equal(unmeasured?.kind, undefined, 'an unmeasured run is never stopped on a figure nobody measured');
  const measured = ceilingReached({ ...CEILINGS, maxToolCalls: 5 }, { turns: 1, toolCalls: 5, elapsedMs: 0 });
  assert.equal(measured?.kind, 'tool-calls');
  assert.match(measured?.message ?? '', /tool-call cap of 5/);
});

test('the time cap reads in seconds when it is short and minutes when it is not', () => {
  const seconds = ceilingReached({ ...CEILINGS, maxWallClockMs: 60_000 }, { ...FRESH, elapsedMs: 61_000 });
  assert.equal(seconds?.kind, 'time');
  assert.match(seconds?.message ?? '', /Stopped after 61s/);
  assert.match(seconds?.message ?? '', /time limit is 60s/);

  const minutes = ceilingReached({ ...CEILINGS, maxWallClockMs: 5 * 60_000 }, { ...FRESH, elapsedMs: 6 * 60_000 });
  assert.match(minutes?.message ?? '', /Stopped after 6min/);
  assert.match(minutes?.message ?? '', /time limit is 5min/);
});

test('a ceiling nobody configured does not stop a run', () => {
  for (const off of [0, -1, Infinity]) {
    const ceilings = { maxTurns: off, maxToolCalls: off, maxWallClockMs: off };
    assert.equal(ceilingReached(ceilings, { turns: 9_000, toolCalls: 9_000, elapsedMs: 9_000_000 }), null);
  }
});

test('work usage is read off the attempts, so a resumed run counts what it already did', () => {
  const usage = workUsageOf([{ toolCalls: 2 }, { toolCalls: 3 }, { }], 5_000);
  assert.equal(usage.turns, 3);
  assert.equal(usage.toolCalls, 5);
  assert.equal(usage.elapsedMs, 5_000);
});

test('the turn cap is checked before the clock cap, so a stall still reports the sharper reason', () => {
  const stop = ceilingReached(
    { ...CEILINGS, maxTurns: 2, maxWallClockMs: 1_000 },
    { turns: 2, toolCalls: null, elapsedMs: 10_000 }
  );
  assert.equal(stop?.kind, 'turns');
});
