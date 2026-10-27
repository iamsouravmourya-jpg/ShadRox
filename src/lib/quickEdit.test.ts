import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuickEditPrompt, extractReplacement, sliceQuickEditContext } from './quickEdit';

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
