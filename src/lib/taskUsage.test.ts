import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheHitRate } from './taskUsage';

test('cacheHitRate is cached/input as a whole percentage', () => {
  assert.equal(cacheHitRate(40, 100), 40);
  assert.equal(cacheHitRate(1, 3), 33);
  assert.equal(cacheHitRate(100, 100), 100);
});

test('cacheHitRate is null (unknown), never a misleading 0%, when unmeasurable', () => {
  assert.equal(cacheHitRate(0, 100), null, 'nothing cached is unknown, not 0%');
  assert.equal(cacheHitRate(40, 0), null, 'no input reported');
  assert.equal(cacheHitRate(null, 100), null);
  assert.equal(cacheHitRate(40, null), null);
  assert.equal(cacheHitRate(undefined, undefined), null);
});