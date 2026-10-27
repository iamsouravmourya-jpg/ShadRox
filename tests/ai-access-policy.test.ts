import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { readJsonBody, sanitizeErrorMessage } from '../api/_http.ts';
import { FIELD_LIMITS, RequestRejectedError } from '../api/_validate.ts';
import { budgetRequest } from '../api/ai/_budget.ts';
import { resolveKeyAccess, sharedKeyPathEnabled } from '../api/ai/_access.ts';
import { streamGemini } from '../api/ai/_gemini.ts';
import {
  SHARED_KEY_OUTPUT_CHAR_CEILINGS,
  SHARED_KEY_RATE_LIMITS,
  checkSharedKeySpend,
  fitChunk,
  outputCeiling,
  resetSpendBuckets
} from '../api/ai/_spendGuard.ts';
import chatHandler from '../api/ai/chat.ts';
import fimHandler from '../api/ai/fim.ts';
import refineHandler from '../api/prompt/refine.ts';
import byokHandler from '../api/byok/validate.ts';
import type { ApiRequest, ApiResponse } from '../api/_http.ts';

const originalFetch = globalThis.fetch;
const USER_KEY = 'AIzaUserKey0123456789abcdef';

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Records every upstream call so a test can prove the route failed *before* spending. */
function captureFetch(makeResponse: () => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const requestInit = init as { headers?: Record<string, string>; body?: unknown } | undefined;
    const headers = Object.entries(requestInit?.headers ?? {}).reduce<Record<string, string>>(
      (acc, [key, value]) => ({ ...acc, [key.toLowerCase()]: String(value) }),
      {}
    );
    calls.push({ url: String(input), headers, body: String(requestInit?.body ?? '') });
    return makeResponse();
  }) as typeof fetch;
  return calls;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        lines.forEach((line) => controller.enqueue(encoder.encode(line)));
        controller.close();
      }
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

class FakeResponse extends EventEmitter {
  statusCode = 0;
  ended = false;
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];

  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  write(chunk: string): void {
    this.chunks.push(String(chunk));
  }

  end(chunk?: string): void {
    if (chunk) this.chunks.push(String(chunk));
    this.ended = true;
    this.emit('close');
  }

  get writableEnded(): boolean {
    return this.ended;
  }

  get text(): string {
    return this.chunks.join('');
  }

  get json(): Record<string, unknown> {
    return JSON.parse(this.text) as Record<string, unknown>;
  }
}

async function invoke(
  handler: (req: ApiRequest, res: ApiResponse) => Promise<void>,
  body: unknown,
  options: { remoteAddress?: string } = {}
): Promise<FakeResponse> {
  const req = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: options.remoteAddress ?? '203.0.113.7' },
    body
  } as unknown as ApiRequest;
  const res = new FakeResponse();
  await handler(req, res as unknown as ApiResponse);
  return res;
}

function asyncIterableRequest(chunks: string[]): ApiRequest {
  return {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    }
  } as unknown as ApiRequest;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSpendBuckets();
});

// ---------------------------------------------------------------- policy (1)

test('prompt/refine rejects an unkeyed call with the BYOK policy error and never reaches upstream', async () => {
  const calls = captureFetch(() => jsonResponse({ candidates: [] }));

  const res = await invoke(refineHandler, { rawPrompt: 'button red bana do', provider: 'gemini' });

  assert.equal(res.statusCode, 400);
  assert.match(String(res.json.error), /shared key/i);
  assert.match(String(res.json.error), /BYOK/i);
  // The old handler had its own `process.env` fallback — that string must be gone.
  assert.doesNotMatch(String(res.json.error), /Prompt refine ke liye/);
  assert.equal(calls.length, 0, 'no upstream request may be made without a resolved key');
});

test('prompt/refine honours the policy for groq too', async () => {
  const calls = captureFetch(() => jsonResponse({ choices: [] }));

  const res = await invoke(refineHandler, { rawPrompt: 'login add karo', provider: 'groq' });

  assert.equal(res.statusCode, 400);
  assert.match(String(res.json.error), /groq/i);
  assert.equal(calls.length, 0);
});

test('prompt/refine spends the caller key and keeps its response shape', async () => {
  const calls = captureFetch(() =>
    jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  detectedLanguage: 'Hinglish',
                  translatedText: 'Make the button red',
                  intent: 'Styling change',
                  refinedPrompt: 'Restyle the primary button to a red background.'
                })
              }
            ]
          }
        }
      ]
    })
  );

  const res = await invoke(refineHandler, {
    rawPrompt: 'button red bana do',
    provider: 'gemini',
    apiKeyByProvider: { gemini: USER_KEY }
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [
    'detectedLanguage',
    'intent',
    'refinedPrompt',
    'translatedText'
  ]);
  assert.equal(res.json.refinedPrompt, 'Restyle the primary button to a red background.');
  assert.equal(calls.length, 1);
});

