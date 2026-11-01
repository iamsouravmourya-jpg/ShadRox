/**
 * Model price registry — USD per 1M tokens.
 *
 * Snapshot source: the gateway catalogue at
 * C:\Users\sourav\OneDrive\Desktop\Models.txt (2026-11-02). Rates move monthly,
 * so this table is the only place a per-token price may be written down; docs
 * and UI must derive from it rather than repeat numbers. Ids are matched
 * against the model, specific before general, first match wins — the same
 * shape as modelCapabilities, so a new release needs no code change.
 *
 * Cached-input discounts are NOT modelled, so every number here is an upper
 * bound on the real bill.
 */

export interface ModelRate {
  /** USD per 1M prompt tokens. */
  input: number;
  /** USD per 1M completion tokens; reasoning tokens bill here too. */
  output: number;
}

export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
}

/** Operator's FX assumption. A business number, but not a plan number. */
export const USD_TO_INR = 84;

/** Catalogue-wide invariants: batch variants are half price, fast ones double. */
export const BATCH_RATIO = 0.5;
export const FAST_RATIO = 2;

/**
 * Unknown models are assumed premium. Under-estimating a cost quietly spends
 * the operator's margin; over-estimating only makes the estimate cautious.
 */
export const UNKNOWN_RATE: ModelRate = { input: 2.0, output: 10.0 };

const PRICE_TABLE: Array<{ match: RegExp; rate: ModelRate }> = [
  // Purpose-built single-pass jobs: the output side is free.
  { match: /scaledown-(summarize|extract)/, rate: { input: 0.05, output: 0.0 } },
  // Selector / summarizer tier.
  { match: /ling-3\.0-flash/, rate: { input: 0.02, output: 0.06 } },
  { match: /gpt-oss-20b/, rate: { input: 0.03, output: 0.14 } },
  { match: /qwen3\.7-flash/, rate: { input: 0.03, output: 0.13 } },
  { match: /mercury-2\.5/, rate: { input: 0.04, output: 0.15 } },
  { match: /mistral-nemo/, rate: { input: 0.03, output: 0.03 } },
  { match: /ministral-3b/, rate: { input: 0.1, output: 0.1 } },
  { match: /nemotron-3-nano/, rate: { input: 0.05, output: 0.2 } },
  { match: /nemotron-nano-9b/, rate: { input: 0.06, output: 0.23 } },
  { match: /glm-4\.7-flash/, rate: { input: 0.07, output: 0.4 } },
  // Completion tier — billed at the tab rate, so it must stay near free.
  { match: /gpt-5-nano/, rate: { input: 0.05, output: 0.4 } },
  { match: /gpt-4\.1-nano/, rate: { input: 0.1, output: 0.4 } },
  { match: /gpt-4o-mini/, rate: { input: 0.15, output: 0.6 } },
  { match: /gemini-3\.5-flash-lite/, rate: { input: 0.3, output: 2.5 } },
  { match: /gemini-3\.1-flash-lite/, rate: { input: 0.25, output: 1.5 } },
  { match: /gemini-2\.5-flash-lite/, rate: { input: 0.1, output: 0.4 } },
  // Default edit tier.
  { match: /deepseek-v4-flash-0731/, rate: { input: 0.08, output: 0.15 } },
  { match: /deepseek-v4-flash/, rate: { input: 0.13, output: 0.26 } },
  { match: /mimo-v2\.6-flash/, rate: { input: 0.14, output: 0.28 } },
  { match: /mimo-v2\.5/, rate: { input: 0.12, output: 0.24 } },
  { match: /qwen3\.8-(omni-)?flash/, rate: { input: 0.15, output: 0.47 } },
  { match: /minimax-m3\.1-flash/, rate: { input: 0.15, output: 0.6 } },
  { match: /glm-5\.3-flash/, rate: { input: 0.15, output: 0.5 } },
  { match: /gpt-6-luna/, rate: { input: 0.1, output: 0.5 } },
  { match: /claude-haiku-5\.5/, rate: { input: 0.1, output: 0.5 } },
  { match: /gpt-5\.6-luna/, rate: { input: 0.2, output: 1.2 } },
  { match: /qwen3-coder-30b/, rate: { input: 0.15, output: 0.6 } },
  { match: /nemotron-3-super/, rate: { input: 0.15, output: 0.65 } },
  // Mid tier.
  { match: /deepseek-v4\.1-flash/, rate: { input: 0.3, output: 1.2 } },
  { match: /deepseek-v4-flash-vision/, rate: { input: 0.22, output: 0.65 } },
  { match: /deepseek-v4-pro/, rate: { input: 0.66, output: 1.98 } },
  { match: /qwen3-coder/, rate: { input: 0.22, output: 1.8 } },
  { match: /gemini-3-flash/, rate: { input: 0.5, output: 3.0 } },
  { match: /kimi-k2\.7-code/, rate: { input: 0.95, output: 4.0 } },
  { match: /kimi-k2\.5/, rate: { input: 0.6, output: 3.0 } },
  { match: /minimax-m3/, rate: { input: 0.3, output: 1.2 } },
  // The family people assume is cheap. It is not.
  { match: /llama-3\.3-70b/, rate: { input: 0.72, output: 0.72 } },
  { match: /llama-3\.1-70b/, rate: { input: 0.72, output: 0.72 } },
  { match: /gemini-3\.5-flash/, rate: { input: 1.5, output: 9.0 } },
  { match: /gemini-3\.[678]-flash/, rate: { input: 0.75, output: 3.75 } },
  { match: /mistral-large-3/, rate: { input: 0.5, output: 1.5 } },
  { match: /qwen3\.7-max/, rate: { input: 2.5, output: 7.5 } },
  { match: /glm-5\.2/, rate: { input: 0.8, output: 2.55 } },
  // Premium tier.
  { match: /claude-sonnet-5\.5/, rate: { input: 2.0, output: 10.0 } },
  { match: /claude-sonnet-5$/, rate: { input: 2.0, output: 10.0 } },
  { match: /gpt-6-sol/, rate: { input: 2.0, output: 10.0 } },
  { match: /gpt-6\.1-terra/, rate: { input: 1.0, output: 5.0 } },
  { match: /gemini-4-argon/, rate: { input: 2.0, output: 10.0 } },
  { match: /gemini-3\.1-pro/, rate: { input: 2.0, output: 12.0 } },
  { match: /kimi-k3/, rate: { input: 3.0, output: 15.0 } },
  { match: /claude-opus-5\.5/, rate: { input: 4.0, output: 20.0 } },
  { match: /gpt-5\.4$/, rate: { input: 2.5, output: 15.0 } },
  { match: /gpt-5\.3-codex/, rate: { input: 1.75, output: 14.0 } },
  { match: /gpt-5\.6-sol/, rate: { input: 4.0, output: 20.0 } },
  { match: /gpt-6-astra/, rate: { input: 10.0, output: 50.0 } },
  { match: /claude-fable-5/, rate: { input: 10.0, output: 50.0 } },
  { match: /gpt-5\.5$/, rate: { input: 5.0, output: 30.0 } },
  { match: /gpt-5\.5-pro/, rate: { input: 30.0, output: 180.0 } },
  { match: /gpt-5\.2-pro/, rate: { input: 21.0, output: 168.0 } }
];

