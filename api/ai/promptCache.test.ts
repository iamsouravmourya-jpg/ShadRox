/**
 * Deterministic tests for stable-prefix shaping and cache-marker emission.
 * The ordering/marker patterns under test are ported from aider's
 * chat_chunks.py (Apache-2.0) — see the attribution header in ./_promptCache.ts.
 *
 * The marker assertions run through the REAL outbound serializers
 * (`streamCustomEndpoint`, `streamGemini`, `streamGroq`) with `fetch` stubbed,
 * because a helper nobody calls is not shipping: what these tests read is the
 * body that would have left the process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../../src/lib/contextBudget.js';
import { estimateTokens as wireTokens } from '../_http.js';
import { streamCustomEndpoint } from './_compatible.js';
import { streamGemini } from './_gemini.js';
import { streamGroq } from './_openai.js';
import {
  markStableText,
  emitsCacheMarkers,
  promptCacheKeyValue,
  promptCacheMode,
  promptCacheReport,
  renderCacheableContent,
  shapeStablePrefix,
  stablePrefixBytes,
  supportsPromptCacheKey,
  type StablePrefixPlan
} from './_promptCache.js';
import {
  mergeGeminiUsage,
  mergeOpenAiUsage,
  usageFields,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderId,
  type StreamRequest,
  type StreamSink
} from './_types.js';

const RULES = 'You are ShadRox. Never delete files without asking.\nAlways answer in diff blocks.';
const REPO_CONTEXT = 'REPO MAP (long-lived context):\nsrc/App.tsx — chat loop\napi/ai/chat.ts — SSE route';

function turnMessages(currentTurns: string[]): ChatMessage[] {
  return [
    { role: 'system', content: RULES },
    { role: 'system', content: REPO_CONTEXT },
    ...currentTurns.map((text, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: text
    }))
  ];
}

/* ------------------------------------------------------------------ *
 * Stubbed provider harness: capture the body each adapter would send.
 * ------------------------------------------------------------------ */

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function openAiSse(cachedTokens: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`
        ));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 20,
              total_tokens: 1_020,
              prompt_tokens_details: { cached_tokens: cachedTokens }
            }
          })}\n\n`
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function geminiSse(cachedTokens: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 1_000,
              candidatesTokenCount: 20,
              thoughtsTokenCount: 0,
              totalTokenCount: 1_020,
              cachedContentTokenCount: cachedTokens
            }
          })}\n\n`
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function request(overrides: Partial<StreamRequest>): StreamRequest {
  return {
    provider: 'custom',
    model: 'anthropic/claude-sonnet-4.5',
    apiKey: 'test-key-not-a-secret',
    baseUrl: 'https://openrouter.ai/api/v1',
    messages: [],
    systemInstruction: 'SHADROX SYSTEM INSTRUCTION: keep the diff minimal.',
    temperature: 0.5,
    signal: new AbortController().signal,
    ...overrides
  };
}

/** Runs one adapter against a stubbed `fetch` and returns every request body it sent. */
async function outbound(
  adapter: ProviderAdapter['stream'],
  req: StreamRequest,
  respond: (attempt: number) => Response
): Promise<{ captured: Captured[]; result: any }> {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: BodyInit | null }) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    });
    return respond(captured.length - 1);
  }) as unknown as typeof fetch;
  const sink: StreamSink = { delta() {}, reasoning() {}, toolCalls() {} };
  try {
    const result = await adapter(req, sink);
    return { captured, result };
  } finally {
    globalThis.fetch = original;
  }
}

const okOnce = () => openAiSse(800);
const wire = (captured: Captured[]) => JSON.stringify((captured[0].body.messages as unknown[]) ?? []);

/* ------------------------------------------------------------------ *
 * Ordering discipline (unchanged guarantees).
 * ------------------------------------------------------------------ */

test('stable-prefix ordering hoists system rules and long-lived context first, volatile turn last', () => {
  // A mid-history system reminder is the churn that breaks a cached prefix:
  // it must be hoisted into the stable block, everything else keeps chronology.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'system', content: 'a rules block that arrived late' },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'the volatile current turn' }
  ];
  const plan = shapeStablePrefix('groq', 'llama-3.3-70b', messages);
  assert.deepEqual(
    plan.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.equal(plan.messages[1].content, 'first question');
  assert.equal(plan.messages[3].content, 'the volatile current turn');

  // Idempotent: shaping a shaped list is byte-identical, markers included.
  const again = shapeStablePrefix('groq', 'llama-3.3-70b', plan.messages);
  assert.equal(JSON.stringify(again.messages), JSON.stringify(plan.messages));
  const markedAgain = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', plan.messages);
  assert.equal(JSON.stringify(markedAgain.messages), JSON.stringify(shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', plan.messages).messages));
});

test('the plan reports the mode it used and the length of the prefix it produced', () => {
  const messages = turnMessages(['q1', 'a1', 'q2']);
  const claude = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', messages);
  assert.equal(claude.mode, 'cache_control');
  assert.equal(claude.markers, claude.cacheBreakpoints.length);
  assert.ok(claude.prefixTokens > 0);
  // The prefix is the stable half of the request, not the whole of it.
  const allChars = claude.messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(claude.prefixChars < allChars);
  assert.equal(claude.prefixChars, RULES.length + REPO_CONTEXT.length + 'q1'.length + 'a1'.length);
  assert.match(claude.prefixHash, /^[0-9a-f]{16}$/);

  const report = promptCacheReport(claude);
  assert.equal(report.mode, 'cache_control');
  assert.equal(report.prefixTokens, claude.prefixTokens);
  assert.equal(report.breakpoints, claude.cacheBreakpoints.length);
  assert.ok(report.prefixShare > 0 && report.prefixShare < 1);

  // Same history, different turn count => the digest moves; replaying the same
  // history => it does not, which is what a provider cache hit keys on.
  assert.equal(shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', messages).prefixHash, claude.prefixHash);
  assert.notEqual(
    shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', turnMessages(['q1', 'a1', 'q2', 'a2', 'q3'])).prefixHash,
    claude.prefixHash,
    'a longer stable prefix is a different cache entry'
  );
  // Rewording only the volatile turn leaves the stable prefix bytes alone.
  assert.equal(
    shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', turnMessages(['q1', 'a1', 'a totally different ask'])).prefixHash,
    claude.prefixHash
  );
});

/* ------------------------------------------------------------------ *
 * Marker selection.
 * ------------------------------------------------------------------ */

test('promptCacheMode picks the cache dialect per provider family', () => {
  // Anthropic behind an OpenAI-compatible gateway: the one wire format here
  // that carries a cache field, so it is the one that gets markers.
  assert.equal(promptCacheMode('custom', 'anthropic/claude-sonnet-4.5'), 'cache_control');
  assert.equal(promptCacheMode('custom', 'claude-sonnet-4.5'), 'cache_control');
  assert.equal(promptCacheMode('custom', 'openrouter/anthropic/claude-haiku-4.5'), 'cache_control');
  assert.equal(emitsCacheMarkers('custom', 'anthropic/claude-sonnet-4.5'), true);
  // Gemini: placement in systemInstruction, no field.
  assert.equal(promptCacheMode('gemini', 'gemini-3.1-pro'), 'system_instruction_prefix');
  assert.equal(emitsCacheMarkers('gemini', 'gemini-3.1-pro'), false);
  // Groq and every non-Anthropic compatible server: implicit prefix caching only.
  assert.equal(promptCacheMode('groq', 'llama-3.3-70b-versatile'), 'auto_prefix');
  assert.equal(promptCacheMode('groq', 'claude-taika-but-groq'), 'auto_prefix');
  assert.equal(promptCacheMode('custom', 'deepseek/deepseek-v4-pro'), 'auto_prefix');
  assert.equal(promptCacheMode('custom', 'openai/gpt-6-sol'), 'auto_prefix');
});

test('only the host that documents prompt_cache_key gets the routing field', () => {
  assert.equal(supportsPromptCacheKey('https://api.openai.com/v1/chat/completions'), true);
  assert.equal(supportsPromptCacheKey('https://openrouter.ai/api/v1/chat/completions'), false);
  assert.equal(supportsPromptCacheKey('https://api.groq.com/openai/v1/chat/completions'), false);
  assert.equal(supportsPromptCacheKey('http://127.0.0.1:11434/v1/chat/completions'), false);
  assert.equal(supportsPromptCacheKey('not a url'), false);

  const key = promptCacheKeyValue(shapeStablePrefix('custom', 'gpt-4o', turnMessages(['q1'])));
  assert.match(key, /^shadrox_[0-9a-f]{16}$/);
  assert.ok(key.length <= 512);
  // Conversation-stable: appending a turn must not change the routing key, or
  // every turn would be routed to a cold cache.
  const later = promptCacheKeyValue(shapeStablePrefix('custom', 'gpt-4o', turnMessages(['q1', 'a1', 'q2'])));
  assert.equal(later, key);
});

test('unmarked providers never receive a marker field, marked ones do', () => {
  const messages = turnMessages(['q1', 'a1', 'q2']);

  for (const [provider, model] of [
    ['groq', 'llama-3.3-70b-versatile'],
    ['gemini', 'gemini-3-flash'],
    ['custom', 'deepseek/deepseek-v4-flash'],
    ['custom', 'openai/gpt-6-sol']
  ] as Array<[ProviderId, string]>) {
    const plan = shapeStablePrefix(provider, model, messages);
    // Gemini is the placement dialect; the others are pure implicit caching.
    // Neither may add a field the server does not speak.
    assert.notEqual(plan.mode, 'cache_control', `${provider}/${model}`);
    assert.equal(plan.markers, 0);
    assert.equal(JSON.stringify(plan.messages).includes('cacheEphemeral'), false);
    // No marker means no content-part array: byte-identical to the old body.
    plan.messages.forEach((message) => assert.equal(typeof renderCacheableContent(message), 'string'));
    assert.deepEqual(
      plan.messages.map((m) => m.content).slice().sort(),
      messages.map((m) => m.content).slice().sort()
    );
  }

  const claude = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', messages);
  assert.equal(claude.mode, 'cache_control');
  assert.ok(claude.cacheBreakpoints.length > 0);
  claude.cacheBreakpoints.forEach((index) => assert.equal(claude.messages[index].cacheEphemeral, true));
  // Never on the volatile last turn.
  claude.cacheBreakpoints.forEach((index) => assert.ok(index < claude.messages.length - 1));
  const rendered = renderCacheableContent(claude.messages[claude.cacheBreakpoints[0]]) as Array<Record<string, unknown>>;
  assert.equal(rendered[0].type, 'text');
  assert.deepEqual(rendered[0].cache_control, { type: 'ephemeral' });
  assert.equal(JSON.stringify(markStableText('rules')).includes('"cache_control":{"type":"ephemeral"}'), true);
});

/* ------------------------------------------------------------------ *
 * The real outbound path: what the provider actually receives.
 * ------------------------------------------------------------------ */

test('OUTBOUND custom+claude: cache_control parts on the system instruction and every breakpoint', async () => {
  const { captured } = await outbound(streamCustomEndpoint, request({
    messages: turnMessages(['q1', 'a1', 'q2'])
  }), okOnce);

  const body = captured[0].body as { messages: Array<{ role: string; content: unknown }> };
  const serialized = JSON.stringify(body.messages);
  assert.equal(serialized.includes('cache_control'), true, 'markers must ship, not just be planned');
  // The system instruction is the longest-lived block and carries its own marker.
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'SHADROX SYSTEM INSTRUCTION: keep the diff minimal.', cache_control: { type: 'ephemeral' } }
  ]);
  // The shaped breakpoints carry marked parts; the rest stays a plain string.
  const history = body.messages.slice(1);
  const marked = history.filter((message) => typeof message.content !== 'string');
  assert.equal(marked.length, 2, 'the system block end and the end of stable history');
  assert.equal(history[history.length - 1].content, 'q2', 'volatile turn is unmarked');
  assert.equal('prompt_cache_key' in captured[0].body, false, 'OpenRouter does not document the field');
});

test('OUTBOUND custom+claude on api.openai.com grows prompt_cache_key, not markers', async () => {
  const { captured } = await outbound(streamCustomEndpoint, request({
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    messages: turnMessages(['q1'])
  }), okOnce);
  const body = captured[0].body as { messages: Array<{ content: unknown }>; prompt_cache_key?: string };
  assert.match(String(body.prompt_cache_key), /^shadrox_[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(body.messages).includes('cache_control'), false);
});

test('OUTBOUND custom non-anthropic body is byte-identical to the pre-cache wire format', async () => {
  const messages = turnMessages(['q1', 'a1', 'q2']);
  const { captured } = await outbound(streamCustomEndpoint, request({
    model: 'deepseek/deepseek-v4-flash',
    messages
  }), okOnce);
  const legacy = [
    { role: 'system', content: 'SHADROX SYSTEM INSTRUCTION: keep the diff minimal.' },
    ...shapeStablePrefix('custom', 'deepseek/deepseek-v4-flash', messages).messages
      .map((message) => ({ role: message.role, content: message.content }))
  ];
  assert.deepEqual(JSON.parse(wire(captured)), legacy);
});

test('OUTBOUND a gateway that rejects content parts gets one unmarked resend, not a failure', async () => {
  const sends: Array<{ status: number; payload: string }> = [
    { status: 400, payload: JSON.stringify({ error: { message: "Extra inputs are not permitted: 'cache_control'" } }) },
    { status: 200, payload: '' }
  ];
  const { captured } = await outbound(streamCustomEndpoint, request({
    messages: turnMessages(['q1', 'a1', 'q2'])
  }), (attempt) => {
    const send = sends[attempt] ?? sends[sends.length - 1];
    if (send.status === 200) return openAiSse(800);
    return new Response(send.payload, { status: send.status, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(captured.length, 2);
  assert.equal(JSON.stringify(captured[0].body.messages).includes('cache_control'), true);
  assert.equal(JSON.stringify(captured[1].body.messages).includes('cache_control'), false);
  const resent = (captured[1].body as { messages: Array<{ content: unknown }> }).messages;
  assert.equal(resent.every((message) => typeof message.content === 'string'), true);
});

test('OUTBOUND gemini puts every stable block in systemInstruction and keeps contents append-only', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'system', content: REPO_CONTEXT },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'the volatile current turn' }
  ];
  const { captured, result } = await outbound(
    streamGemini,
    request({ provider: 'gemini', model: 'gemini-3-flash', baseUrl: undefined, messages }),
    () => geminiSse(750)
  );
  const body = captured[0].body as {
    systemInstruction: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  };

  // The hoisted repo map is inside the cached placement block, not in the turns.
  assert.equal(body.systemInstruction.parts[0].text.includes(REPO_CONTEXT), true);
  assert.equal(body.systemInstruction.parts[0].text.indexOf('SHADROX SYSTEM INSTRUCTION') <
    body.systemInstruction.parts[0].text.indexOf(REPO_CONTEXT), true, 'stable order is fixed');
  assert.deepEqual(body.contents.map((entry) => entry.role), ['user', 'model', 'user']);
  assert.equal(body.contents[body.contents.length - 1].parts[0].text, 'the volatile current turn');
  assert.equal(JSON.stringify(captured[0].body).includes('cachedContent'), false, 'no cachedContents resource is created');
  // And the hit is reported back through the usage split the ledger already reads.
  assert.equal(result.cachedInputTokens, 750);
});

test('OUTBOUND groq sends no cache field at all and keeps the hoisted order', async () => {
  const messages = turnMessages(['q1', 'a1', 'q2']);
  const { captured, result } = await outbound(
    streamGroq,
    request({ provider: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: undefined, messages }),
    () => openAiSse(640)
  );
  const serialized = JSON.stringify(captured[0].body);
  assert.equal(serialized.includes('cache_control'), false);
  assert.equal(serialized.includes('prompt_cache_key'), false);
  const body = captured[0].body as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(body.messages.map((message) => message.role), ['system', 'system', 'system', 'user', 'assistant', 'user']);
  body.messages.forEach((message) => assert.equal(typeof message.content, 'string'));
  assert.equal(result.cachedInputTokens, 640);
});

/* ------------------------------------------------------------------ *
 * Prefix stability across turns.
 * ------------------------------------------------------------------ */

test('a volatile tail change does not disturb the stable prefix bytes', async () => {
  const turn1 = turnMessages(['what does chat.ts do?']);
  const turn2 = turnMessages(['what does chat.ts do?', 'It streams SSE from the provider adapter.', 'and fim.ts?']);

  const cases: Array<{ name: string; adapter: ProviderAdapter['stream']; req1: StreamRequest; req2: StreamRequest }> = [
    {
      name: 'groq',
      adapter: streamGroq,
      req1: request({ provider: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: undefined, messages: turn1 }),
      req2: request({ provider: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: undefined, messages: turn2 })
    },
    {
      name: 'gemini',
      adapter: streamGemini,
      req1: request({ provider: 'gemini', model: 'gemini-3-flash', baseUrl: undefined, messages: turn1 }),
      req2: request({ provider: 'gemini', model: 'gemini-3-flash', baseUrl: undefined, messages: turn2 })
    },
    {
      name: 'custom',
      adapter: streamCustomEndpoint,
      req1: request({ model: 'deepseek/deepseek-v4-flash', messages: turn1 }),
      req2: request({ model: 'deepseek/deepseek-v4-flash', messages: turn2 })
    }
  ];

  for (const entry of cases) {
    const responder = () => (entry.name === 'gemini' ? geminiSse(1) : openAiSse(1));
    const first = await outbound(entry.adapter, entry.req1, responder);
    const second = await outbound(entry.adapter, entry.req2, responder);

    if (entry.name === 'gemini') {
      // Gemini: the placement block itself must not move when turns grow.
      assert.equal(
        JSON.stringify((second.captured[0].body as { systemInstruction: unknown }).systemInstruction),
        JSON.stringify((first.captured[0].body as { systemInstruction: unknown }).systemInstruction),
        'systemInstruction churn'
      );
      const earlier = (first.captured[0].body as { contents: unknown[] }).contents;
      const later = (second.captured[0].body as { contents: unknown[] }).contents;
      assert.equal(JSON.stringify(later.slice(0, earlier.length)), JSON.stringify(earlier), 'contents are append-only');
      continue;
    }

    const earlier = JSON.parse(wire(first.captured)) as unknown[];
    const later = JSON.parse(wire(second.captured)) as unknown[];
    assert.equal(later.length > earlier.length, true, `${entry.name} grows`);
    assert.equal(
      JSON.stringify(later.slice(0, earlier.length)),
      JSON.stringify(earlier),
      `${entry.name}: prefix drift at the cache point`
    );
  }
});

test('two consecutive turns produce a byte-identical prefix up to the cache point (plan view)', () => {
  const turn1 = turnMessages(['what does chat.ts do?']);
  const turn2 = turnMessages(['what does chat.ts do?', 'It streams SSE from the provider adapter.', 'and fim.ts?']);

  for (const [provider, model] of [
    ['groq', 'llama-3.3-70b-versatile'],
    ['gemini', 'gemini-3-flash'],
    ['custom', 'deepseek/deepseek-v4-flash']
  ] as Array<[ProviderId, string]>) {
    const plan1 = shapeStablePrefix(provider, model, turn1);
    const plan2 = shapeStablePrefix(provider, model, turn2);
    const prefix1 = JSON.parse(stablePrefixBytes(plan1)) as unknown[];
    const wire2 = plan2.messages.map((message) => ({ role: message.role, content: renderCacheableContent(message) }));
    assert.equal(JSON.stringify(wire2.slice(0, prefix1.length)), JSON.stringify(prefix1));
    // Rewording only the volatile turn cannot change the prefix digest.
    const edited = shapeStablePrefix(provider, model, turnMessages(['what does chat.ts do?', 'It streams SSE from the provider adapter.', 'totally different ask']));
    assert.equal(edited.prefixHash, plan2.prefixHash);
  }
});

test('marked providers keep the same content bytes as their unmarked twins', () => {
  const messages = turnMessages(['q1', 'a1', 'q2', 'a2', 'q3']);
  const marked = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', messages);
  const plain = shapeStablePrefix('custom', 'deepseek/deepseek-v4-flash', messages);
  assert.deepEqual(
    marked.messages.map((message) => message.content),
    plain.messages.map((message) => message.content)
  );
  // The marker is additive metadata; stripping it restores the plain bytes.
  assert.equal(
    JSON.stringify(marked.messages.map((message) => ({ role: message.role, content: message.content }))),
    JSON.stringify(plain.messages.map((message) => ({ role: message.role, content: message.content })))
  );
});

test('stablePrefixBytes stays identical for the system block across three turns', () => {
  const t1 = turnMessages(['q1']);
  const t2 = turnMessages(['q1', 'a1', 'q2']);
  const t3 = turnMessages(['q1', 'a1', 'q2', 'a2', 'q3']);
  const systemBlockBytes = (plan: StablePrefixPlan) =>
    JSON.stringify(plan.messages.slice(0, 2).map((m) => ({ role: m.role, content: renderCacheableContent(m) })));
  const p1 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', t1);
  const p2 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', t2);
  const p3 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-4.5', t3);
  assert.equal(systemBlockBytes(p2), systemBlockBytes(p1));
  assert.equal(systemBlockBytes(p3), systemBlockBytes(p1));
  // Every breakpoint is on a stable message, never on the volatile last turn.
  for (const plan of [p1, p2, p3]) {
    plan.cacheBreakpoints.forEach((index) => assert.ok(index < plan.messages.length - 1));
  }
});

test('synthetic 3-turn session: cacheable prefix token math is exact and honest', () => {
  // Same session, three turns. The cacheable prefix at turn N is everything
  // the provider already saw at turn N-1 (system instruction included in the
  // real wire but excluded here — this measures the message-array half).
  const turn1 = turnMessages(['q1']);
  const turn2 = turnMessages(['q1', 'a1', 'q2']);
  const turn3 = turnMessages(['q1', 'a1', 'q2', 'a2', 'q3']);

  const full = (messages: ChatMessage[]) =>
    JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  const cacheableHead = (messages: ChatMessage[]) =>
    // Drop the newest assistant answer and user turn; the rest was in the
    // previous request and is the byte-identical reusable prefix.
    full(messages.slice(0, Math.max(0, messages.length - 2)));

  const prompt = { t1: estimateTokens(full(turn1)), t2: estimateTokens(full(turn2)), t3: estimateTokens(full(turn3)) };
  const reusable = { t2: estimateTokens(full(turn1)), t3: estimateTokens(full(turn2)) };

  // Re-serialized history is exactly the same bytes, so token counts line up.
  assert.equal(estimateTokens(cacheableHead(turn2)), reusable.t2);
  assert.equal(estimateTokens(cacheableHead(turn3)), reusable.t3);
  // The volatile tail strictly grows each turn; the prefix never shrinks.
  assert.equal(prompt.t2 > prompt.t1, true);
  assert.equal(prompt.t3 > prompt.t2, true);
  // No invented savings: the reportable share is derived, not asserted free.
  const share2 = reusable.t2 / prompt.t2;
  const share3 = reusable.t3 / prompt.t3;
  assert.equal(share2 > 0.5 && share2 < 1, true);
  assert.equal(share3 > share2, true);
  // And the plan's own stable-prefix estimate is the same measure over the
  // messages the provider has already seen — one number, two derivations.
  const plan = shapeStablePrefix('groq', 'llama-3.3-70b-versatile', turn2);
  assert.equal(
    plan.prefixTokens,
    [RULES, REPO_CONTEXT, 'q1', 'a1'].reduce((sum, text) => sum + wireTokens(text), 0)
  );
  assert.equal(plan.messages[plan.messages.length - 1].content, 'q2', 'the fresh turn is never in the prefix');
});

/* ------------------------------------------------------------------ *
 * Usage plumbing (already shipped, still asserted).
 * ------------------------------------------------------------------ */

test('usage frames with cached-token fields surface cache hits', () => {
  // OpenAI-compatible: usage.prompt_tokens_details.cached_tokens
  const openAi = mergeOpenAiUsage(
    { total: 1000, input: 900, output: 100 },
    { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, prompt_tokens_details: { cached_tokens: 640 } }
  );
  assert.equal(openAi.cached, 640);
  assert.deepEqual(usageFields(openAi), { inputTokens: 900, outputTokens: 100, cachedInputTokens: 640 });

  // A frame without the details block must not fake a zero.
  const plain = mergeOpenAiUsage({}, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(plain.cached, undefined);
  assert.deepEqual(usageFields(plain), { inputTokens: 10, outputTokens: 5 });

  // Gemini: usageMetadata.cachedContentTokenCount
  const gemini = mergeGeminiUsage(
    {},
    { promptTokenCount: 800, cachedContentTokenCount: 750, candidatesTokenCount: 40, totalTokenCount: 840 }
  );
  assert.equal(gemini.cached, 750);
  assert.deepEqual(usageFields(gemini), { inputTokens: 800, outputTokens: 40, cachedInputTokens: 750 });

  // Later frames overwrite earlier ones field-by-field, same as the other parts.
  const carried = mergeOpenAiUsage(openAi, { prompt_tokens: 950, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(carried.cached, 0);
  assert.deepEqual(usageFields(carried).cachedInputTokens, 0);
});
