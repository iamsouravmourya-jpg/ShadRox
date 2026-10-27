import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIM_MAX_LINES,
  FIM_PREFIX_CHARS,
  buildFimMessages,
  isWorthCompleting,
  postprocessFimCompletion,
  suffixOverlapLength
} from './fim';

test('caps the context window sent to the completion model', () => {
  const { prompt, systemInstruction } = buildFimMessages('x'.repeat(FIM_PREFIX_CHARS * 2), 'y'.repeat(9_000), 'tsx');
  assert.ok(systemInstruction.length > 0);
  assert.ok(prompt.includes('<caret>'));
  assert.ok(prompt.length < FIM_PREFIX_CHARS + 3_000 + 400, 'prefix and suffix must both be capped');
});

test('drops the part of a completion that re-types the existing suffix', () => {
  assert.equal(suffixOverlapLength(' const app', 'const app = express()'), 9);
  assert.equal(postprocessFimCompletion('  const app', 'const app = express()'), '');
});

test('strips fences and cuts at stop markers', () => {
  assert.equal(postprocessFimCompletion('```ts\nreturn res.json(data);\n```', ''), 'return res.json(data);');
  assert.equal(postprocessFimCompletion('doThing()\n```', ''), 'doThing()');
  assert.equal(postprocessFimCompletion('value = 123<|end|>', ''), 'value = 123');
});

test('keeps a suggestion to a few lines', () => {
  const text = postprocessFimCompletion('one\ntwo\nthree\nfour\nfive', '');
  assert.equal(text.split('\n').length, FIM_MAX_LINES);
});

test('only completes when the caret sits on real code', () => {
  assert.equal(isWorthCompleting('const total = calcul'), true);
  assert.equal(isWorthCompleting('callApi('), true);
  assert.equal(isWorthCompleting('line one\n'), false);
  assert.equal(isWorthCompleting('   '), false);
});
