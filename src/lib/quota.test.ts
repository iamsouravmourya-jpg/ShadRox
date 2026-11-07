import assert from 'node:assert/strict';
import test from 'node:test';
import { CREDIT_RATES, getPlanMeta } from './plans';
import {
  addCreditSpend,
  getMonthlyUsage,
  recordCreditSpend,
  resetMonthlyUsage
} from './quota';

/** localStorage + the two window listeners quota.ts talks to. */
function withBrowser(run: () => void, sharedKey = false): void {
  const store = new Map<string, string>();
  if (sharedKey) store.set('shadrox.key.shared', 'true');
  const previousStorage = Reflect.get(globalThis, 'localStorage');
  const previousWindow = Reflect.get(globalThis, 'window');
  Reflect.set(globalThis, 'localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  });
  Reflect.set(globalThis, 'window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(public type: string, public detail?: unknown) {}
    }
  });
  try {
    run();
  } finally {
    if (previousStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Reflect.set(globalThis, 'localStorage', previousStorage);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Reflect.set(globalThis, 'window', previousWindow);
  }
}

test('free/BYOK is not metered and never runs out', () => {
  withBrowser(() => {
    resetMonthlyUsage();
    for (let turn = 0; turn < 50; turn += 1) recordCreditSpend('free', 'codeEdit');
    const usage = getMonthlyUsage('free');
    assert.equal(usage.used, 0, 'nothing is counted on BYOK');
    assert.equal(usage.isCapReached, false);
    assert.equal(usage.isUnlimited, true);
  });
});

test('a plan tier is spent down at the published rates', () => {
  withBrowser(() => {
    resetMonthlyUsage();
    recordCreditSpend('starter', 'chatter');
    recordCreditSpend('starter', 'codeEdit');
    recordCreditSpend('starter', 'tabCompletion');
    assert.equal(
      getMonthlyUsage('starter').used,
      CREDIT_RATES.chatter + CREDIT_RATES.codeEdit + CREDIT_RATES.tabCompletion
    );
  }, true);
});

test('the cap is reached exactly at the plan allowance', () => {
  withBrowser(() => {
    resetMonthlyUsage();
    const limit = getPlanMeta('starter').creditsPerMonth;
    addCreditSpend(limit - CREDIT_RATES.chatter);
    assert.equal(getMonthlyUsage('starter').isCapReached, false);
    recordCreditSpend('starter', 'chatter');
    const usage = getMonthlyUsage('starter');
    assert.equal(usage.isCapReached, true);
    assert.equal(usage.remaining, 0);
    assert.equal(usage.percentage, 100);
  }, true);
});

/**
 * ShadRox pays for nothing when the user's own key carries the request, so a
 * paid plan on BYOK must neither lose credits nor get blocked.
 */
test('a paid plan running on the user\'s own key is not metered and not capped', () => {
  withBrowser(() => {
    resetMonthlyUsage();
    addCreditSpend(getPlanMeta('starter').creditsPerMonth);
    for (let turn = 0; turn < 50; turn += 1) recordCreditSpend('starter', 'codeEdit');
    const usage = getMonthlyUsage('starter');
    assert.equal(usage.used, 0, 'a BYOK turn is not counted');
    assert.equal(usage.isCapReached, false, 'a BYOK turn is never blocked by the cap');
    assert.equal(usage.isUnlimited, true);
  }, false);
});

test('both packs are metered and BYOK carries no limit', () => {
  assert.equal(getPlanMeta('starter').creditsPerMonth, 800);
  assert.equal(getPlanMeta('heavy').creditsPerMonth, 1600);
  assert.equal(Number.isFinite(getPlanMeta('free').creditsPerMonth), false);
});
