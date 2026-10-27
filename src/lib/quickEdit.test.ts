import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INLINE_TEMPERATURE_DEFAULT,
  INLINE_TEMPERATURE_MAX,
  buildQuickEditPrompt,
  clampInlineTemperature,
  extractReplacement,
  runQuickEdit,
  sliceQuickEditContext
} from './quickEdit';

const DOC = [
  "import express from 'express';",
  '',
  'const app = express();',
  '  const total = items.reduce((a, b) => a + b, 0);',
  'app.listen(3000);'
].join('\n');

test('splits a selection into ABOVE / SELECTED / BELOW', () => {
  const from = DOC.indexOf('const total');
  const to = DOC.indexOf('\napp.listen');
  const context = sliceQuickEditContext(DOC, from, to, 'use a for loop', 'src/app.js', 'javascript');
  assert.equal(context.selected, 'const total = items.reduce((a, b) => a + b, 0);');
  assert.ok(context.above.includes('const app = express();'));
  assert.ok(context.below.includes('app.listen(3000);'));
  assert.equal(context.instruction, 'use a for loop');
});

test('an empty caret edits the whole line under it', () => {
  const caret = DOC.indexOf('app.listen') + 4;
  const context = sliceQuickEditContext(DOC, caret, caret, 'use a constant port', 'src/app.js', 'javascript');
  assert.equal(context.selected, 'app.listen(3000);');
  assert.ok(!context.above.includes('app.listen'));
  assert.equal(context.below, '');
});

test('caps the surrounding context handed to the model', () => {
  const long = `${'line\n'.repeat(120)}target\n${'line\n'.repeat(120)}`;
  const from = long.indexOf('target');
  const context = sliceQuickEditContext(long, from, from + 6, 'rename', 'a.ts', 'typescript');
  assert.equal(context.selected, 'target');
  assert.equal(context.above.split('\n').length, 28);
  assert.ok(context.below.split('\n').length <= 29);
});

test('takes the replacement out of a fenced reply', () => {
  assert.equal(extractReplacement('```ts\nconst x = 1;\n```'), 'const x = 1;');
  assert.equal(extractReplacement('Sure!\n```js\nfoo();\n```\nDone.'), 'foo();');
  assert.equal(extractReplacement('const x = 1;'), 'const x = 1;');
  assert.equal(extractReplacement('```\nres.json(data)\n```'), 'res.json(data)');
});

test('the prompt tells the model to touch only the selected region', () => {
  const { systemInstruction, prompt } = buildQuickEditPrompt({
    filePath: 'a.ts',
    language: 'typescript',
    above: 'a',
    selected: 'b',
    below: 'c',
    instruction: 'make it async'
  });
  assert.match(systemInstruction, /ONLY the new code/);
  assert.match(prompt, /<ABOVE>\na\n<\/ABOVE>/);
  assert.match(prompt, /<SELECTED>\nb\n<\/SELECTED>/);
  assert.match(prompt, /<BELOW>\nc\n<\/BELOW>/);
  assert.match(prompt, /Instruction: make it async/);
});

/* ------------------------------------------------------------------ *
 * Temperature: the user's setting has to reach the model — clamped.
 * ------------------------------------------------------------------ */

test('clamps to the inline-edit band instead of trusting the chat setting', () => {
  assert.equal(clampInlineTemperature(undefined), INLINE_TEMPERATURE_DEFAULT);
  assert.equal(clampInlineTemperature(0.3), 0.3, 'preferences inside the band are honoured');
  assert.equal(clampInlineTemperature(0), 0);
  assert.equal(clampInlineTemperature(1.4), INLINE_TEMPERATURE_MAX, 'chat heat is capped for edits');
  assert.equal(clampInlineTemperature(-2), 0);
  assert.equal(clampInlineTemperature(Number.NaN), INLINE_TEMPERATURE_DEFAULT);
});

/** Drives runQuickEdit against a fake /api/ai/chat and returns the request body. */
async function captureRequestBody(ai: Parameters<typeof runQuickEdit>[1]): Promise<any> {
  const encoder = new TextEncoder();
  const payload = [
    'data: {"type":"delta","text":"```ts\\nconst replaced = 1;\\n```"}\n\n',
    'data: {"type":"done","tokens":7}\n\n'
  ].map((chunk) => encoder.encode(chunk));
  let cursor = 0;
  let captured: any = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: {
        getReader: () => ({
          read: async () =>
            cursor < payload.length
              ? { done: false, value: payload[cursor++] }
              : { done: true, value: undefined }
        })
      }
    } as any;
  }) as typeof fetch;

  try {
    const context = sliceQuickEditContext('const a = 1;\n', 0, 12, 'rename it', 'a.ts', 'typescript');
    const replacement = await runQuickEdit(context, ai);
    assert.equal(replacement, 'const replaced = 1;');
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

test('Ctrl+K sends the user temperature on the wire', async () => {
  const body = await captureRequestBody({ provider: 'gemini', model: 'gemini-flash', apiKey: 'k', temperature: 0.3 });
  assert.equal(body.temperature, 0.3);
  assert.equal(body.messages.length, 1);
});

test('a hot chat temperature is clamped before it can reach an inline edit', async () => {
  const body = await captureRequestBody({ provider: 'groq', model: 'llama', temperature: 1.8 });
  assert.equal(body.temperature, INLINE_TEMPERATURE_MAX);
});

test('no temperature preference still sends the deterministic default', async () => {
  const body = await captureRequestBody({ provider: 'groq', model: 'llama' });
  assert.equal(body.temperature, INLINE_TEMPERATURE_DEFAULT);
});
