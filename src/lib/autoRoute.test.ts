import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONDENSE_MIN_INPUT_TOKENS,
  decideAutoRoute,
  type AutoInput
} from './autoRoute';
import { costRupees } from './modelRates';
import { routeRequest, routingSavings } from './modelRouter';
import { RUPEES_PER_CREDIT } from './plans';

/** Same four-model key as modelRates.test.ts, so the money lines up across files. */
const KEY = [
  'anthropic/claude-sonnet-5.5',
  'deepseek/deepseek-v4-flash',
  'inclusionai/ling-3.0-flash',
  'moonshotai/kimi-k2.7-code'
];
const SONNET = 'anthropic/claude-sonnet-5.5';
const DEEPSEEK = 'deepseek/deepseek-v4-flash';
const LING = 'inclusionai/ling-3.0-flash';
const KIMI = 'moonshotai/kimi-k2.7-code';

function input(overrides: Partial<AutoInput> = {}): AutoInput {
  return {
    role: 'edit',
    estimatedInputTokens: 16_000,
    availableModels: KEY,
    userModel: SONNET,
    isSharedKey: true,
    plan: 'starter',
    ...overrides
  };
}

/** The shared-key edit turn this feature exists for: 16k of repo context. */
const HEAVY = decideAutoRoute(input());

