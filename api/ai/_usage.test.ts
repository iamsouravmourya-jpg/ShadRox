import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseDecoder } from '../../src/lib/sse.js';
import {
  mergeGeminiUsage,
  mergeOpenAiUsage,
  usageFields,
  type TokenUsage
} from './_types.js';

test('groq-style final chunk yields the exact split', () => {
  const usage = mergeOpenAiUsage({}, { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 });
  assert.equal(usage.total, 1280);
  assert.deepEqual(usageFields(usage), { inputTokens: 1200, outputTokens: 80 });
});

test('the last non-empty usage wins, field by field', () => {
  let usage: TokenUsage = {};
  const decoder = createSseDecoder(({ data }) => {
    if (!data || data === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    usage = mergeOpenAiUsage(usage, parsed?.usage);
  });
  decoder.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  decoder.push('data: {"choices":[],"usage":{"total_tokens":1300}}\n\n');
  decoder.push('data: {"choices":[],"usage":{}}\n\n');
  decoder.push('data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}\n\n');
  decoder.push('data: [DONE]\n\n');
  decoder.flush();

  assert.equal(usage.total, 1280);
  assert.deepEqual(usageFields(usage), { inputTokens: 1200, outputTokens: 80 });
});

test('a provider reporting only total_tokens leaves both parts undefined', () => {
  const usage = mergeOpenAiUsage({}, { total_tokens: 42 });
  assert.equal(usage.input, undefined);
  assert.equal(usage.output, undefined);
  assert.deepEqual(usageFields(usage), {});
});

test('gemini puts thoughts tokens on the output side', () => {
  const usage = mergeGeminiUsage(
    {},
    { promptTokenCount: 500, candidatesTokenCount: 100, thoughtsTokenCount: 700, totalTokenCount: 1350 }
  );
  // Gemini counts thoughts into the total itself; the split must not recompute it.
  assert.equal(usage.total, 1350);
  assert.deepEqual(usageFields(usage), { inputTokens: 500, outputTokens: 800 });
});

test('gemini without thoughts keeps candidates as the whole output', () => {
  const usage = mergeGeminiUsage(
    {},
    { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
  );
  assert.deepEqual(usageFields(usage), { inputTokens: 10, outputTokens: 20 });
});

test('gemini usage from a raw SSE body keeps the last reported fields', () => {
  let usage: TokenUsage = {};
  const decoder = createSseDecoder(({ data }) => {
    if (!data || data === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    usage = mergeGeminiUsage(usage, parsed?.usageMetadata);
  });
  decoder.push('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n');
  decoder.push('data: {"usageMetadata":{"promptTokenCount":900}}\n\n');
  decoder.push(
    'data: {"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":40,"thoughtsTokenCount":60,"totalTokenCount":1000}}\n\n'
  );
  decoder.flush();

  assert.deepEqual(usageFields(usage), { inputTokens: 900, outputTokens: 100 });
  assert.equal(usage.total, 1000);
});

test('openai prompt_tokens_details captures cached_tokens', () => {
  const usage = mergeOpenAiUsage(
    {},
    {
      prompt_tokens: 2000,
      completion_tokens: 150,
      total_tokens: 2150,
      prompt_tokens_details: { cached_tokens: 1600 }
    }
  );
  assert.deepEqual(usageFields(usage), { inputTokens: 2000, outputTokens: 150, cachedInputTokens: 1600 });
});

test('gemini usage metadata captures cachedContentTokenCount', () => {
  const usage = mergeGeminiUsage(
    {},
    {
      promptTokenCount: 1500,
      candidatesTokenCount: 200,
      totalTokenCount: 1700,
      cachedContentTokenCount: 1200
    }
  );
  assert.deepEqual(usageFields(usage), { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 1200 });
});

