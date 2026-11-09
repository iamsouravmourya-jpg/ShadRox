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
  getPlanPriceDisplay,
  isPlanSelectable
} from './plans';
import { SHARED_KEY_ENABLED, isSharedKeyEligible } from './sharedKeyPolicy';

test('two paid packs, and Free is always selectable', () => {
  assert.equal(isPlanSelectable('free'), true);
  assert.equal(isPlanSelectable('starter'), false);
  assert.equal(isPlanSelectable('heavy'), false);
  assert.deepEqual(BETA_UNLOCKED_PLANS, []);
  assert.deepEqual(getLockedPlanIds(), ['starter', 'heavy']);
  assert.equal(PLANS.length, 3);
});

/** These numbers are the owner's business decision; a drift here is a defect. */
test('price, allotment and credit rates are unchanged', () => {
  assert.equal(RUPEES_PER_CREDIT, 0.35);
  assert.deepEqual({ ...CREDIT_RATES }, { chatter: 0.2, codeEdit: 1.2, premiumRefactor: 3, tabCompletion: 0.06 });
  assert.equal(getPlanMeta('free').creditsPerMonth, Infinity);
  assert.equal(getPlanMeta('starter').creditsPerMonth, 800);
  assert.equal(getPlanMeta('starter').price, '₹699');
  assert.equal(getPlanMeta('heavy').creditsPerMonth, 1600);
  assert.equal(getPlanMeta('heavy').price, '₹1,299');
  assert.match(getPlanMeta('heavy').gstNote, /GST included/);
});

/**
 * Both packs are sold with GST inside the price, so the month's worst-case
 * model spend has to fit in what is left after tax and the payment gateway:
 * 800 x ₹0.35 = ₹280 → ~₹296 margin, 1,600 x ₹0.35 = ₹560 → ~₹510 margin.
 */
test('neither pack can spend more serving a month than it earns after GST and fees', () => {
  for (const [tier, gross, cogsCeiling, marginFloor] of [
    ['starter', 699, 280, 290],
    ['heavy', 1299, 560, 500]
  ] as const) {
    const netOfGst = gross / 1.18;
    const gatewayFee = gross * 0.02 * 1.18;
    const worstCaseCogs = getPlanMeta(tier).creditsPerMonth * RUPEES_PER_CREDIT;
    const margin = netOfGst - gatewayFee - worstCaseCogs;
    assert.equal(worstCaseCogs, cogsCeiling, `${tier}: worst-case COGS changed`);
    assert.ok(margin >= marginFloor, `${tier}: margin ₹${margin.toFixed(2)} is below the ₹${marginFloor} floor`);
  }
});

test('the entitlement note names the allotment and the shared key it buys', () => {
  const starter = getPlanEntitlementNote('starter', true);
  assert.match(starter, /800 credits a month/);
  assert.match(starter, /ShadRox shared key/);
  assert.match(starter, /operator/);

  const locked = getPlanEntitlementNote('starter', false);
  assert.match(locked, /800 credits a month/);
  assert.match(locked, /does not open that path for Starter Pack/);

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
  assert.equal(isSharedKeyEligible('starter'), false);
  assert.equal(SHARED_KEY_ENABLED, BETA_UNLOCKED_PLANS.length > 0);
});

test('the price is the real one, with the missing checkout said out loud', () => {
  const paid = getPlanPriceDisplay('starter');
  assert.equal(paid.headline, '₹699');
  assert.match(paid.note, /GST included/);
  assert.match(paid.note, /no checkout/);
  assert.equal(getPlanPriceDisplay('free').headline, '₹0');
});

test('upgrade copy admits no payment is taken', () => {
  assert.match(BETA_UPGRADE_NOTE, /no checkout|no payment is taken/i);
});