describe('decideAutoRoute on a shared key', () => {
  it('puts the answer on the cheapest priced edit model and the context on a select model', () => {
    assert.equal(HEAVY.enabled, true);
    assert.equal(HEAVY.answerModel, DEEPSEEK);
    assert.equal(HEAVY.condenseModel, LING);
    assert.equal(HEAVY.withinBudget, true);
    assert.match(HEAVY.reason, /cheapest edit model inside/);
  });

  it('has the digest replace the raw context, so the answer call sees ~4.8k tokens not 16k', () => {
    // Assumption under test: 16k condenses to 25% = 4k digest tokens, and the
    // 800 tokens of question-plus-protocol the digest cannot replace are added
    // back on top rather than silently dropped.
    assert.equal(HEAVY.estInputTokens, 4_800);
    assert.equal(HEAVY.estOutputTokens, 1_200);
    assert.ok(HEAVY.estInputTokens < 16_000 / 2, 'the answer input must be a fraction of the raw context');
    assert.match(HEAVY.reason, /digests 16000 context tokens into ~4000/);
  });

  it('bills both passes off the rate table and rounds the credit total up to a tenth', () => {
    // Condense 16k/4k on ling = ₹0.05; answer 4.8k/1.2k on deepseek = ₹0.08;
    // ₹0.13 / ₹0.24 = 0.5417 credits, shown as 0.6 because a partial credit is
    // never quietly rounded down.
    const rupees =
      costRupees(LING, { inputTokens: 16_000, outputTokens: 4_000 }) +
      costRupees(DEEPSEEK, { inputTokens: 4_800, outputTokens: 1_200 });
    assert.equal(rupees, 0.13);
    assert.equal(HEAVY.credits, 0.6);
    assert.ok(HEAVY.credits >= rupees / RUPEES_PER_CREDIT);
  });

  it('affords a premium answer only because the digest shrank the input', () => {
    const premium = decideAutoRoute(input({ role: 'premium', plan: 'pro' }));
    assert.equal(premium.answerModel, KIMI);
    assert.equal(premium.withinBudget, true);
    // ₹0.05 condense + ₹0.79 answer = ₹0.84 = exactly 3.5 credits; an unguarded
    // ceil would let float noise push the boundary to 3.6.
    assert.equal(premium.credits, 3.5);
    // The same premium call on the raw 16k blows the ₹1.44 premium rate.
    assert.equal(routeRequest('premium', { inputTokens: 16_000, outputTokens: 1_200 }, KEY).withinBudget, false);
  });

  it('reports the routing saving as a multiple of the naive bill', () => {
    assert.equal(HEAVY.savingsFactor, 18.5);
    assert.equal(
      HEAVY.savingsFactor,
      routingSavings('edit', { inputTokens: 16_000, outputTokens: 1_200 }, SONNET, KEY).savedFactor
    );
  });

  it('skips the second pass below 4000 tokens, where the whole context costs under a fifth of one credit', () => {
    const small = decideAutoRoute(input({ estimatedInputTokens: CONDENSE_MIN_INPUT_TOKENS - 1 }));
    assert.equal(small.condenseModel, null);
    assert.equal(small.estInputTokens, 3_999);
    assert.match(small.reason, /too little context to pay for a second pass/);
    // Routing still moved the answer off Sonnet, so the turn is not untouched.
    assert.equal(small.enabled, true);
    assert.equal(small.answerModel, DEEPSEEK);
  });

  it('is enabled only when routing bought something, and says so with a factor of 1', () => {
    const alreadyCheap = decideAutoRoute(input({ role: 'chatter', estimatedInputTokens: 400, userModel: LING }));
    assert.equal(alreadyCheap.enabled, false);
    assert.equal(alreadyCheap.condenseModel, null);
    assert.equal(alreadyCheap.answerModel, LING);
    assert.equal(alreadyCheap.savingsFactor, 1);
    assert.equal(alreadyCheap.credits, 0.1);
  });

  it('does not stack a digest onto a role that already is the cheap single pass', () => {
    const summarize = decideAutoRoute(input({ role: 'summarize', estimatedInputTokens: 12_000 }));
    assert.equal(summarize.condenseModel, null);
    assert.equal(summarize.estInputTokens, 12_000);
    assert.match(summarize.reason, /already the cheap single pass/);
    // The ₹0.024 overhead ceiling is not met by anything on this key.
    assert.equal(summarize.withinBudget, false);
  });

  it('hands back the router reason when the key serves nothing it can price', () => {
    const broke = decideAutoRoute(input({ availableModels: ['vendor/unknown-1', 'other/none'] }));
    assert.equal(broke.condenseModel, null);
    assert.equal(broke.enabled, false);
    assert.equal(broke.withinBudget, false);
    assert.equal(broke.answerModel, SONNET);
    assert.match(broke.reason, /no priceable model on this key/);
  });

  it('reports no savings factor rather than a fake one when nothing could be routed', () => {
    const broke = decideAutoRoute(input({ availableModels: ['vendor/unknown-1'] }));
    assert.equal(broke.savingsFactor, null);
    assert.equal(routingSavings('edit', { inputTokens: 16_000, outputTokens: 1_200 }, SONNET, ['vendor/unknown-1']).savedFactor, 0);
  });
});

