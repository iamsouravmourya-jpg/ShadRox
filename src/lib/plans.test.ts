import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BETA_UNLOCKED_PLANS,
  BETA_UPGRADE_NOTE,
  CREDIT_RATES,
  PLANS,
  RUPEES_PER_CREDIT,
  getLockedPlanIds,
  getPlanEntitlementNote,
  getPlanMeta,
  isPlanSelectable
} from './plans';
import { SHARED_KEY_ENABLED, isSharedKeyEligible } from './sharedKeyPolicy';

test('the beta unlocks Starter only, and Free is always selectable', () => {
  assert.equal(isPlanSelectable('free'), true);
  assert.equal(isPlanSelectable('starter'), true);
  assert.equal(isPlanSelectable('pro'), false);
  assert.deepEqual(BETA_UNLOCKED_PLANS, ['starter']);
});

test('only the still-locked tiers are reported as locked', () => {
  assert.deepEqual(getLockedPlanIds(), ['pro']);
});

/** These numbers are the owner's business decision; a drift here is a defect. */
test('prices, allotments and credit rates are unchanged', () => {
  assert.equal(RUPEES_PER_CREDIT, 0.24);
  assert.deepEqual({ ...CREDIT_RATES }, { chatter: 0.4, codeEdit: 1, premiumRefactor: 6, tabCompletion: 0.1 });
  assert.equal(getPlanMeta('free').creditsPerMonth, Infinity);
  assert.equal(getPlanMeta('starter').creditsPerMonth, 800);
  assert.equal(getPlanMeta('pro').creditsPerMonth, 2200);
  assert.equal(getPlanMeta('starter').price, '₹399 + GST');
  assert.equal(getPlanMeta('pro').price, '₹999 + GST');
  assert.equal(PLANS.length, 3);
});

test('the entitlement note names the allotment and the shared key it buys', () => {
  const starter = getPlanEntitlementNote('starter', true);
  assert.match(starter, /800 credits a month/);
  assert.match(starter, /ShadRox shared key/);
  assert.match(starter, /operator/);

  const pro = getPlanEntitlementNote('pro', false);
  assert.match(pro, /2,200 credits a month/);
  assert.match(pro, /does not open that path for Pro/);

  const free = getPlanEntitlementNote('free', false);
  assert.match(free, /no credits/);
});

/** Credits buy the shared-key path, so a plan without eligibility cannot promise it. */
test('the copy never claims credits are spendable without the shared key', () => {
  for (const entry of PLANS) {
    const note = getPlanEntitlementNote(entry.id, isSharedKeyEligible(entry.id));
    assert.ok(note.length > 0, entry.id);
    if (Number.isFinite(entry.creditsPerMonth) && !isSharedKeyEligible(entry.id)) {
      assert.match(note, /does not open that path/);
    }
  }
});

test('shared-key eligibility follows the unlock list, not a flat flag', () => {
  assert.equal(isSharedKeyEligible('free'), false);
  assert.equal(isSharedKeyEligible('starter'), true);
  assert.equal(isSharedKeyEligible('pro'), false);
  assert.equal(SHARED_KEY_ENABLED, BETA_UNLOCKED_PLANS.length > 0);
});

test('upgrade copy admits no payment is taken', () => {
  assert.match(BETA_UPGRADE_NOTE, /no payment is taken yet/);
});
