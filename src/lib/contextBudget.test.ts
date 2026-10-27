import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_BUDGET_CHARS,
  MAX_SYSTEM_INSTRUCTION_CHARS,
  SYSTEM_INSTRUCTION_RATIO,
  capSystemInstruction,
  contextFitNotice,
  estimateTokens,
  fitChatRequest,
  fitSystemContext,
  messageBudgetChars,
  reservedOutputTokens,
  systemInstructionBudgetChars,
  trimMessagesToBudget,
  TRIM_TO_LEN,
  type SystemContext
} from './contextBudget';
import { resolveContextWindow } from './modelCapabilities';

test('reserves half the context window for model output, floor 4096', () => {
  assert.equal(reservedOutputTokens(8_000), 4_096);
  assert.equal(reservedOutputTokens(32_000), 16_000);
  assert.equal(messageBudgetChars(32_000), 64_000);
});

test('trims oversized history within budget while protecting the newest user turn', () => {
  const messages = [
    { role: 'assistant' as const, content: 'a'.repeat(10_000) },
    { role: 'user' as const, content: 'b'.repeat(10_000) },
    { role: 'assistant' as const, content: 'c'.repeat(10_000) },
    { role: 'user' as const, content: 'current question' }
  ];
  const result = trimMessagesToBudget(messages, 8_000);
  const total = result.messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= messageBudgetChars(8_000));
  assert.equal(result.messages[3].content, 'current question');
  assert.ok(result.trimmed > 0);
});

test('trimmed messages collapse to the trim length marker', () => {
  const result = trimMessagesToBudget(
    [{ role: 'assistant' as const, content: 'x'.repeat(50_000) }],
    8_000
  );
  assert.equal(result.messages[0].content.length, TRIM_TO_LEN + 3);
  assert.ok(result.messages[0].content.endsWith('...'));
});

test('leaves small histories untouched', () => {
  const messages = [{ role: 'user' as const, content: 'hello world' }];
  const result = trimMessagesToBudget(messages, 32_000);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.trimmed, 0);
});

test('caps a huge system instruction keeping head and tail', () => {
  const text = 'A'.repeat(50_000) + 'B'.repeat(42_000) + 'IMPORTANT TAIL' + 'C'.repeat(6_000);
  const capped = capSystemInstruction(text, 20_000);
  assert.ok(capped.length <= 20_000);
  assert.ok(capped.includes('IMPORTANT TAIL'));
  assert.ok(capped.includes('trimmed'));
});

test('resolves context windows by name pattern with a safe default', () => {
  assert.equal(resolveContextWindow('gemini', 'gemini-3.8-flash'), 1_048_576);
  assert.equal(resolveContextWindow('gemini', 'gemini-4-argon'), 2_000_000);
  assert.equal(resolveContextWindow('groq', 'openai/gpt-oss-120b'), 131_072);
  assert.equal(resolveContextWindow('groq', 'totally/unknown-model'), 32_768);
});

/* ------------------------------------------------------------------ *
 * The system instruction is billed against the same window as history.
 * ------------------------------------------------------------------ */

function makeSystem(overrides: Partial<SystemContext> = {}): SystemContext {
  return {
    core: overrides.core ?? ['You are ShadRox.', 'FILE EDIT PROTOCOL: keep it short.'],
    chunkHeader: overrides.chunkHeader ?? 'RELEVANT CONTEXT (auto-retrieved):',
    chunks: overrides.chunks ?? [],
    files: overrides.files ?? []
  };
}

test('caps the instruction to 60% of the input budget, floored and globally capped', () => {
  // 32k window -> 65536 input chars; 60% = 39321, under the 80k global ceiling.
  assert.equal(systemInstructionBudgetChars(32_768), Math.floor(messageBudgetChars(32_768) * SYSTEM_INSTRUCTION_RATIO));
  assert.equal(systemInstructionBudgetChars(1_000), MIN_BUDGET_CHARS, 'tiny windows keep the floor');
  assert.equal(systemInstructionBudgetChars(4_000_000), MAX_SYSTEM_INSTRUCTION_CHARS, 'huge windows keep the 80k ceiling');
});

test('a single user message bigger than the window still fits the request', () => {
  const contextWindow = 8_000;
  const fit = fitChatRequest({
    contextWindow,
    messages: [{ role: 'user', content: 'u'.repeat(500_000) }],
    system: makeSystem()
  });
  const historyChars = fit.messages.reduce((sum, message) => sum + message.content.length, 0);
  const systemTokens = estimateTokens(fit.system.text);
  const effectiveWindow = contextWindow - systemTokens;

  assert.ok(fit.trimmed > 0, 'the oversize turn was shortened');
  assert.equal(fit.messages[0].content.length, TRIM_TO_LEN + 3);
  assert.ok(systemTokens + tokensOf(historyChars) <= contextWindow);
  assert.ok(historyChars <= messageBudgetChars(effectiveWindow));
});

function tokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}

