/**
 * BUG-12: `stream_options` is optional in the OpenAI spec; local servers
 * (vLLM, older Ollama, LM Studio) reject it with 400/422. The adapter must
 * resend ONCE without it, never replay auth failures, and degrade usage to
 * the text estimate when the resent stream reports none.
 * Only `fetch` is stubbed — the assertions read the real outbound bodies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../_http.js';
import { streamCustomEndpoint } from './_compatible.js';
import { UpstreamError, type StreamRequest, type StreamSink } from './_types.js';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const okWithUsage = () => sse([
  { choices: [{ delta: { content: 'hello world' }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }
]);

const okWithoutUsage = () => sse([
  { choices: [{ delta: { content: 'hello world' }, finish_reason: 'stop' }] }
]);

const rejected = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });

async function outbound(respond: (attempt: number) => Response, overrides: Partial<StreamRequest> = {}) {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  const localBackend = process.env.SHADROX_LOCAL_BACKEND;
  // The desktop loopback backend is the deployment that talks to local runners.
  process.env.SHADROX_LOCAL_BACKEND = '1';
  globalThis.fetch = (async (input: unknown, init?: { body?: BodyInit | null }) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return respond(captured.length - 1);
  }) as unknown as typeof fetch;
  const sink: StreamSink = { delta() {}, reasoning() {}, toolCalls() {} };
  const request: StreamRequest = {
    provider: 'custom',
    model: 'local/model',
    apiKey: 'test-key-not-a-secret',
    baseUrl: 'http://127.0.0.1:8000/v1',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    signal: new AbortController().signal,
    ...overrides
  };
  try {
    const result = await streamCustomEndpoint(request, sink);
    return { captured, result: result as any, error: null as unknown };
  } catch (error) {
    return { captured, result: null as any, error };
  } finally {
    globalThis.fetch = original;
    if (localBackend === undefined) delete process.env.SHADROX_LOCAL_BACKEND;
    else process.env.SHADROX_LOCAL_BACKEND = localBackend;
  }
}

test('BUG-12: a 400 naming stream_options buys one resend without it, tools and usage intact', async () => {
  const { captured, result, error } = await outbound(
    (attempt) => (attempt === 0 ? rejected(400, "Unknown parameter: 'stream_options'.") : okWithUsage()),
    {
      toolDefinitions: [{
        name: 'read_file',
        description: 'Read one file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }]
    }
  );
  assert.equal(error, null);
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[0].body.stream_options, { include_usage: true });
  assert.equal('stream_options' in captured[1].body, false);
  assert.deepEqual(captured[1].body.tools, captured[0].body.tools);
  assert.equal(captured[1].body.temperature, 0.5);
  assert.equal(result.tokens, 30);
  assert.equal(result.usageSource, 'provider');
  assert.deepEqual(result.droppedFeatures, ['stream_options']);
});

test('BUG-12: a 422 with a field-less validation body still retries once (vLLM/FastAPI)', async () => {
  const fastApi = new Response(
    JSON.stringify({ detail: [{ loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] }),
    { status: 422, headers: { 'content-type': 'application/json' } }
  );
  const { captured, result, error } = await outbound((attempt) => (attempt === 0 ? fastApi : okWithUsage()));
  assert.equal(error, null);
  assert.equal(captured.length, 2);
  assert.equal('stream_options' in captured[1].body, false);
  assert.equal(result.usageSource, 'provider');
  assert.deepEqual(result.droppedFeatures, ['stream_options']);
});

test('BUG-12: usage degrades to the estimate when the resent stream reports none', async () => {
  const { captured, result, error } = await outbound(
    (attempt) => (attempt === 0 ? rejected(400, 'stream_options is not supported') : okWithoutUsage())
  );
  assert.equal(error, null);
  assert.equal(captured.length, 2);
  assert.equal(result.usageSource, 'estimated');
  assert.equal(result.tokens, estimateTokens('hello world'));
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.outputTokens, undefined);
  assert.deepEqual(result.droppedFeatures, ['stream_options']);
});

test('BUG-12: 401 and 403 never trigger the stream_options retry', async () => {
  for (const status of [401, 403]) {
    const { captured, error } = await outbound(() => rejected(status, 'Invalid API key'));
    assert.equal(captured.length, 1);
    assert.equal('stream_options' in captured[0].body, true);
    assert.ok(error instanceof UpstreamError);
    assert.equal((error as UpstreamError).status, status);
  }
});

test('BUG-12: an auth-shaped 400 body is not replayed', async () => {
  const { captured, error } = await outbound(() => rejected(400, 'Invalid API key provided'));
  assert.equal(captured.length, 1);
  assert.ok(error instanceof UpstreamError);
  assert.equal((error as UpstreamError).status, 400);
});

test('BUG-12: a second rejection ends the turn — never more than one stream_options retry', async () => {
  const { captured, error } = await outbound(() => rejected(400, 'Malformed request body'));
  assert.equal(captured.length, 2);
  assert.equal('stream_options' in captured[0].body, true);
  assert.equal('stream_options' in captured[1].body, false);
  assert.ok(error instanceof UpstreamError);
  assert.equal((error as UpstreamError).status, 400);
});

test('BUG-12: a server that accepts stream_options is never resent', async () => {
  const { captured, result, error } = await outbound(() => okWithUsage());
  assert.equal(error, null);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].body.stream_options, { include_usage: true });
  assert.equal(result.droppedFeatures, undefined);
  assert.equal(result.usageSource, 'provider');
});

test('BUG-12: temperature and stream_options rejections stack without re-adding dropped fields', async () => {
  const { captured, result, error } = await outbound((attempt) => {
    if (attempt === 0) return rejected(400, 'temperature is not supported by this model');
    if (attempt === 1) return rejected(400, "Unknown parameter: 'stream_options'");
    return okWithUsage();
  });
  assert.equal(error, null);
  assert.equal(captured.length, 3);
  assert.equal('temperature' in captured[2].body, false);
  assert.equal('stream_options' in captured[2].body, false);
  assert.deepEqual(result.droppedFeatures, ['temperature', 'stream_options']);
  assert.equal(result.attempts, 3);
});

const toolDef = [{
  name: 'read_file',
  description: 'Read one file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } } }
}];

/** The shape gateways use when they reject a model's tool support mid-stream. */
const streamedError = (message: string) => sse([{ error: { message, type: 'invalid_request_error' } }]);

