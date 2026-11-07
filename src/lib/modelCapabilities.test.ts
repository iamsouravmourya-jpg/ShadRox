import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from './modelCapabilities.js';

// ── Gemini provider ───────────────────────────────────────────────────────────

test('gemini pro/ultra/argon → 2M context window', () => {
  assert.equal(resolveContextWindow('gemini', 'gemini-1.5-pro'),    2_000_000);
  assert.equal(resolveContextWindow('gemini', 'gemini-4-argon'),    2_000_000);
  assert.equal(resolveContextWindow('gemini', 'gemini-ultra'),      2_000_000);
});

test('gemini flash-lite → 1M context window', () => {
  assert.equal(resolveContextWindow('gemini', 'gemini-2.5-flash-lite'), 1_000_000);
});

test('gemini flash / thinking → 1,048,576 context window', () => {
  assert.equal(resolveContextWindow('gemini', 'gemini-2.0-flash'),    1_048_576);
  assert.equal(resolveContextWindow('gemini', 'gemini-2.5-thinking'), 1_048_576);
});

test('gemini fallback → 131,072', () => {
  assert.equal(resolveContextWindow('gemini', 'gemini-1.0-something-else'), 131_072);
});

// ── Groq provider ─────────────────────────────────────────────────────────────

test('groq large model families → 131,072', () => {
  assert.equal(resolveContextWindow('groq', 'llama-3.1-70b-versatile'),  131_072);
  assert.equal(resolveContextWindow('groq', 'llama-4-scout-17b'),        131_072);
  assert.equal(resolveContextWindow('groq', 'deepseek-r1-distill-32b'),  131_072);
  assert.equal(resolveContextWindow('groq', 'qwen3-72b'),                131_072);
});

test('groq unknown model → 32,768 fallback', () => {
  // The groq catch-all pattern `/./ ` matches everything, so any unrecognized
  // model lands on the last entry which is 32,768.
  assert.equal(resolveContextWindow('groq', 'some-unknown-groq-model'), 32_768);
});

// ── Custom provider ───────────────────────────────────────────────────────────

test('custom endpoint with claude/anthropic pattern → 200,000', () => {
  assert.equal(resolveContextWindow('custom', 'claude-3-5-sonnet-20241022'), 200_000);
  assert.equal(resolveContextWindow('custom', 'anthropic/claude-opus-4'),    200_000);
});

test('custom endpoint with GPT-4o/4.1/5 → 128,000', () => {
  assert.equal(resolveContextWindow('custom', 'gpt-4o'),      128_000);
  assert.equal(resolveContextWindow('custom', 'gpt-4.1'),     128_000);
  assert.equal(resolveContextWindow('custom', 'gpt-5'),       128_000);
  assert.equal(resolveContextWindow('custom', 'chatgpt-4o'),  128_000);
});

test('custom endpoint with deepseek → 128,000', () => {
  assert.equal(resolveContextWindow('custom', 'deepseek-chat'), 128_000);
});

test('custom endpoint with deepseek-r1/reasoner → 64,000', () => {
  assert.equal(resolveContextWindow('custom', 'deepseek-r1'),        64_000);
  assert.equal(resolveContextWindow('custom', 'deepseek-reasoner'),  64_000);
});

test('custom gemini flash → the published metadata number, not the 1M guess', () => {
  // Wiring ./modelMetadata.ts in front of the pattern tables changed exactly
  // one expectation in this file: the hand-written /gemini.*flash/ guess was
  // 1,000,000, the published Gemini 2.5 Flash window is 1,048,576. The table
  // wins wherever it has a row; every pattern below still serves the models the
  // table does not name (see ./modelMetadata.test.ts for the fallback tests).
  assert.equal(resolveContextWindow('custom', 'gemini-2.5-flash'), 1_048_576);
  // The lite sibling has no row, so its pattern guess is untouched.
  assert.equal(resolveContextWindow('custom', 'gemini-2.5-flash-lite'), 1_000_000);
});

test('custom gemini non-flash pattern → 131,072', () => {
  assert.equal(resolveContextWindow('custom', 'gemini-1.0-pro'), 131_072);
});

test('custom qwen3/llama-3.x families → 131,072', () => {
  assert.equal(resolveContextWindow('custom', 'qwen3-72b'),          131_072);
  assert.equal(resolveContextWindow('custom', 'llama-3.1-70b'),      131_072);
  assert.equal(resolveContextWindow('custom', 'llama-4-maverick'),   131_072);
});

test('custom gpt-3.5 → 16,385', () => {
  assert.equal(resolveContextWindow('custom', 'gpt-3.5-turbo'), 16_385);
});

test('custom gpt-4-turbo → 32,768', () => {
  assert.equal(resolveContextWindow('custom', 'gpt-4-turbo'), 32_768);
});

