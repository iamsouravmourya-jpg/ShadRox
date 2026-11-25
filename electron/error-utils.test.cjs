'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unwrapErrorMessage } = require('./error-utils.cjs');

test('unwrapErrorMessage extracts AggregateError children when message is empty and errors is a getter', () => {
  const child1 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5173'), { code: 'ECONNREFUSED' });
  const child2 = Object.assign(new Error('connect ECONNREFUSED ::1:5173'), { code: 'ECONNREFUSED' });
  const agg = new AggregateError([child1, child2], '');

  // Simulate Electron/Chrome IPC getter behavior
  Object.defineProperty(agg, 'errors', {
    get() {
      return [child1, child2];
    }
  });

  const result = unwrapErrorMessage(agg);
  assert.ok(result.includes('ECONNREFUSED'));
  assert.ok(result.includes('127.0.0.1:5173'));
  assert.equal(result.includes('[Getter/Setter]'), false);
});

test('unwrapErrorMessage unwraps nested fetch TypeError causes and protects against cycles', () => {
  const root = Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' });
  const wrapped = new TypeError('fetch failed', { cause: root });
  const text = unwrapErrorMessage(wrapped);
  assert.ok(text.includes('fetch failed'));
  assert.ok(text.includes('network timeout'));

  const cyclic = { message: 'loop' };
  cyclic.cause = cyclic;
  assert.equal(unwrapErrorMessage(cyclic), 'loop');
  assert.equal(unwrapErrorMessage(null), 'Unknown error');
  assert.equal(unwrapErrorMessage('[errors]: [Getter/Setter]'), 'Unknown error');
});
