import assert from 'node:assert/strict';
import test from 'node:test';
import { streamGroq } from '../api/ai/_openai.ts';
import { streamGemini } from '../api/ai/_gemini.ts';
import type { StreamRequest } from '../api/ai/_types.ts';

const originalFetch = globalThis.fetch;

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    provider: 'groq',
    model: 'test-model',
    apiKey: 'test-key',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    signal: new AbortController().signal,
    ...overrides
  };
}

function collectors() {
  const deltas: string[] = [];
  const reasoning: string[] = [];
  return {
    deltas,
    reasoning,
    sink: {
      delta: (text: string) => deltas.push(text),
      reasoning: (text: string) => reasoning.push(text)
    }
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('groq adapter streams content and usage from split SSE chunks', async () => {
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n',
      'data: [DONE]\n\n'
    ])) as typeof fetch;

  const { deltas, sink } = collectors();
  const result = await streamGroq(request(), sink);

  assert.equal(deltas.join(''), 'Hello');
  assert.equal(result.tokens, 7);
  assert.equal(result.finishReason, 'stop');
});

test('groq adapter forwards reasoning deltas separately', async () => {
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"checking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: [DONE]\n\n'
    ])) as typeof fetch;

  const { deltas, reasoning, sink } = collectors();
  await streamGroq(request(), sink);

  assert.deepEqual(reasoning, ['checking']);
  assert.equal(deltas.join(''), 'done');
});

test('groq adapter rejects an empty stream', async () => {
  globalThis.fetch = (async () => sseResponse(['data: [DONE]\n\n'])) as typeof fetch;
  await assert.rejects(() => streamGroq(request(), collectors().sink), /empty response/i);
});

test('gemini adapter separates thought parts from visible text', async () => {
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":9}}\n\n'
    ])) as typeof fetch;

  const { deltas, reasoning, sink } = collectors();
  const result = await streamGemini(request({ provider: 'gemini' }), sink);

  assert.deepEqual(reasoning, ['thinking...']);
  assert.equal(deltas.join(''), 'answer');
  assert.equal(result.tokens, 9);
  assert.equal(result.finishReason, 'STOP');
});

test('upstream fetch retries a retryable status before streaming', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  }) as typeof fetch;

  const { deltas, sink } = collectors();
  await streamGroq(request(), sink);

  assert.equal(calls, 2);
  assert.equal(deltas.join(''), 'ok');
});
