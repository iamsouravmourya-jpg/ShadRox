import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capSystemInstruction,
  messageBudgetChars,
  reservedOutputTokens,
  trimMessagesToBudget,
  TRIM_TO_LEN
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
