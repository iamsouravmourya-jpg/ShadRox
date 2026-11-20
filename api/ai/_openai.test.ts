/**
 * Groq validates a model's tool support when generation starts, not when the
 * request is parsed: a model without tool calling answers HTTP 200 and then
 * streams `data: {"error": ...}`. The HTTP-level tools-off ladder never sees
 * it, so the adapter must recover from the in-stream rejection itself — once,
 * and only while no token reached the caller.
 * Only `fetch` is stubbed — the assertions read the real outbound bodies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { streamGroq } from './_openai.js';
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

/** The shape Groq uses when the model itself cannot do tool calling. */
const streamedToolRejection = () =>
  sse([{ error: { message: '`tool calling` is not supported with this model', type: 'invalid_request_error' } }]);

const rejected = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const toolDef = [{
  name: 'read_file',
  description: 'Read one file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } } }
}];

async function outbound(respond: (attempt: number) => Response, overrides: Partial<StreamRequest> = {}) {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: BodyInit | null }) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return respond(captured.length - 1);
  }) as unknown as typeof fetch;
  const sink: StreamSink = { delta() {}, reasoning() {}, toolCalls() {} };
  const request: StreamRequest = {
    provider: 'groq',
    model: 'allam-2-7b',
    apiKey: 'test-key-not-a-secret',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    signal: new AbortController().signal,
    ...overrides
  };
  try {
    const result = await streamGroq(request, sink);
    return { captured, result: result as any, error: null as unknown };
  } catch (error) {
    return { captured, result: null as any, error };
  } finally {
    globalThis.fetch = original;
  }
}

test('a tools rejection inside a 200 stream buys one tools-off resend', async () => {
  const { captured, result, error } = await outbound(
    (attempt) => (attempt === 0 ? streamedToolRejection() : okWithUsage()),
    { toolDefinitions: toolDef }
  );
  assert.equal(error, null);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.ok(Array.isArray(captured[0].body.tools), 'the first request still offers tools');
  assert.equal('tools' in captured[1].body, false, 'the resend never offers them again');
  assert.equal('tool_choice' in captured[1].body, false);
  assert.equal(captured[1].body.model, 'allam-2-7b');
  assert.deepEqual(result.droppedFeatures, ['tools']);
  assert.equal(result.tokens, 30);
  assert.equal(result.attempts, 2);
});

test('a reasoning_effort rejection first does not strand the tools rung', async () => {
  // Groq reports reasoning_effort before tool support for the same model, so a
  // one-pass ladder dropped the effort and resent all 35 tools into the very
  // next rejection without ever reaching the tools rung.
  const { captured, result, error } = await outbound((attempt) => {
    if (attempt === 0) return rejected(400, '`reasoning_effort` is not supported with this model');
    if (attempt === 1) return rejected(400, '`tool calling` is not supported with this model');
    return okWithUsage();
  }, { toolDefinitions: toolDef, thinking: 'high' });
  assert.equal(error, null);
  assert.equal(captured.length, 3);
  assert.equal(captured[0].body.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in captured[1].body, false);
  assert.ok(Array.isArray(captured[1].body.tools), 'only the effort is dropped first');
  assert.equal('tools' in captured[2].body, false);
  assert.deepEqual(result.droppedFeatures, ['reasoning_effort', 'tools']);
  assert.equal(result.tokens, 30);
});

test('a tools-off resend never replays text the user already received', async () => {
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

test('an in-stream error unrelated to tools is never resent', async () => {
  const { captured, error } = await outbound(
    () => sse([{ error: { message: 'Invalid API key provided', type: 'invalid_request_error' } }]),
    { toolDefinitions: toolDef }
  );
  assert.equal(captured.length, 1);
  assert.ok(error instanceof UpstreamError);
  assert.match((error as UpstreamError).message, /Invalid API key/);
});

test('with no tools in the request an in-stream error surfaces immediately', async () => {
  const { captured, error } = await outbound(() => streamedToolRejection());
  assert.equal(captured.length, 1);
  assert.ok(error instanceof UpstreamError);
});