// ----------------------------------------------------------- key in header (2)

test('gemini adapter authenticates with x-goog-api-key instead of a query parameter', async () => {
  const calls = captureFetch(() =>
    sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'])
  );

  await streamGemini(
    {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      apiKey: USER_KEY,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      signal: new AbortController().signal
    },
    { delta() {}, reasoning() {} }
  );

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /key=/, 'the key must never travel in the query string');
  assert.ok(calls[0].url.endsWith(':streamGenerateContent?alt=sse'), 'streaming path unchanged');
  assert.equal(calls[0].headers['x-goog-api-key'], USER_KEY);
});

test('prompt/refine sends the gemini key as a header', async () => {
  const calls = captureFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));

  await invoke(refineHandler, {
    rawPrompt: 'ek helper bana do',
    provider: 'gemini',
    apiKey: USER_KEY
  });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /AIza/);
  assert.equal(calls[0].headers['x-goog-api-key'], USER_KEY);
});

test('byok/validate sends the gemini key as a header', async () => {
  const calls = captureFetch(() =>
    jsonResponse({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] })
  );

  const res = await invoke(byokHandler, { provider: 'gemini', apiKey: USER_KEY });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /key=/);
  assert.doesNotMatch(calls[0].url, /AIza/);
  assert.equal(calls[0].headers['x-goog-api-key'], USER_KEY);
});

// ----------------------------------------------------------- error sanitizer (3)

test('the sanitizer strips key-shaped tokens, URLs and oversized bodies', () => {
  const leaky =
    'Request failed for https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent?alt=sse&key=AIzASECRET123456 because quota exceeded';
  const clean = sanitizeErrorMessage(leaky, 'fallback');

  assert.doesNotMatch(clean, /AIzASECRET/);
  assert.doesNotMatch(clean, /key=/);
  assert.doesNotMatch(clean, /https:\/\//);
  assert.match(clean, /quota exceeded/);

  assert.doesNotMatch(sanitizeErrorMessage('bad key gsk_topsecretvalue123', 'fallback'), /gsk_topsecret/);
  assert.doesNotMatch(sanitizeErrorMessage('bad key sk-abcdEFGH0123456', 'fallback'), /sk-abcdEFGH/);
  assert.equal(sanitizeErrorMessage('', 'Kuch galat ho gaya.'), 'Kuch galat ho gaya.');
  assert.equal(sanitizeErrorMessage('https://x.io/?key=AIzA1234567890abc', 'Kuch galat ho gaya.'), 'Kuch galat ho gaya.');
  assert.ok(sanitizeErrorMessage('a'.repeat(5_000), 'fallback').length <= 301);
});

test('chat never forwards an upstream error that echoes the request URL', async () => {
  captureFetch(() =>
    jsonResponse(
      {
        error: {
          message: `Invalid payload sent to https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?key=AIzASECRET123456&alt=sse`
        }
      },
      400
    )
  );

  const res = await invoke(chatHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    messages: [{ role: 'user', content: 'hello' }]
  });

  assert.doesNotMatch(res.text, /AIzASECRET/);
  assert.doesNotMatch(res.text, /generativelanguage/);
  assert.match(res.text, /"type":"error"/, 'the SSE error event name is unchanged');
});

// ------------------------------------------------------------ input limits (4)

test('a raw body over the route cap is rejected with 413 before parsing', async () => {
  await assert.rejects(
    () => readJsonBody(asyncIterableRequest(['{"rawPrompt":"', 'a'.repeat(4_000), '"}']), { maxBytes: 256 }),
    (error: unknown) => {
      assert.ok(error instanceof RequestRejectedError);
      assert.equal(error.status, 413);
      return true;
    }
  );
});

test('an oversized declared body is rejected on the Express path too', async () => {
  const req = {
    method: 'POST',
    headers: { 'content-length': '900000' },
    socket: { remoteAddress: '203.0.113.7' },
    body: { rawPrompt: 'x' }
  } as unknown as ApiRequest;

  await assert.rejects(
    () => readJsonBody(req, { maxBytes: 256 }),
    (error: unknown) => error instanceof RequestRejectedError && error.status === 413
  );
});

