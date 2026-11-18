import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiToolCallCollector, geminiFunctionParameters, nativeToolDefinitions, rejectsNativeTools, rejectsToolCall } from './_toolCalls.js';
import { streamGroq } from './_openai.js';
import { streamGemini } from './_gemini.js';
import { streamCustomEndpoint } from './_compatible.js';
import type { StreamRequest, StreamSink, ToolCallEntry } from './_types.js';

test('OpenAI tool call deltas are reassembled in provider index order', () => {
  const collector = new OpenAiToolCallCollector();
  collector.add([
    { index: 1, id: 'call_b', function: { name: 'read_', arguments: '{"path":' } },
    { index: 0, id: 'call_a', function: { name: 'finish', arguments: '{"summary":"done"}' } }
  ]);
  collector.add([
    { index: 1, function: { name: 'file', arguments: '"src/App.tsx"}' } }
  ]);

  assert.deepEqual(collector.values(), [
    { id: 'call_a', name: 'finish', arguments: '{"summary":"done"}' },
    { id: 'call_b', name: 'read_file', arguments: '{"path":"src/App.tsx"}' }
  ]);
});

test('incomplete OpenAI tool calls without a name are ignored', () => {
  const collector = new OpenAiToolCallCollector();
  collector.add([{ index: 0, function: { arguments: '{}' } }]);
  assert.deepEqual(collector.values(), []);
});

test('provider tool rejection is recognized for fallback', () => {
  assert.equal(rejectsNativeTools('Unknown parameter: tools'), true);
  assert.equal(rejectsNativeTools('Model does not support function_call'), true);
  assert.equal(rejectsNativeTools('Invalid API key'), false);
});

