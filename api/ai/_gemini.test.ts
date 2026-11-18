/**
 * BUG-07: Gemini requires strict user/model alternation. Tool observations
 * arrive as user turns and empty assistant turns are stripped upstream
 * (chat.ts), so `buildContents` must merge adjacent same-role entries.
 * Only `fetch` is stubbed — the assertions read the real outbound body.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { streamGemini } from './_gemini.js';
import type { ChatMessage, StreamRequest, StreamSink } from './_types.js';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function geminiSse(): Response {
  const frame = JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
  });
  return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

async function outbound(messages: ChatMessage[], overrides: Partial<StreamRequest> = {}) {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: BodyInit | null }) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return geminiSse();
  }) as unknown as typeof fetch;
  const sink: StreamSink = { delta() {}, reasoning() {}, toolCalls() {} };
  const request: StreamRequest = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'test-key-not-a-secret',
    messages,
    temperature: 0.5,
    signal: new AbortController().signal,
    ...overrides
  };
  try {
    const result = await streamGemini(request, sink);
    return { captured, result };
  } finally {
    globalThis.fetch = original;
  }
}

type Contents = Array<{ role: string; parts: Array<Record<string, unknown>> }>;
const contentsOf = (captured: Captured[]) => captured[0].body.contents as Contents;

test('BUG-07: [user, user, model, user, user] ships 3 alternating contents with combined parts', async () => {
  const { captured } = await outbound([
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: 'q4' }
  ]);
  const contents = contentsOf(captured);
  assert.deepEqual(contents.map((entry) => entry.role), ['user', 'model', 'user']);
  assert.deepEqual(contents[0].parts, [{ text: 'q1' }, { text: 'q2' }]);
  assert.deepEqual(contents[1].parts, [{ text: 'a1' }]);
  assert.deepEqual(contents[2].parts, [{ text: 'q3' }, { text: 'q4' }]);
});

test('BUG-07: a tool observation after a stripped empty assistant turn merges into the user turn', async () => {
  const { captured } = await outbound([
    { role: 'user', content: 'read src/App.tsx' },
    { role: 'user', content: '<tool_result name="read_file">export default function App() {}</tool_result>' }
  ]);
  const contents = contentsOf(captured);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, 'user');
  assert.deepEqual(contents[0].parts.map((part) => part.text), [
    'read src/App.tsx',
    '<tool_result name="read_file">export default function App() {}</tool_result>'
  ]);
});

test('BUG-07: consecutive model turns merge too', async () => {
  const { captured } = await outbound([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2' }
  ]);
  const contents = contentsOf(captured);
  assert.deepEqual(contents.map((entry) => entry.role), ['user', 'model']);
  assert.deepEqual(contents[1].parts, [{ text: 'a1' }, { text: 'a2' }]);
});

test('BUG-07: image parts keep their position inside a merged turn', async () => {
  const { captured } = await outbound([
    { role: 'user', content: 'look at this', imageData: 'data:image/png;base64,QUJD' },
    { role: 'user', content: 'and answer' }
  ]);
  const contents = contentsOf(captured);
  assert.equal(contents.length, 1);
  assert.deepEqual(contents[0].parts, [
    { text: 'look at this' },
    { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
    { text: 'and answer' }
  ]);
});

test('BUG-07: an already alternating history is untouched', async () => {
  const { captured } = await outbound([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ]);
  const contents = contentsOf(captured);
  assert.deepEqual(contents.map((entry) => entry.role), ['user', 'model', 'user']);
  contents.forEach((entry) => assert.equal(entry.parts.length, 1));
});

test('BUG-07: system turns stay in systemInstruction, never in the merged contents', async () => {
  const { captured } = await outbound([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' }
  ]);
  const contents = contentsOf(captured);
  assert.deepEqual(contents.map((entry) => entry.role), ['user']);
  assert.deepEqual(contents[0].parts, [{ text: 'q1' }, { text: 'q2' }]);
  const system = captured[0].body.systemInstruction as { parts: Array<{ text: string }> };
  assert.equal(system.parts[0].text, 'rules');
});