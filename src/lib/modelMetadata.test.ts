/**
 * Budget decisions must read the published per-model metadata table first and
 * the regex guesses only for a model the table does not name — and a missing
 * row must never break compaction. See ./modelCapabilities.ts for the
 * precedence and ./modelMetadata.ts for the strict matcher.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWN_MODELS_CATALOG,
  lookupModelMetadata,
  resolveModelMetadata
} from './modelMetadata';
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveBudgetCapabilities,
  resolveCapabilities,
  resolveContextWindow
} from './modelCapabilities';
import { messageBudgetChars, trimMessagesToBudget } from './contextBudget';

/* ------------------------------------------------------------------ *
 * The matcher itself: strict, so a row is only ever used for its model.
 * ------------------------------------------------------------------ */

test('lookupModelMetadata hits exact ids and gateway-namespaced ids, and misses everything else', () => {
  assert.equal(lookupModelMetadata('gemini-2.5-flash')?.contextWindow, 1_048_576);
  assert.equal(lookupModelMetadata('  Gemini-2.5-Pro  ')?.contextWindow, 1_048_576);
  // What people actually paste: a vendor namespace or a REST path.
  assert.equal(lookupModelMetadata('google/gemini-2.5-flash')?.contextWindow, 1_048_576);
  assert.equal(lookupModelMetadata('models/gemini-2.5-pro')?.contextWindow, 1_048_576);
  assert.equal(lookupModelMetadata('openai/gpt-4o-mini')?.maxOutputTokens, 16_384);

  // Misses: nothing here may inherit a neighbouring row's window.
  assert.equal(lookupModelMetadata('gemini-2.5-flash-lite'), null, 'the lite row must not read the flash row');
  assert.equal(lookupModelMetadata('gemini-3.8-flash'), null);
  assert.equal(lookupModelMetadata('gpt-4o-2024-11-20'), null);
  assert.equal(lookupModelMetadata('llama-3.1-70b-versatile'), null);
  assert.equal(lookupModelMetadata(''), null);
  assert.equal(lookupModelMetadata('totally/unknown-model'), null);
});

test('lookupModelMetadata is a subset of the fuzzy display resolver, never a contradiction', () => {
  Object.entries(KNOWN_MODELS_CATALOG).forEach(([id, row]) => {
    assert.equal(lookupModelMetadata(id), row);
    assert.equal(resolveModelMetadata(id).contextWindow, row.contextWindow);
  });
});

/* ------------------------------------------------------------------ *
 * Precedence: table, then pattern, then default.
 * ------------------------------------------------------------------ */

test('a table-known model gets the table numbers, not the pattern guess', () => {
  // the /pro|ultra|argon/ pattern claims 2,000,000, but the published input
  // limit is 1,048,576. The smaller published number must win: an oversized
  // request is a provider 400.
  const pro = resolveCapabilities('gemini', 'gemini-2.5-pro');
  assert.equal(pro.contextWindow, 1_048_576);
  assert.equal(pro.maxOutput, 8_192);
  assert.equal(pro.source, 'metadata_table');

  const gpt = resolveCapabilities('custom', 'gpt-4o');
  assert.equal(gpt.contextWindow, 128_000);
  assert.equal(gpt.maxOutput, 16_384, 'the table ceiling, not the patterns 4096/8192');
  assert.equal(gpt.source, 'metadata_table');

  // The same model through a gateway namespace keeps the table verdict.
  assert.equal(resolveContextWindow('custom', 'openai/gpt-4o'), 128_000);
  assert.equal(resolveContextWindow('groq', 'groq/llama-3.3-70b-versatile'), 128_000);
});

test('a table-known flash model replaces its pattern guess for every provider', () => {
  // Documented consequence of wiring the table: the hand-written 1M guess for a
  // custom-endpoint gemini-2.5-flash is superseded by the published 1,048,576.
  assert.equal(resolveContextWindow('custom', 'gemini-2.5-flash'), 1_048_576);
  assert.equal(resolveContextWindow('gemini', 'gemini-2.5-flash'), 1_048_576);
  // And the neighbouring lite model still gets its own pattern number.
  assert.equal(resolveContextWindow('gemini', 'gemini-2.5-flash-lite'), 1_000_000);
});

test('an unknown model still gets the old fallback, so compaction cannot crash on a missing row', () => {
  const pattern = resolveCapabilities('gemini', 'gemini-3.8-flash');
  assert.equal(pattern.contextWindow, 1_048_576);
  assert.equal(pattern.maxOutput, 8_192);
  assert.equal(pattern.source, 'pattern_table');

  const groqCatchAll = resolveCapabilities('groq', 'some-tiny-unknown-groq-model');
  assert.equal(groqCatchAll.contextWindow, 32_768);
  assert.equal(groqCatchAll.maxOutput, 4_096);
  assert.equal(groqCatchAll.source, 'pattern_table');

  const fallback = resolveCapabilities('custom' as never, 'not-a-real-model');
  assert.equal(fallback.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(fallback.maxOutput, undefined);
  assert.equal(fallback.source, 'default');

  // Degenerate input must not throw either: this runs on every keystroke path.
  ['', '   ', '///', 'not-a-real-model'].forEach((id) => {
    const capabilities = resolveBudgetCapabilities('gemini', id);
    assert.ok(capabilities.contextWindow > 0);
    assert.ok(!Number.isNaN(capabilities.maxOutput));
  });
  const unmappedProvider = resolveBudgetCapabilities('unknown-provider' as never, 'some-model');
  assert.equal(unmappedProvider.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(unmappedProvider.source, 'default');
});

test('resolveBudgetCapabilities is the same function the server budget uses', () => {
  Object.keys(KNOWN_MODELS_CATALOG).forEach((id) => {
    assert.deepEqual(resolveBudgetCapabilities('custom', id), resolveCapabilities('custom', id));
  });
});

test('a table window changes the trim budget without breaking the trimmer', () => {
  const table = resolveBudgetCapabilities('custom', 'gpt-4o');
  const guessed = resolveBudgetCapabilities('custom', 'not-a-real-model');
  assert.ok(table.contextWindow > guessed.contextWindow);

  const budgetFor = (window: number, maxOutput?: number) => messageBudgetChars(window, maxOutput);
  assert.ok(budgetFor(table.contextWindow, table.maxOutput) > budgetFor(guessed.contextWindow, guessed.maxOutput));

  // The same arithmetic must still trim on a window the history actually
  // overflows: a table row may change the numbers, never make the trimmer give
  // up. Unknown models keep the conservative default window.
  const small = resolveBudgetCapabilities('custom', 'not-a-real-model');
  assert.equal(small.source, 'default');

  const history = [
    { role: 'assistant' as const, content: 'a'.repeat(90_000) },
    { role: 'user' as const, content: 'b'.repeat(90_000) },
    { role: 'user' as const, content: 'current question' }
  ];
  const trimmed = trimMessagesToBudget(history, small.contextWindow, small.maxOutput);
  const total = trimmed.messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= budgetFor(small.contextWindow, small.maxOutput), `trim left ${total} chars`);
  assert.ok(trimmed.trimmed > 0);
  assert.ok(trimmed.trimmedChars > 0);
  assert.equal(trimmed.messages[2].content, 'current question');
  // Older reply first, then the older typed ask — the documented order in
  // ./compaction/pairOrder.ts, not the old bare weight comparison.
  assert.deepEqual(trimmed.stages, ['assistant_prose', 'user_ask']);
});
