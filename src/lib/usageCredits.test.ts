import assert from 'node:assert/strict';
import test from 'node:test';
import { creditsForTurn, formatCredits, formatTokenSplit } from './usageCredits';

test('a reported split prices at the rate table', () => {
  // deepseek-v4-flash is $0.13 in / $0.26 out per 1M, x84 = ₹10.92 in / ₹21.84 out.
  // 10k in + 1k out = ₹0.1092 + ₹0.02184 = ₹0.13104 → /0.24 = 0.546 → 0.6 credits.
  assert.equal(creditsForTurn('deepseek/deepseek-v4-flash', { inputTokens: 10_000, outputTokens: 1_000 }), 0.6);
});

test('an unknown split yields no charge rather than a guessed one', () => {
  assert.equal(creditsForTurn('deepseek/deepseek-v4-flash', {}), null);
  assert.equal(creditsForTurn('deepseek/deepseek-v4-flash', { inputTokens: 1000 }), null);
  assert.equal(creditsForTurn('deepseek/deepseek-v4-flash', { outputTokens: 1000 }), null);
});

test('the cheapest tier still spends something on the input side', () => {
  // scaledown-summarize is $0.05 in / free out: 5k tokens = ₹0.021 = 0.1 credit.
  assert.equal(creditsForTurn('scaledown-summarize', { inputTokens: 5000, outputTokens: 0 }), 0.1);
  assert.equal(creditsForTurn('scaledown-summarize', { inputTokens: 0, outputTokens: 0 }), 0);
});

test('an unpriced model is assumed premium and still bills', () => {
  // UNKNOWN_RATE is $2 in / $10 out per 1M → 1000 in + 100 out = ₹0.168 + ₹0.084.
  const credits = creditsForTurn('some-brand-new-model', { inputTokens: 1000, outputTokens: 100 });
  assert.ok(credits !== null && credits > 0);
});

test('negative token counts are refused', () => {
  assert.equal(creditsForTurn('deepseek/deepseek-v4-flash', { inputTokens: -1, outputTokens: 10 }), null);
});

test('a sub-tenth credit reads as a fraction instead of zero', () => {
  assert.equal(formatCredits(0.04), '0.04');
  assert.equal(formatCredits(1.5), '1.5');
  assert.equal(formatCredits(0), '0');
  assert.equal(formatCredits(null), '—');
});

test('the footer shows the split only when both halves exist', () => {
  assert.equal(formatTokenSplit({ inputTokens: 9123, outputTokens: 211 }, 9334), '9123 in / 211 out');
  assert.equal(formatTokenSplit({}, 9334), '9334 tok');
});
