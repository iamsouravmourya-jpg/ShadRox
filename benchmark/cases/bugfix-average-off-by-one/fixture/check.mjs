import assert from 'node:assert/strict';
import { average } from './average.mjs';

assert.equal(average([]), 0);
assert.equal(average([2, 4]), 3);
assert.equal(average([1, 2, 3, 4]), 2.5);
console.log('average: ok');
