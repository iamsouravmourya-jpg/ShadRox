import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BATCH_RATIO,
  UNKNOWN_RATE,
  costRupees,
  isPriced,
  resolveRate,
  rupeeRates,
  USD_TO_INR
} from './modelRates';
import { roleBudgetRupees, routeRequest, routingSavings } from './modelRouter';

/** The catalogue snapshot these rates were copied from is dated 2026-11-02. */
const EDIT_TURN = { inputTokens: 8_000, outputTokens: 1_200 };
const HEAVY_TURN = { inputTokens: 20_000, outputTokens: 1_200 };

describe('modelRates', () => {
  it('prices the default edit model at roughly a paisa-fifth of a credit', () => {
    assert.equal(costRupees('deepseek/deepseek-v4-flash', EDIT_TURN), 0.11);
    // 20k of context is exactly one ₹0.24 credit — the whole reason context
    // size, not model choice, decides whether Starter is profitable.
    assert.equal(costRupees('deepseek/deepseek-v4-flash', HEAVY_TURN), 0.24);
  });

  it('prices premium output where the money actually is', () => {
    assert.equal(costRupees('anthropic/claude-sonnet-5.5', EDIT_TURN), 2.35);
    assert.equal(costRupees('anthropic/claude-sonnet-5.5', HEAVY_TURN), 4.37);
    // Output is more than half of a premium request: 1.2k tokens at ₹840/1M.
    assert.equal(rupeeRates('anthropic/claude-sonnet-5.5').output, 10 * USD_TO_INR);
  });

  it('records that llama 3.3 70b is not a cheap default', () => {
    assert.equal(costRupees('meta/llama-3.3-70b', EDIT_TURN), 0.56);
    assert.equal(costRupees('meta/llama-3.3-70b', HEAVY_TURN), 1.28);
  });

  it('keeps the selector tier near free', () => {
    assert.equal(costRupees('inclusionai/ling-3.0-flash', { inputTokens: 2_000, outputTokens: 200 }), 0);
    assert.ok(resolveRate('inclusionai/ling-3.0-flash').input < resolveRate('deepseek/deepseek-v4-flash').input);
  });

  it('applies the catalogue-wide batch and fast variants', () => {
    assert.deepEqual(resolveRate('anthropic/claude-haiku-5.5-batch'), {
      input: 0.1 * BATCH_RATIO,
      output: 0.5 * BATCH_RATIO
    });
    assert.deepEqual(resolveRate('anthropic/claude-opus-5.5-fast'), { input: 8, output: 40 });
  });

  it('matches specific ids before general ones', () => {
    assert.deepEqual(resolveRate('google/gemini-3.5-flash-lite'), { input: 0.3, output: 2.5 });
    assert.deepEqual(resolveRate('google/gemini-3.5-flash'), { input: 1.5, output: 9 });
    assert.deepEqual(resolveRate('deepseek/deepseek-v4-pro'), { input: 0.66, output: 1.98 });
  });

  it('assumes an unknown model is premium rather than free', () => {
    assert.deepEqual(resolveRate('somebody/new-model-99'), UNKNOWN_RATE);
    assert.equal(isPriced('somebody/new-model-99'), false);
    assert.equal(isPriced('deepseek/deepseek-v4-flash'), true);
  });
});

describe('modelRouter', () => {
  const key = [
    'anthropic/claude-sonnet-5.5',
    'deepseek/deepseek-v4-flash',
    'inclusionai/ling-3.0-flash',
    'moonshotai/kimi-k2.7-code'
  ];

  it('spends the edit turn on the cheap model inside the credit budget', () => {
    const choice = routeRequest('edit', EDIT_TURN, key);
    assert.equal(choice.model, 'deepseek/deepseek-v4-flash');
    assert.equal(choice.rupees, 0.11);
    assert.equal(choice.withinBudget, true);
    assert.equal(roleBudgetRupees('edit'), 0.24);
  });

  it('keeps the selector a rounding error next to the edit', () => {
    const choice = routeRequest('select', { inputTokens: 2_000, outputTokens: 200 }, key);
    assert.equal(choice.model, 'inclusionai/ling-3.0-flash');
    assert.ok(choice.rupees <= roleBudgetRupees('select'));
  });

  it('refuses a premium model that costs more than the premium rate allows', () => {
    // CREDIT_RATES.premiumRefactor is 6 credits = ₹1.44. Kimi fits, Sonnet does not.
    assert.equal(routeRequest('premium', EDIT_TURN, key).model, 'moonshotai/kimi-k2.7-code');
    const sonnetOnly = routeRequest('premium', EDIT_TURN, ['anthropic/claude-sonnet-5.5']);
    assert.equal(sonnetOnly.model, 'anthropic/claude-sonnet-5.5');
    assert.equal(sonnetOnly.withinBudget, false);
    assert.equal(sonnetOnly.credits, 9.8);
  });

  it('says so when a key serves no model of the asked class', () => {
    const choice = routeRequest('premium', EDIT_TURN, ['deepseek/deepseek-v4-flash', 'inclusionai/ling-3.0-flash']);
    assert.equal(choice.withinBudget, false);
    assert.match(choice.reason, /no premium-class model/);
  });

  it('reports the saving as a multiple, not a vibe', () => {
    const savings = routingSavings('edit', EDIT_TURN, 'anthropic/claude-sonnet-5.5', key);
    assert.equal(savings.naiveRupees, 2.35);
    assert.equal(savings.savedRupees, 2.24);
    assert.equal(savings.savedFactor, 21.4);
  });

  it('says so when a key serves nothing this file can price', () => {
    const choice = routeRequest('edit', EDIT_TURN, ['vendor/unknown-1']);
    assert.equal(choice.model, null);
    assert.equal(choice.withinBudget, false);
  });
});
