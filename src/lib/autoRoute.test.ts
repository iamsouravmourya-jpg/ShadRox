import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  admitReader,
  CONDENSE_MIN_INPUT_TOKENS,
  decideAutoRoute,
  READER_MIN_CANDIDATES,
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
    // Condense 16k/4k on ling = ₹0.06; answer 4.8k/1.2k on deepseek = ₹0.09;
    // ₹0.15 / ₹0.35 = 0.43 credits, shown as 0.5 because a partial credit is
    // never quietly rounded down.
    const rupees =
      costRupees(LING, { inputTokens: 16_000, outputTokens: 4_000 }) +
      costRupees(DEEPSEEK, { inputTokens: 4_800, outputTokens: 1_200 });
    assert.equal(rupees, 0.15);
    assert.equal(HEAVY.credits, 0.5);
    assert.ok(HEAVY.credits >= rupees / RUPEES_PER_CREDIT);
  });

  it('affords a premium answer only because the digest shrank the input', () => {
    const premium = decideAutoRoute(input({ role: 'premium' }));
    assert.equal(premium.answerModel, KIMI);
    assert.equal(premium.withinBudget, true);
    // ₹0.06 condense + ₹0.93 answer = ₹0.99, which is 2.83 of the ₹0.35 credit
    // and is rounded to 2.9 rather than up to a whole 3.
    assert.equal(premium.credits, 2.9);
    // The same premium call on the raw 16k blows the ₹1.05 premium budget.
    assert.equal(routeRequest('premium', { inputTokens: 16_000, outputTokens: 1_200 }, KEY).withinBudget, false);
  });

  it('reports the routing saving as a multiple of the naive bill', () => {
    assert.equal(HEAVY.savingsFactor, 18.2);
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
    // The ₹0.021 overhead ceiling is not met by anything on this key.
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

/**
 * The outcome ledger reaches routing as `outcomePreference`: models ordered by
 * verified runs. It is a tie-break among the candidates the budget already
 * allows — with no ledger, or a ledger that names models this key does not
 * serve, the price table alone decides, exactly as it did before D3.
 */
describe('decideAutoRoute with an outcome ranking', () => {
  const NOVA = 'amazon/nova-micro-v1';
  const CODER_30B = 'qwen/qwen3-coder-30b';
  const RANKED = [DEEPSEEK, CODER_30B, 'qwen/qwen3-coder', NOVA, LING];

  it('lets a proven edit model take the answer when it is still inside the budget', () => {
    const ranked = decideAutoRoute(input({ availableModels: RANKED, outcomePreference: [CODER_30B] }));
    assert.equal(ranked.answerModel, CODER_30B);
    assert.equal(ranked.withinBudget, true);
    assert.match(ranked.reason, /best-proven edit model inside ₹0\.42 — ₹0\.14, ₹0\.05 above the cheapest/);
    // The reader pass is not ranked by an edit model's record: price still
    // chooses it, because nothing in the preference list serves that role.
    assert.equal(ranked.condenseModel, LING);
  });

  it('ranks the reader pass from the same list when a select model is on it', () => {
    const ranked = decideAutoRoute(input({ availableModels: RANKED, outcomePreference: [NOVA] }));
    assert.equal(ranked.condenseModel, NOVA);
    assert.equal(ranked.answerModel, DEEPSEEK);
    assert.match(ranked.reason, /best-proven select model inside ₹0\.13 — ₹0\.11, ₹0\.06 above the cheapest/);
  });

  it('buys the cheapest model in every class when there is no ledger behind the list', () => {
    assert.deepEqual(
      decideAutoRoute(input({ availableModels: RANKED })),
      decideAutoRoute(input({ availableModels: RANKED, outcomePreference: ['google/gemini-3-flash'] })),
      'a ranking of models this key does not serve must be indistinguishable from no ranking'
    );
    const plain = decideAutoRoute(input({ availableModels: RANKED }));
    assert.equal(plain.answerModel, DEEPSEEK);
    assert.equal(plain.condenseModel, LING);
    assert.match(plain.reason, /cheapest edit model inside ₹0\.42/);
  });

  it('still never substitutes the answer model on the user’s own key', () => {
    const byok = decideAutoRoute(input({ isSharedKey: false, availableModels: RANKED, outcomePreference: [CODER_30B, NOVA] }));
    assert.equal(byok.answerModel, SONNET);
    assert.match(byok.reason, /routing does not replace it/);
    // The digest pass is a saving the user actually receives, so it does obey
    // the ranking even on BYOK.
    assert.equal(byok.condenseModel, NOVA);
    assert.equal(byok.savingsFactor, null);
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
    assert.equal(byok.credits, 6.3);
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
    assert.equal(small.credits, 0.2);
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
    assert.equal(mystery.credits, 8);
  });
});

/**
 * ShadRox has one product state — the user's own key — so a BYOK request is
 * never answer-routed. What it does keep is the cost estimate: with no plan to
 * meter, `credits` is the figure that lets a run say "this turn is expensive"
 * before spending it, so zeroing it would blind the budget guard.
 */
describe('decideAutoRoute on the only product path (BYOK)', () => {
  it('keeps the cheap first pass and still prices the turn it is predicting', () => {
    const byok = decideAutoRoute(input({ isSharedKey: false, userModel: 'google/gemini-3-flash' }));
    assert.equal(byok.enabled, true);
    assert.equal(byok.condenseModel, LING);
    assert.equal(byok.answerModel, 'google/gemini-3-flash');
    assert.ok(byok.credits > 0, 'the estimate must survive with no plan metering it');
    assert.equal(byok.savingsFactor, null);
    assert.equal(byok.estInputTokens, 4_800);
    assert.match(byok.reason, /digests/);
  });

  it('still warns that an unpriced model is estimated at the premium assumption', () => {
    const byok = decideAutoRoute(input({ isSharedKey: false, userModel: 'vendor/unknown-1' }));
    assert.equal(byok.withinBudget, false);
    assert.ok(byok.credits > 0);
    assert.match(byok.reason, /not in the price registry/);
  });
});

/**
 * The pack's shared key serves exactly four models. This is the stack the ₹699
 * price was computed on, so routing has to land each role on the model the
 * margin was measured with: Nova Micro reads, Qwen3 Coder Flash writes,
 * DeepSeek V4.1 Flash escalates.
 */
describe('the Starter Pack model stack', () => {
  const PACK = [
    'amazon/nova-micro-v1',
    'google/gemini-2.5-flash-lite',
    'qwen/qwen3-coder-flash',
    'deepseek/deepseek-v4.1-flash'
  ];

  it('reads on Nova Micro, writes on Qwen3 Coder Flash, escalates on DeepSeek V4.1 Flash', () => {
    assert.equal(routeRequest('select', { inputTokens: 16_000, outputTokens: 4_000 }, PACK).model, 'amazon/nova-micro-v1');
    assert.equal(routeRequest('edit', { inputTokens: 15_000, outputTokens: 1_200 }, PACK).model, 'qwen/qwen3-coder-flash');
    assert.equal(routeRequest('premium', { inputTokens: 4_800, outputTokens: 1_200 }, PACK).model, 'deepseek/deepseek-v4.1-flash');
  });

  it('keeps one 16k edit inside a single credit, which is what the ₹699 price assumes', () => {
    const turn = decideAutoRoute(input({ availableModels: PACK }));
    assert.equal(turn.condenseModel, 'amazon/nova-micro-v1');
    assert.equal(turn.answerModel, 'qwen/qwen3-coder-flash');
    assert.equal(turn.withinBudget, true);
    assert.equal(turn.credits, 1);
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

/**
 * S08 — the reader is a paid second pass, so it is admitted only when it nets
 * a real saving on the writer's own bill. Explicit answers and confident
 * deterministic selection skip it entirely.
 */
describe('admitReader (S08)', () => {
  const NOVA = 'amazon/nova-micro-v1';
  const GLM = 'z-ai/glm-4.7-flash';
  const QWEN_FLASH = 'qwen/qwen3-coder-flash';

  const base = { candidateCount: 40, rawTokens: 25_000, readerModel: NOVA };

  it('never calls a reader when the request names its own targets', () => {
    const decision = admitReader({ ...base, hasExplicitTargets: true, writerModel: QWEN_FLASH });
    assert.equal(decision.admitted, false);
    assert.equal(decision.readerCostRupees, 0);
    assert.match(decision.reason, /names its own targets/);
  });

  it('skips the reader when the candidate set is small enough to select deterministically', () => {
    const decision = admitReader({ ...base, candidateCount: READER_MIN_CANDIDATES - 1, hasExplicitTargets: false, writerModel: QWEN_FLASH });
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /select deterministically/);
  });

  it('skips the reader when there is too little context to pay for a second pass', () => {
    const decision = admitReader({ ...base, rawTokens: CONDENSE_MIN_INPUT_TOKENS - 1, hasExplicitTargets: false, writerModel: QWEN_FLASH });
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /too little/);
  });

  it('admits the reader when an expensive writer makes the digest a net win', () => {
    const decision = admitReader({ ...base, hasExplicitTargets: false, writerModel: QWEN_FLASH });
    assert.equal(decision.admitted, true);
    assert.ok((decision.netSavingFactor ?? 0) >= 0.2);
    assert.ok(decision.writerAfterReaderRupees < decision.writerDirectRupees);
    assert.match(decision.reason, /above the 20% bar/);
  });

  it('refuses the reader when a cheap writer already costs less than the digest plus the reader', () => {
    const decision = admitReader({ ...base, hasExplicitTargets: false, writerModel: GLM });
    assert.equal(decision.admitted, false);
    assert.ok((decision.netSavingFactor ?? 1) < 0.2);
    assert.match(decision.reason, /below the 20% bar/);
  });
});