test('retrieval that would blow the window is dropped, not sent', () => {
  const contextWindow = 8_000;
  const cap = systemInstructionBudgetChars(contextWindow);
  const chunks = Array.from({ length: 40 }, (_, index) => `chunk-${index}\n${'c'.repeat(3_000)}`);
  const fit = fitChatRequest({
    contextWindow,
    messages: [{ role: 'user', content: 'what does this do?' }],
    system: makeSystem({ chunks })
  });
  const historyChars = fit.messages.reduce((sum, message) => sum + message.content.length, 0);

  assert.ok(fit.system.text.length <= cap);
  assert.equal(fit.system.degradation, 'chunks');
  assert.ok(fit.system.droppedChunks > 0);
  assert.ok(fit.system.text.includes('chunk-0'), 'the strongest chunk survives');
  assert.ok(!fit.system.text.includes('chunk-39'), 'the weakest chunk went first');
  assert.ok(estimateTokens(fit.system.text) + tokensOf(historyChars) <= contextWindow);
});

test('degrades in priority order: chunks, then file excerpt, then truncate', () => {
  const cap = systemInstructionBudgetChars(8_000);
  // Core fills most of the cap, so *both* the chunks and the file must go.
  const core = ['x'.repeat(Math.floor(cap * 0.7))];
  const chunks = Array.from({ length: 8 }, (_, index) => `${'c'.repeat(2_000)}-${index}`);
  const files = [{ label: 'Active file (src/App.tsx):', language: 'tsx', content: 'f'.repeat(60_000), maxChars: 12_000 }];

  const first = fitSystemContext(makeSystem({ core, chunks, files }), cap);
  assert.equal(first.degradation, 'file', 'it fell through chunks first, then shrank the file');
  assert.equal(first.droppedChunks, chunks.length, 'every chunk was dropped before the file was touched');
  assert.equal(first.shrunkFiles, 1);
  assert.ok(first.text.length <= cap);
  assert.ok(first.text.includes('trimmed to'), 'the file says how much of it was cut');

  // Chunks alone are enough here: the file must stay verbatim.
  const smallFile = [{ label: 'Active file (a.ts):', language: 'ts', content: 'f'.repeat(3_000), maxChars: 3_000 }];
  const chunksOnly = fitSystemContext(makeSystem({ chunks, files: smallFile }), cap);
  assert.equal(chunksOnly.degradation, 'chunks');
  assert.equal(chunksOnly.shrunkFiles, 0);
  assert.ok(chunksOnly.droppedChunks > 0);
  assert.ok(chunksOnly.text.includes('f'.repeat(3_000)), 'the file excerpt survived');

  // Nothing left to drop: the last resort truncates with an explicit notice.
  const truncated = fitSystemContext(makeSystem({ core: ['y'.repeat(cap * 8)] }), cap);
  assert.equal(truncated.degradation, 'truncated');
  assert.ok(truncated.text.length <= cap);
  assert.ok(truncated.text.includes('Context window limit reached'));
});

test('the instruction is subtracted from the window before history is trimmed', () => {
  const contextWindow = 32_768;
  const chunks = Array.from({ length: 30 }, (_, index) => `${'c'.repeat(4_000)}-${index}`);
  const fit = fitChatRequest({
    contextWindow,
    messages: [
      { role: 'user', content: 'a'.repeat(30_000) },
      { role: 'assistant', content: 'b'.repeat(30_000) },
      { role: 'user', content: 'and now?' }
    ],
    system: makeSystem({ chunks })
  });

  const historyChars = fit.messages.reduce((sum, message) => sum + message.content.length, 0);
  const systemTokens = estimateTokens(fit.system.text);
  const effectiveWindow = contextWindow - systemTokens;

  assert.ok(fit.trimmed > 0);
  // The property that used to be missing: the instruction's tokens are reserved
  // before the history budget is computed, so the two together never exceed it.
  assert.ok(systemTokens + tokensOf(historyChars) + reservedOutputTokens(effectiveWindow) <= contextWindow);
});

test('a request that needs no degradation produces no notice', () => {
  const fit = fitChatRequest({
    contextWindow: 128_000,
    messages: [{ role: 'user', content: 'hello' }],
    system: makeSystem({ chunks: ['small chunk'] })
  });
  assert.equal(fit.system.degradation, 'none');
  assert.equal(contextFitNotice(fit, 'gemini-flash'), null);
  assert.ok(fit.systemInstruction && fit.systemInstruction.includes('small chunk'));
});

test('the notice tells the user what the model did not get to see', () => {
  const contextWindow = 8_000;
  const chunks = Array.from({ length: 40 }, (_, index) => `chunk-${index}\n${'c'.repeat(3_000)}`);
  const fit = fitChatRequest({
    contextWindow,
    messages: [{ role: 'user', content: 'q'.repeat(40_000) }],
    system: makeSystem({ chunks })
  });
  const notice = contextFitNotice(fit, 'llama-3.3-70b');
  assert.ok(notice);
  assert.match(notice, /Context window is full for llama-3.3-70b/);
  assert.match(notice, /retrieved chunk\(s\) dropped/);
  assert.match(notice, /older message\(s\) shortened/);
});