function applyVariantModifiers(modelId: string, rate: ModelRate): ModelRate {
  if (/\bbatch\b/.test(modelId)) return { input: rate.input * BATCH_RATIO, output: rate.output * BATCH_RATIO };
  if (/(-fast$|highspeed|ultraspeed|turbo|lightning|pro-1)/.test(modelId)) {
    return { input: rate.input * FAST_RATIO, output: rate.output * FAST_RATIO };
  }
  return rate;
}

export function resolveRate(modelId: string): ModelRate {
  const id = (modelId || '').toLowerCase();
  for (const entry of PRICE_TABLE) {
    if (entry.match.test(id)) return applyVariantModifiers(id, entry.rate);
  }
  return UNKNOWN_RATE;
}

/** USD for one request at the given token split. */
export function costUsd(modelId: string, tokens: TokenSplit): number {
  const rate = resolveRate(modelId);
  return (rate.input * tokens.inputTokens + rate.output * tokens.outputTokens) / 1_000_000;
}

export function costRupees(modelId: string, tokens: TokenSplit): number {
  return roundRupees(costUsd(modelId, tokens) * USD_TO_INR);
}

/** Per-1M rates in rupees, for the Settings rate table. */
export function rupeeRates(modelId: string): ModelRate {
  const rate = resolveRate(modelId);
  return { input: rate.input * USD_TO_INR, output: rate.output * USD_TO_INR };
}

/** False when the id fell through to the premium assumption. */
export function isPriced(modelId: string): boolean {
  const id = (modelId || '').toLowerCase();
  return PRICE_TABLE.some((entry) => entry.match.test(id));
}

/** Two decimals is a paisa; below that the digits are noise. */
export function roundRupees(value: number): number {
  return Math.round(value * 100) / 100;
}
