import assert from 'node:assert/strict';
import { card } from './card.mjs';
import { displayName } from './name.mjs';
import { greet } from './greet.mjs';

// The behaviour a refactor must not change.
assert.equal(greet({ name: 'ayush' }), 'Hello, AYUSH!');
assert.equal(greet({}), 'Hello, FRIEND!');
assert.equal(card({ name: 'ayush' }), 'Hello, AYUSH! — welcome back, ayush.');
assert.equal(card({}), 'Hello, FRIEND! — welcome back, friend.');

// The helper both call sites now share.
assert.equal(displayName({ name: 'ayush' }), 'ayush');
assert.equal(displayName({ handle: 'priya' }), 'priya');
assert.equal(displayName({}), 'friend');

console.log('greet: ok');