// ── DEFAULT_CONTEXT_WINDOW ────────────────────────────────────────────────────

test('completely unknown provider returns DEFAULT_CONTEXT_WINDOW', () => {
  // Casting to any so TS does not complain about an unsupported provider id.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = resolveContextWindow('unknown-provider' as any, 'some-model');
  assert.equal(result, DEFAULT_CONTEXT_WINDOW);
});

test('DEFAULT_CONTEXT_WINDOW is a positive integer', () => {
  assert.ok(Number.isInteger(DEFAULT_CONTEXT_WINDOW));
  assert.ok(DEFAULT_CONTEXT_WINDOW > 0);
});

// ── Case-insensitivity ────────────────────────────────────────────────────────

test('resolveContextWindow is case-insensitive', () => {
  assert.equal(
    resolveContextWindow('custom', 'Claude-3-5-Sonnet'),
    resolveContextWindow('custom', 'claude-3-5-sonnet'),
  );
  assert.equal(
    resolveContextWindow('gemini', 'Gemini-2.5-Flash-Lite'),
    resolveContextWindow('gemini', 'gemini-2.5-flash-lite'),
  );
});

// ── resolveCapabilities ───────────────────────────────────────────────────────

import { resolveCapabilities, DEFAULT_MAX_OUTPUT } from './modelCapabilities.js'

test('resolveCapabilities returns contextWindow and maxOutput for gemini flash', () => {
  const cap = resolveCapabilities('gemini', 'gemini-2.5-flash')
  assert.equal(cap.contextWindow, 1_048_576)
  assert.equal(cap.maxOutput, 8_192)
})

test('resolveCapabilities returns maxOutput for claude custom endpoint', () => {
  const cap = resolveCapabilities('custom', 'claude-3-5-sonnet')
  assert.equal(cap.contextWindow, 200_000)
  assert.equal(cap.maxOutput, 8_096)
})

test('resolveCapabilities for unknown provider has no maxOutput', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cap = resolveCapabilities('unknown-provider' as any, 'some-model')
  assert.equal(cap.contextWindow, DEFAULT_CONTEXT_WINDOW)
  assert.equal(cap.maxOutput, undefined)
})

test('resolveCapabilities groq small model has maxOutput 4096', () => {
  const cap = resolveCapabilities('groq', 'some-tiny-unknown-groq-model')
  assert.equal(cap.maxOutput, 4_096)
})

test('DEFAULT_MAX_OUTPUT is a positive integer', () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_OUTPUT))
  assert.ok(DEFAULT_MAX_OUTPUT > 0)
})

// ── checkCapabilities (S07) ───────────────────────────────────────────────────

import { checkCapabilities, routeNeedsRefit, type ModelCapabilities } from './modelCapabilities.js'

test('an unverified feature fails closed, it is not treated as present', () => {
  const caps: ModelCapabilities = { contextWindow: 100_000 }
  const check = checkCapabilities(caps, { toolCalls: true })
  assert.equal(check.satisfied, false)
  assert.deepEqual(check.unknown, ['toolCalls'])
  assert.deepEqual(check.missing, [])
})

test('a feature the model explicitly lacks is reported as missing', () => {
  const caps: ModelCapabilities = { contextWindow: 100_000, toolCalls: false }
  const check = checkCapabilities(caps, { toolCalls: true })
  assert.equal(check.satisfied, false)
  assert.deepEqual(check.missing, ['toolCalls'])
  assert.deepEqual(check.unknown, [])
})

test('a verified feature satisfies the requirement', () => {
  const caps: ModelCapabilities = { contextWindow: 200_000, toolCalls: true, structuredResponses: true }
  assert.equal(checkCapabilities(caps, { toolCalls: true, structuredResponses: true }).satisfied, true)
  // A requirement that is not asked for never affects the result.
  assert.equal(checkCapabilities(caps, {}).satisfied, true)
})

test('a payload too big for the window is a missing capability, not a silent trim', () => {
  const caps: ModelCapabilities = { contextWindow: 32_000 }
  const check = checkCapabilities(caps, { minContextWindow: 100_000 })
  assert.equal(check.satisfied, false)
  assert.deepEqual(check.missing, ['contextWindow'])
})

test('a route change to a smaller window requires a refit', () => {
  const big: ModelCapabilities = { contextWindow: 1_000_000, maxOutput: 8_192 }
  const small: ModelCapabilities = { contextWindow: 131_072, maxOutput: 8_192 }
  assert.equal(routeNeedsRefit(big, small), true)
  assert.equal(routeNeedsRefit(small, small), false)
  const smallerOutput: ModelCapabilities = { contextWindow: 131_072, maxOutput: 4_096 }
  assert.equal(routeNeedsRefit(small, smallerOutput), true)
})
