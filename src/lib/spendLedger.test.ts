import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryStore } from './chatHistory';
import {
  CAPS_OFF,
  dailySpendGate,
  loadSpendCaps,
  parseCapInput,
  perTurnSpendGate,
  readSpendSnapshot,
  recordUsageFrame,
  runBudgetWithCap,
  saveSpendCaps
} from './spendLedger';
import { DEFAULT_RUN_BUDGET } from './autonomy/types';

function memoryStore(): HistoryStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  };
}

test('spend caps default off and blank inputs disable a cap', () => {
  const store = memoryStore();
  assert.deepEqual(loadSpendCaps(store), CAPS_OFF);
  assert.equal(parseCapInput(''), Infinity);
  assert.equal(parseCapInput('0'), Infinity);
  assert.deepEqual(saveSpendCaps({ perDayCredits: 10 }, store), {
    perTurnCredits: Infinity,
    perDayCredits: 10,
    perRunCredits: Infinity
  });
  assert.equal(loadSpendCaps(store).perDayCredits, 10);
});

test('usage frames accumulate in session and daily spend', () => {
  const store = memoryStore();
  const now = new Date(2026, 10, 6, 12).getTime();
  const credits = recordUsageFrame('workspace-a', {
    modelId: 'deepseek/deepseek-v4-flash',
    inputTokens: 10_000,
    outputTokens: 1_000
  }, store, now);
  assert.equal(credits, 0.5);
  assert.deepEqual(readSpendSnapshot('workspace-a', store, now), {
    day: '2026-11-06',
    sessionCredits: 0.5,
    sessionRupees: 0.15,
    dayCredits: 0.5,
    dayRupees: 0.15
  });
  assert.equal(dailySpendGate('workspace-a', { ...CAPS_OFF, perDayCredits: 0.5 }, store, now).blocked, true);
});

test('day totals roll over without losing the session total', () => {
  const store = memoryStore();
  const firstDay = new Date(2026, 10, 6, 12).getTime();
  const nextDay = new Date(2026, 10, 7, 12).getTime();
  recordUsageFrame('workspace-a', {
    modelId: 'deepseek/deepseek-v4-flash',
    inputTokens: 10_000,
    outputTokens: 1_000
  }, store, firstDay);
  const snapshot = readSpendSnapshot('workspace-a', store, nextDay);
  assert.equal(snapshot.dayCredits, 0);
  assert.equal(snapshot.sessionCredits, 0.5);
});

test('per-turn and per-run caps stop at the configured ceiling', () => {
  const caps = { ...CAPS_OFF, perTurnCredits: 2, perRunCredits: 4 };
  assert.equal(perTurnSpendGate(1.9, caps).blocked, false);
  assert.equal(perTurnSpendGate(2, caps).blocked, true);
  assert.equal(runBudgetWithCap(DEFAULT_RUN_BUDGET, caps).maxCredits, 4);
  assert.equal(
    runBudgetWithCap({ ...DEFAULT_RUN_BUDGET, maxCredits: 3 }, caps).maxCredits,
    3
  );
});

test('corrupt ledger and caps fail closed rather than clearing limits', () => {
  const store = memoryStore();
  store.setItem('shadrox.spend.ledger', '{');
  assert.equal(dailySpendGate('workspace-a', { ...CAPS_OFF, perDayCredits: 10 }, store).blocked, true);
  store.setItem('shadrox.spend.caps', '{');
  assert.equal(dailySpendGate('workspace-a', undefined, store).blocked, true);
  assert.throws(() => loadSpendCaps(store), /unreadable/);
});