test('a temperature rejection first does not strand the tools rung', async () => {
  // Gateways name one unsupported field per rejection; the tools rung has to be
  // re-checked after the temperature resend instead of being walked past.
  const { captured, result, error } = await outbound((attempt) => {
    if (attempt === 0) return rejected(400, 'temperature is not supported by this model');
    if (attempt === 1) return rejected(400, '`tool calling` is not supported with this model');
    return okWithUsage();
  }, { toolDefinitions: toolDef });
  assert.equal(error, null);
  assert.equal(captured.length, 3);
  assert.equal('temperature' in captured[1].body, false);
  assert.ok(Array.isArray(captured[1].body.tools), 'only the temperature is dropped first');
  assert.equal('tools' in captured[2].body, false);
  assert.deepEqual(result.droppedFeatures, ['temperature', 'tools']);
  assert.equal(result.tokens, 30);
});

test('a tools rejection inside a 200 stream buys one tools-off resend', async () => {
  // Groq validates tool support at generation time, so the rejection arrives as
  // an SSE `error` frame on an already-200 response — the HTTP ladder is blind.
  const { captured, result, error } = await outbound(
    (attempt) => attempt === 0
      ? streamedError('`tool calling` is not supported with this model')
      : okWithUsage(),
    { toolDefinitions: toolDef }
  );
  assert.equal(error, null);
  assert.equal(captured.length, 2);
  assert.ok(Array.isArray(captured[0].body.tools), 'the first request still offers tools');
  assert.equal('tools' in captured[1].body, false, 'the resend never offers them again');
  assert.equal(captured[1].body.temperature, 0.5, 'only tools are dropped');
  assert.deepEqual(result.droppedFeatures, ['tools']);
  assert.equal(result.tokens, 30);
});

test('a tools-off resend never replays text the user already received', async () => {
  // One content delta escaped before the rejection, so a resend would duplicate
  // it: the error must surface instead.
  const partial = sse([
    { choices: [{ delta: { content: 'partial answer' } }] },
    { error: { message: '`tool calling` is not supported with this model', type: 'invalid_request_error' } }
  ]);
  const { captured, error } = await outbound((attempt) => (attempt === 0 ? partial : okWithUsage()), {
    toolDefinitions: toolDef
  });
  assert.equal(captured.length, 1);
  assert.ok(error instanceof UpstreamError);
  assert.match((error as UpstreamError).message, /tool calling/);
});

test('an unrelated in-stream error is not resent', async () => {
  const { captured, error } = await outbound(
    () => streamedError('Invalid API key provided'),
    { toolDefinitions: toolDef }
  );
  assert.equal(captured.length, 1);
  assert.ok(error instanceof UpstreamError);
  assert.match((error as UpstreamError).message, /Invalid API key/);
});