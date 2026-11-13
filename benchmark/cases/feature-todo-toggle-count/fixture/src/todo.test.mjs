import assert from 'node:assert/strict';
import test from 'node:test';
import { add, clear, list, remaining, toggle } from './todo.mjs';

test('add() returns the index it stored the title at', () => {
  clear();
  assert.equal(add('write the fixture'), 0);
  assert.equal(add('hide the bug'), 1);
  assert.deepEqual(list(), ['0: [ ] write the fixture', '1: [ ] hide the bug']);
});

test('toggle() flips an item and remaining() counts what is left', () => {
  clear();
  add('ship it');
  add('test it');
  assert.equal(remaining(), 2);
  assert.equal(toggle(0).done, true);
  assert.deepEqual(list(), ['0: [x] ship it', '1: [ ] test it']);
  assert.equal(remaining(), 1);
  assert.equal(toggle(0).done, false);
  assert.equal(remaining(), 2);
});

test('toggle() refuses an index that was never added', () => {
  clear();
  assert.throws(() => toggle(0), /no todo at index 0/);
});