describe('decideAutoRoute on the user’s own key', () => {
  it('never substitutes a cheaper answer model on BYOK', () => {
    const byok = decideAutoRoute(input({ isSharedKey: false }));
    assert.equal(byok.answerModel, SONNET);
    assert.equal(byok.enabled, true);
    assert.equal(byok.withinBudget, true);
    assert.match(byok.reason, /your key/);
    assert.match(byok.reason, /routing does not replace it/);
  });

  it('still offers the condense pass, because it only ever cuts the user’s own input bill', () => {
    const byok = decideAutoRoute(input({ isSharedKey: false }));
    assert.equal(byok.condenseModel, LING);
    assert.equal(byok.estInputTokens, 4_800);
    assert.equal(byok.credits, 7.8);
    // No routing-savings multiple: the answer model was never routed, so any
    // factor here would describe a saving BYOK did not take.
    assert.equal(byok.savingsFactor, null);
    const ownBill = costRupees(SONNET, { inputTokens: 16_000, outputTokens: 1_200 });
    const condensedBill =
      costRupees(SONNET, { inputTokens: 4_800, outputTokens: 1_200 }) +
      costRupees(LING, { inputTokens: 16_000, outputTokens: 4_000 });
    assert.ok(condensedBill < ownBill, 'the digest must strictly reduce the user’s own bill');
  });

  it('offers nothing at all on BYOK when the context is already small', () => {
    const small = decideAutoRoute(input({ isSharedKey: false, estimatedInputTokens: 2_000, userModel: DEEPSEEK }));
    assert.equal(small.enabled, false);
    assert.equal(small.condenseModel, null);
    assert.equal(small.answerModel, DEEPSEEK);
    assert.equal(small.credits, 0.3);
  });

  it('calls an unpriced BYOK model premium rather than pretending the turn is cheap', () => {
    const mystery = decideAutoRoute(
      input({ isSharedKey: false, userModel: 'vendor/unknown-1', availableModels: ['vendor/unknown-1'], estimatedInputTokens: 8_000 })
    );
    assert.equal(mystery.withinBudget, false);
    assert.equal(mystery.answerModel, 'vendor/unknown-1');
    assert.match(mystery.reason, /not in the price registry/);
    assert.match(mystery.reason, /premium assumption/);
    // UNKNOWN_RATE is an upper bound, so the estimate must be the premium bill.
    assert.equal(mystery.credits, 9.8);
  });
});

describe('decideAutoRoute on the free plan', () => {
  /** The plan has no credit meter, but the user's own key pays for every context
   *  token — so the cheap first pass is a saving they receive, and only the
   *  answer-side swap (which ShadRox is not paying for) is withheld. */
  it('keeps the cheap first pass and bills no credit on a BYOK-only free plan', () => {
    const free = decideAutoRoute(input({ plan: 'free', isSharedKey: false, userModel: 'google/gemini-3-flash' }));
    assert.equal(free.enabled, true);
    assert.equal(free.condenseModel, LING);
    assert.equal(free.answerModel, 'google/gemini-3-flash');
    assert.equal(free.credits, 0);
    assert.equal(free.savingsFactor, null);
    assert.equal(free.estInputTokens, 4_800);
    assert.match(free.reason, /no credit meter/);
    assert.match(free.reason, /digests/);
  });

  it('never substitutes the answer model for a free plan even on a shared key', () => {
    const free = decideAutoRoute(input({ plan: 'free', isSharedKey: true, userModel: SONNET }));
    assert.equal(free.answerModel, SONNET);
    assert.equal(free.credits, 0);
    assert.match(free.reason, /no credit meter/);
  });

  it('still warns that an unpriced free-plan model is billed at the premium assumption', () => {
    const free = decideAutoRoute(input({ plan: 'free', isSharedKey: false, userModel: 'vendor/unknown-1' }));
    assert.equal(free.withinBudget, false);
    assert.equal(free.credits, 0);
    assert.match(free.reason, /no credit meter/);
    assert.match(free.reason, /not in the price registry/);
  });
});

describe('decideAutoRoute number hygiene', () => {
  it('never returns a negative credit figure or a negative token count', () => {
    const junk = decideAutoRoute(input({ estimatedInputTokens: -5_000, userModel: '', availableModels: [] }));
    assert.ok(junk.credits >= 0);
    assert.equal(junk.estInputTokens, 0);
    assert.equal(junk.estOutputTokens, 1_200);
    assert.ok(Number.isFinite(junk.credits));
  });

  it('spends zero credits when there is no model to bill', () => {
    const nothing = decideAutoRoute(input({ userModel: '', availableModels: [] }));
    assert.equal(nothing.credits, 0);
    assert.equal(nothing.enabled, false);
    assert.equal(nothing.withinBudget, false);
  });

  it('is deterministic: the same request decides the same way twice', () => {
    assert.deepEqual(decideAutoRoute(input()), decideAutoRoute(input()));
    assert.deepEqual(decideAutoRoute(input({ role: 'premium' })), decideAutoRoute(input({ role: 'premium' })));
  });
});