test('native tool definitions are validated before forwarding upstream', () => {
  assert.deepEqual(nativeToolDefinitions(undefined), undefined);
  assert.deepEqual(nativeToolDefinitions([{
    name: 'read_file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }]), [{
    name: 'read_file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }]);

  assert.throws(() => nativeToolDefinitions([{
    name: 'read file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: {} }
  }]), /Invalid tool definition/);
});

test('Gemini schemas drop unsupported keys and upper-case types', () => {
  const cleaned = geminiFunctionParameters({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path.', examples: ['a.ts'] },
      start_line: { type: 'integer', minimum: 1 },
      flags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } }
    },
    required: ['path', 'ghost'],
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema'
  });
  assert.deepEqual(cleaned, {
    type: 'OBJECT',
    properties: {
      path: { type: 'STRING', description: 'File path.' },
      start_line: { type: 'INTEGER', minimum: 1 },
      flags: { type: 'ARRAY', items: { type: 'STRING', enum: ['x', 'y'] } }
    },
    required: ['path']
  });
});

test('a no-argument Gemini tool is declared without parameters', () => {
  // Gemini 400s an OBJECT schema with empty properties, so the whole
  // parameters block must disappear rather than ship an empty object.
  assert.equal(geminiFunctionParameters({ type: 'object', properties: {}, additionalProperties: false }), undefined);
});

test('Groq tool-call validation failures are recognized for the tools-drop retry', () => {
  assert.equal(
    rejectsToolCall("Tool call validation failed: attempted to call tool 'create_file' which was not in request.tools"),
    true
  );
  assert.equal(rejectsToolCall('Rate limit reached for model llama'), false);
  assert.equal(rejectsToolCall('Invalid API key'), false);
});

/* ------------------------------------------------------------------ *
 * Adapter integration: the REAL collectors/parsers driven with raw SSE
 * byte fixtures (only `fetch` is stubbed — no ShadRox module is mocked),
 * including output-limit truncation mid tool arguments.
 * ------------------------------------------------------------------ */

const frame = (payload: unknown) => JSON.stringify(payload);

function sseResponse(frames: string[]): Response {
  const body = frames.map((entry) => `data: ${entry}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function withFetch<T>(response: Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function baseRequest(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    apiKey: 'test-key-not-a-secret',
    messages: [{ role: 'user', content: 'write the file' }],
    temperature: 0.5,
    signal: new AbortController().signal,
    toolDefinitions: [{
      name: 'create_file',
      description: 'Create one file.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }
    }],
    ...overrides
  };
}

function collectingSink() {
  const deltas: string[] = [];
  const calls: ToolCallEntry[][] = [];
  const sink: StreamSink = {
    delta: (text) => { deltas.push(text); },
    reasoning: () => {},
    toolCalls: (entries) => { calls.push(entries); }
  };
  return { deltas, calls, sink };
}

/** A create_file call whose arguments JSON is cut mid-string by the output limit. */
const cutCallFrames = [
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_file', arguments: '{"path":"src/a.ts","content":"line1\n' } }] } }] }),
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'line2' } }] }, finish_reason: 'length' }] }),
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
];

test('a Groq tool call cut mid-arguments by finish_reason=length is forwarded whole with the length reason', async () => {
  const { calls, sink } = collectingSink();
  const result = await withFetch(sseResponse(cutCallFrames), () => streamGroq(baseRequest(), sink));
  assert.equal(result.finishReason, 'length');
  assert.equal(result.tokens, 30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].id, 'call_1');
  assert.equal(calls[0][0].name, 'create_file');
  // The fragments are concatenated verbatim; the truncated JSON stays invalid
  // so the client can mark it honestly instead of guessing missing fields.
  assert.equal(calls[0][0].arguments, '{"path":"src/a.ts","content":"line1\nline2');
  assert.throws(() => JSON.parse(calls[0][0].arguments));
});

test('a custom endpoint tool call cut by finish_reason=length keeps the partial arguments and the reason', async () => {
  const { calls, sink } = collectingSink();
  const result = await withFetch(sseResponse(cutCallFrames), () =>
    streamCustomEndpoint(baseRequest({ provider: 'custom', model: 'some/model', baseUrl: 'https://openrouter.ai/api/v1' }), sink));
  assert.equal(result.finishReason, 'length');
  assert.equal(calls[0][0].name, 'create_file');
  assert.throws(() => JSON.parse(calls[0][0].arguments));
});

test('Groq length with an empty reply says the output limit was hit, not "empty response"', async () => {
  const { sink } = collectingSink();
  const response = sseResponse([
    frame({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    frame({ choices: [], usage: { total_tokens: 5 } })
  ]);
  await assert.rejects(
    () => withFetch(response, () => streamGroq(baseRequest(), sink)),
    /output limit/
  );
});

test('Gemini MAX_TOKENS with partial text forwards the finish reason to the client', async () => {
  const { deltas, sink } = collectingSink();
  const response = sseResponse([
    frame({
      candidates: [{ content: { parts: [{ text: 'Partial answer' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    })
  ]);
  const result = await withFetch(response, () =>
    streamGemini(baseRequest({ provider: 'gemini', model: 'gemini-2.5-flash' }), sink));
  assert.deepEqual(deltas, ['Partial answer']);
  assert.equal(result.finishReason, 'MAX_TOKENS');
  assert.equal(result.tokens, 15);
});

test('Gemini MAX_TOKENS with an empty reply says the output limit was hit (OpenAI-family parity)', async () => {
  const { sink } = collectingSink();
  const response = sseResponse([frame({ candidates: [{ finishReason: 'MAX_TOKENS' }] })]);
  await assert.rejects(
    () => withFetch(response, () => streamGemini(baseRequest({ provider: 'gemini', model: 'gemini-2.5-flash' }), sink)),
    /output limit/
  );
});

test('a Gemini native function call survives the SSE parser as a complete tool call', async () => {
  const { calls, sink } = collectingSink();
  const response = sseResponse([
    frame({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'create_file', args: { path: 'src/a.ts', content: 'const a = 1;' } } }] },
        finishReason: 'STOP'
      }]
    })
  ]);
  const result = await withFetch(response, () =>
    streamGemini(baseRequest({ provider: 'gemini', model: 'gemini-2.5-flash' }), sink));
  assert.equal(result.finishReason, 'STOP');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'create_file');
  assert.deepEqual(JSON.parse(calls[0][0].arguments), { path: 'src/a.ts', content: 'const a = 1;' });
});