test('chat history cannot smuggle unbounded text into a shared-key spend', async () => {
  const calls = captureFetch(() => sseResponse(['data: [DONE]\n\n']));

  const tooMany = await invoke(chatHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    messages: Array.from({ length: FIELD_LIMITS.chatMessages + 1 }, () => ({ role: 'user', content: 'hi' }))
  });
  assert.equal(tooMany.statusCode, 413);

  const tooLong = await invoke(chatHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    messages: [{ role: 'user', content: 'a'.repeat(FIELD_LIMITS.chatMessageChars + 1) }]
  });
  assert.equal(tooLong.statusCode, 413);

  assert.equal(calls.length, 0, 'rejected bodies must not reach the provider');
});

test('chat still answers 400 for an empty or blank history', async () => {
  const calls = captureFetch(() => sseResponse(['data: [DONE]\n\n']));

  const empty = await invoke(chatHandler, { provider: 'gemini', apiKey: USER_KEY, messages: [] });
  assert.equal(empty.statusCode, 400);
  assert.match(String(empty.json.error), /Kam se kam ek message/);

  const blank = await invoke(chatHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    messages: [{ role: 'user', content: '   ' }]
  });
  assert.equal(blank.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('fim keeps its short-circuit for a blank prefix and its policy error without a key', async () => {
  const calls = captureFetch(() => sseResponse(['data: [DONE]\n\n']));

  const blank = await invoke(fimHandler, { provider: 'gemini', apiKey: USER_KEY, prefix: '   ', suffix: '' });
  assert.equal(blank.statusCode, 200);
  assert.deepEqual(blank.json, { text: '', tokens: 0 });

  const unkeyed = await invoke(fimHandler, { provider: 'gemini', prefix: 'const x =' });
  assert.equal(unkeyed.statusCode, 400);
  assert.match(String(unkeyed.json.error), /shared key/i);

  const oversized = await invoke(fimHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    prefix: 'a'.repeat(FIELD_LIMITS.fimContextChars + 1)
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(calls.length, 0);
});

test('temperature is clamped into range instead of forwarded raw', async () => {
  const calls = captureFetch(() =>
    sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'])
  );

  await invoke(chatHandler, {
    provider: 'gemini',
    apiKey: USER_KEY,
    temperature: 9_000,
    messages: [{ role: 'user', content: 'hi' }]
  });

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].body) as { generationConfig?: { temperature?: number } };
  assert.equal(sent.generationConfig?.temperature, 2);
});

test('the system instruction is charged against the model context window', () => {
  const contextWindow = 32_768; // resolveContextWindow('groq', 'groq-test-model')
  const messages = [{ role: 'user' as const, content: 'b'.repeat(200_000) }];
  const budget = budgetRequest('groq', 'groq-test-model', messages, 's'.repeat(500_000));

  assert.ok(
    (budget.systemInstruction?.length ?? 0) < 80_000,
    'the instruction is capped to what this model can carry, not to the global ceiling'
  );
  assert.ok(budget.messages[0].content.length < 200_000, 'history got trimmed');

  const inputTokens =
    ((budget.systemInstruction?.length ?? 0) + budget.messages.reduce((sum, message) => sum + message.content.length, 0)) / 4;
  assert.ok(inputTokens <= contextWindow, `request fits the window (got ${inputTokens} tokens)`);

  // What the old arithmetic allowed for this window: the full message budget plus
  // an 80k system instruction nobody subtracted. Over-window requests are exactly
  // what came back as an opaque provider error.
  assert.ok(65_536 / 4 + 80_000 / 4 > contextWindow, 'the pre-fix budget exceeded the window');
});

// ------------------------------------------------------------- spend guard (5)

test('shared-key requests are rate limited per IP and per scope', () => {
  const burst = SHARED_KEY_RATE_LIMITS.chat.burst;
  for (let i = 0; i < burst; i += 1) {
    assert.equal(checkSharedKeySpend('chat', '198.51.100.1', false).allowed, true);
  }
  const denied = checkSharedKeySpend('chat', '198.51.100.1', false);
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.ok(denied.retryAfterSeconds >= 1);

  // A different IP and a different scope have their own buckets.
  assert.equal(checkSharedKeySpend('chat', '198.51.100.2', false).allowed, true);
  assert.equal(checkSharedKeySpend('refine', '198.51.100.1', false).allowed, true);
});

test('BYOK traffic is never throttled and never output-capped', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.equal(checkSharedKeySpend('chat', '198.51.100.9', true).allowed, true);
  }
  assert.equal(outputCeiling('chat', true), Number.POSITIVE_INFINITY);
  assert.equal(outputCeiling('chat', false), SHARED_KEY_OUTPUT_CHAR_CEILINGS.chat);
});

