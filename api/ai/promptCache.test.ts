/**
 * Deterministic tests for the stable-prefix prompt-shaping module.
 * Patterns under test are ported from aider's chat_chunks.py (Apache-2.0) —
 * see the attribution header in ./_promptCache.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../../src/lib/contextBudget.js';
import {
  promptCacheMode,
  renderCacheableContent,
  shapeStablePrefix,
  stablePrefixBytes,
  type StablePrefixPlan
} from './_promptCache.js';
import {
  mergeGeminiUsage,
  mergeOpenAiUsage,
  usageFields,
  type ChatMessage,
  type ProviderId
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

/**
 * Fake provider harness: renders the wire `messages` array exactly the way
 * _compatible.ts/_openai.ts serialize it (systemInstruction first, then each
 * shaped message through renderCacheableContent), with no network involved.
 */
function fakeProviderWireMessages(provider: ProviderId, model: string, messages: ChatMessage[]): string {
  const plan = shapeStablePrefix(provider, model, messages);
  const wire = [
    { role: 'system', content: 'SHADROX SYSTEM INSTRUCTION' },
    ...plan.messages.map((message) => ({ role: message.role, content: renderCacheableContent(message) }))
  ];
  return JSON.stringify(wire);
}

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

  // Idempotent: shaping a shaped list is byte-identical.
  const again = shapeStablePrefix('groq', 'llama-3.3-70b', plan.messages);
  assert.equal(JSON.stringify(again.messages), JSON.stringify(plan.messages));
});

test('all endpoints retain a byte-stable prefix without inferred provider markers', () => {
  const messages = turnMessages(['q1', 'a1', 'q2']);

  for (const [provider, model] of [
    ['groq', 'llama-3.3-70b-versatile'],
    ['gemini', 'gemini-3-flash'],
    ['custom', 'deepseek/deepseek-v4-flash'],
    ['custom', 'openai/gpt-6-sol']
  ] as Array<[ProviderId, string]>) {
    const plan = shapeStablePrefix(provider, model, messages);
    assert.equal(plan.mode, 'auto_prefix', `${provider}/${model}`);
    // No marker field anywhere, and every content renders as the plain string.
    assert.equal(JSON.stringify(plan.messages).includes('cacheEphemeral'), false);
    plan.messages.forEach((message) => assert.equal(typeof renderCacheableContent(message), 'string'));
    // The shaped list reorders but never edits: same multiset of content bytes.
    assert.deepEqual(
      plan.messages.map((m) => m.content).slice().sort(),
      messages.map((m) => m.content).slice().sort()
    );
  }

  const claude = shapeStablePrefix('custom', 'anthropic/claude-sonnet-5.5', messages);
  assert.equal(claude.mode, 'auto_prefix');
  assert.ok(claude.cacheBreakpoints.length > 0);
  assert.equal(JSON.stringify(claude.messages).includes('cacheEphemeral'), false);
});

test('promptCacheMode never guesses custom endpoint capabilities from its model id', () => {
  assert.equal(promptCacheMode('custom', 'anthropic/claude-sonnet-5.5'), 'auto_prefix');
  assert.equal(promptCacheMode('custom', 'openrouter/claude-haiku-5.5'), 'auto_prefix');
  assert.equal(promptCacheMode('custom', 'deepseek/deepseek-v4-pro'), 'auto_prefix');
  assert.equal(promptCacheMode('groq', 'claude-taika-but-groq'), 'auto_prefix');
  assert.equal(promptCacheMode('gemini', 'gemini-3.1-pro'), 'auto_prefix');
});

test('two consecutive turns produce a byte-identical prefix up to the cache point (fake provider)', () => {
  // Turn 1 asks, turn 2 continues the same session: the earlier full wire
  // prefix must reappear, byte for byte, at the head of the later request.
  const turn1 = turnMessages(['what does chat.ts do?']);
  const turn2 = turnMessages(['what does chat.ts do?', 'It streams SSE from the provider adapter.', 'and fim.ts?']);

  for (const [provider, model] of [
    ['custom', 'anthropic/claude-sonnet-5.5'],
    ['custom', 'deepseek/deepseek-v4-flash'],
    ['groq', 'llama-3.3-70b-versatile'],
    ['gemini', 'gemini-3-flash']
  ] as Array<[ProviderId, string]>) {
    const body1 = fakeProviderWireMessages(provider, model, turn1);
    const body2 = fakeProviderWireMessages(provider, model, turn2);
    const plan1 = shapeStablePrefix(provider, model, turn1);

    // The whole of turn 1's wire list (minus nothing) is a head of turn 2's:
    // compare the JSON array element-wise up to turn1's length.
    const wire1 = JSON.parse(body1) as unknown[];
    const wire2 = JSON.parse(body2) as unknown[];
    assert.equal(wire2.length > wire1.length, true, `${provider}/${model} grows`);
    assert.equal(
      JSON.stringify(wire2.slice(0, wire1.length)),
      JSON.stringify(wire1),
      `${provider}/${model}: prefix drift at the cache point`
    );

    // And the declared stable-prefix bytes match the wire slice of turn 1.
    const prefix = JSON.parse(stablePrefixBytes(plan1)) as unknown[];
    assert.equal(JSON.stringify(wire1.slice(1, 1 + prefix.length)), JSON.stringify(prefix));
  }
});

test('stablePrefixBytes stays identical for the system block across three turns', () => {
  const t1 = turnMessages(['q1']);
  const t2 = turnMessages(['q1', 'a1', 'q2']);
  const t3 = turnMessages(['q1', 'a1', 'q2', 'a2', 'q3']);
  const systemBlockBytes = (plan: StablePrefixPlan) =>
    JSON.stringify(plan.messages.slice(0, 2).map((m) => ({ role: m.role, content: renderCacheableContent(m) })));
  const p1 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-5.5', t1);
  const p2 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-5.5', t2);
  const p3 = shapeStablePrefix('custom', 'anthropic/claude-sonnet-5.5', t3);
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
});

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
