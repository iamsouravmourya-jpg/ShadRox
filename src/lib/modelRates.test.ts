import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATCH_RATIO,
  FAST_RATIO,
  UNKNOWN_RATE,
  USD_TO_INR,
  costRupees,
  costUsd,
  isPriced,
  resolveRate,
  roundRupees,
  rupeeRates,
} from './modelRates.js';

// ── resolveRate ───────────────────────────────────────────────────────────────

test('resolveRate returns UNKNOWN_RATE for a completely unknown model id', () => {
  const rate = resolveRate('totally-unknown-model-xyz-9999');
  assert.deepEqual(rate, UNKNOWN_RATE);
});

test('resolveRate matches the cheapest flash-lite family', () => {
  const rate = resolveRate('gemini-2.5-flash-lite');
  assert.equal(rate.input, 0.1);
  assert.equal(rate.output, 0.4);
});

test('resolveRate is case-insensitive', () => {
  const lower = resolveRate('gemini-2.5-flash-lite');
  const upper = resolveRate('GEMINI-2.5-FLASH-LITE');
  assert.deepEqual(lower, upper);
});

test('resolveRate applies BATCH_RATIO when model id contains "batch"', () => {
  const base = resolveRate('gemini-2.5-flash-lite');
  const batched = resolveRate('gemini-2.5-flash-lite-batch');
  assert.equal(batched.input, roundRupees(base.input * BATCH_RATIO));
  assert.equal(batched.output, roundRupees(base.output * BATCH_RATIO));
});

test('resolveRate applies FAST_RATIO when model id ends with "-fast"', () => {
  const base = resolveRate('gemini-2.5-flash-lite');
  const fast = resolveRate('gemini-2.5-flash-lite-fast');
  // FAST_RATIO doubles the price
  assert.equal(fast.input, base.input * FAST_RATIO);
  assert.equal(fast.output, base.output * FAST_RATIO);
});

test('resolveRate returns correct rates for a premium claude-sonnet pattern', () => {
  const rate = resolveRate('claude-sonnet-5.5');
  assert.equal(rate.input, 2.0);
  assert.equal(rate.output, 10.0);
});

test('resolveRate never returns negative values', () => {
  const ids = [
    'gpt-4o-mini',
    'gemini-3-flash',
    'llama-3.3-70b',
    'totally-made-up-model',
    'gpt-5.5-pro',
  ];
  for (const id of ids) {
    const rate = resolveRate(id);
    assert.ok(rate.input >= 0, `${id} input should be >= 0`);
    assert.ok(rate.output >= 0, `${id} output should be >= 0`);
  }
});

// ── costUsd ───────────────────────────────────────────────────────────────────

test('costUsd is 0 when both token counts are 0', () => {
  assert.equal(costUsd('gpt-4o-mini', { inputTokens: 0, outputTokens: 0 }), 0);
});

test('costUsd calculates correctly for known rates', () => {
  // gpt-4o-mini: input=$0.15/1M, output=$0.6/1M
  // 1000 input + 500 output → (0.15*1000 + 0.6*500) / 1_000_000
  const expected = (0.15 * 1000 + 0.6 * 500) / 1_000_000;
  const actual = costUsd('gpt-4o-mini', { inputTokens: 1000, outputTokens: 500 });
  assert.ok(Math.abs(actual - expected) < 1e-10, `expected ~${expected}, got ${actual}`);
});

test('costUsd for unknown model uses UNKNOWN_RATE (premium guard)', () => {
  const actual = costUsd('made-up-model', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(actual, UNKNOWN_RATE.input);
});

// ── costRupees ────────────────────────────────────────────────────────────────

test('costRupees converts via USD_TO_INR and rounds to 2 decimal places', () => {
  const usd = costUsd('gpt-4o-mini', { inputTokens: 1000, outputTokens: 500 });
  const expectedRupees = Math.round(usd * USD_TO_INR * 100) / 100;
  assert.equal(costRupees('gpt-4o-mini', { inputTokens: 1000, outputTokens: 500 }), expectedRupees);
});

// ── rupeeRates ────────────────────────────────────────────────────────────────

test('rupeeRates scales USD rates by USD_TO_INR', () => {
  const usdRate = resolveRate('gpt-4o-mini');
  const inrRate = rupeeRates('gpt-4o-mini');
  assert.equal(inrRate.input, usdRate.input * USD_TO_INR);
  assert.equal(inrRate.output, usdRate.output * USD_TO_INR);
});

// ── isPriced ──────────────────────────────────────────────────────────────────

test('isPriced returns true for a model in the table', () => {
  assert.equal(isPriced('gpt-4o-mini'), true);
  assert.equal(isPriced('gemini-2.5-flash-lite'), true);
  assert.equal(isPriced('claude-sonnet-5.5'), true);
});

test('isPriced returns false for a completely unknown model', () => {
  assert.equal(isPriced('totally-unknown-model-xyz-9999'), false);
});

// ── roundRupees ───────────────────────────────────────────────────────────────

test('roundRupees rounds to exactly 2 decimal places', () => {
  // 1.005 has a known floating-point representation below the exact midpoint,
  // so Math.round(1.005 * 100) / 100 === 1.00, not 1.01 — use a value that
  // is reliably above the midpoint after IEEE-754 representation.
  assert.equal(roundRupees(1.006), 1.01);
  assert.equal(roundRupees(1.004), 1.0);
  assert.equal(roundRupees(0), 0);
  assert.equal(roundRupees(100), 100);
  assert.equal(roundRupees(0.001), 0.0);  // below 1 paisa → rounds to 0
  assert.equal(roundRupees(0.005), 0.01); // 0.005 * 100 = 0.5 → rounds to 1 paisa
});

// ── constants sanity ─────────────────────────────────────────────────────────

test('USD_TO_INR is a positive realistic exchange rate', () => {
  assert.ok(USD_TO_INR > 50 && USD_TO_INR < 200, `USD_TO_INR=${USD_TO_INR} seems wrong`);
});

test('BATCH_RATIO is less than 1 and FAST_RATIO is greater than 1', () => {
  assert.ok(BATCH_RATIO > 0 && BATCH_RATIO < 1);
  assert.ok(FAST_RATIO > 1);
});