test('a shared-key reply stops at the output ceiling, BYOK replies do not', () => {
  const ceiling = SHARED_KEY_OUTPUT_CHAR_CEILINGS.chat;
  const shared = fitChunk(ceiling - 5, ceiling, 'x'.repeat(40));
  assert.equal(shared.head.length, 5);
  assert.equal(shared.capped, true);

  const byok = fitChunk(100_000, outputCeiling('chat', true), 'x'.repeat(40));
  assert.equal(byok.head.length, 40);
  assert.equal(byok.capped, false);
});

test('a flood of BYOK chat requests never draws a 429', async () => {
  captureFetch(() => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n']));

  for (let i = 0; i < 40; i += 1) {
    const res = await invoke(chatHandler, {
      provider: 'gemini',
      apiKey: USER_KEY,
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.notEqual(res.statusCode, 429);
    assert.match(res.text, /"type":"done"/);
  }
});

// ------------------------------------------------------- shared key lockdown (6)
//
// Beta is BYOK-only: even with an operator key present in the environment, no
// request may be served from it until SHADROX_ALLOW_SHARED_KEY is set to '1'.

const OPERATOR_KEY = 'AIzaOperatorKey0123456789abcdef';

function withOperatorKey(run: () => void): void {
  const previous = process.env.SHADROX_GEMINI_API_KEY;
  const previousSwitch = process.env.SHADROX_ALLOW_SHARED_KEY;
  process.env.SHADROX_GEMINI_API_KEY = OPERATOR_KEY;
  delete process.env.SHADROX_ALLOW_SHARED_KEY;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.SHADROX_GEMINI_API_KEY;
    else process.env.SHADROX_GEMINI_API_KEY = previous;
    if (previousSwitch === undefined) delete process.env.SHADROX_ALLOW_SHARED_KEY;
    else process.env.SHADROX_ALLOW_SHARED_KEY = previousSwitch;
  }
}

test('the shared-key path is closed by default even with an operator key configured', () => {
  withOperatorKey(() => {
    assert.equal(sharedKeyPathEnabled(), false);
    const resolved = resolveKeyAccess('gemini', 'gemini-4-argon', undefined);
    assert.ok('error' in resolved, 'an unkeyed call must be refused');
    if ('error' in resolved) {
      assert.match(resolved.error, /shared key/i);
      assert.match(resolved.error, /BYOK/);
      assert.doesNotMatch(resolved.error, /AIza/);
    }
  });
});

test('a hand-crafted unkeyed chat request never reaches the provider while locked', async () => {
  const calls = captureFetch(() => sseResponse(['data: [DONE]\n\n']));
  const previous = process.env.SHADROX_GEMINI_API_KEY;
  process.env.SHADROX_GEMINI_API_KEY = OPERATOR_KEY;
  try {
    const res = await invoke(chatHandler, {
      provider: 'gemini',
      messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.statusCode, 400);
    assert.match(String(res.json.error), /shared key/i);
  } finally {
    if (previous === undefined) delete process.env.SHADROX_GEMINI_API_KEY;
    else process.env.SHADROX_GEMINI_API_KEY = previous;
  }
  assert.equal(calls.length, 0, 'the locked path must not spend anything upstream');
});

test('a BYOK request is unaffected by the lockdown', () => {
  withOperatorKey(() => {
    const resolved = resolveKeyAccess('gemini', 'gemini-3.8-flash', USER_KEY);
    assert.ok('access' in resolved);
    if ('access' in resolved) {
      assert.equal(resolved.access.apiKey, USER_KEY);
      assert.equal(resolved.access.byok, true);
    }
  });
});

test('the operator path only opens behind the explicit opt-in', () => {
  const previous = process.env.SHADROX_GEMINI_API_KEY;
  process.env.SHADROX_GEMINI_API_KEY = OPERATOR_KEY;
  process.env.SHADROX_ALLOW_SHARED_KEY = '1';
  try {
    assert.equal(sharedKeyPathEnabled(), true);
    const resolved = resolveKeyAccess('gemini', 'gemini-4-argon', undefined);
    assert.ok('access' in resolved, 'opt-in restores the shared-key fallback');
    if ('access' in resolved) {
      assert.equal(resolved.access.byok, false);
    }
  } finally {
    if (previous === undefined) delete process.env.SHADROX_GEMINI_API_KEY;
    else process.env.SHADROX_GEMINI_API_KEY = previous;
    delete process.env.SHADROX_ALLOW_SHARED_KEY;
  }
});


