import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefixStripper } from './ai';

test('drops a fully echoed partial reply across chunk boundaries', () => {
  const strip = createPrefixStripper('The server starts');
  assert.equal(strip('The serv'), '');
  assert.equal(strip('er star'), '');
  assert.equal(strip('ts on port 3000.'), ' on port 3000.');
  // Later chunks pass through untouched once the echo is consumed.
  assert.equal(strip(' Then it binds.'), ' Then it binds.');
});

test('passes text through when the model continues without echoing', () => {
  const strip = createPrefixStripper('function add(a, b) { re');
  assert.equal(strip('turn a + b; }'), 'turn a + b; }');
});

test('stops stripping at the first divergence and keeps the rest', () => {
  const strip = createPrefixStripper('alpha beta');
  assert.equal(strip('alpha ga'), 'ga');
  assert.equal(strip('mma continues'), 'mma continues');
});

test('an empty prefix strips nothing', () => {
  const strip = createPrefixStripper('');
  assert.equal(strip('anything at all'), 'anything at all');
});

test('surrogate pairs are matched as whole code points', () => {
  const strip = createPrefixStripper('emoji 🎉 he');
  assert.equal(strip('emoji 🎉'), '');
  assert.equal(strip('llo'), 'llo');
});
