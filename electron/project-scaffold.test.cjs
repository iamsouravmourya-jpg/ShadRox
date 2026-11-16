'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeProjectName, MAX_NAME_LENGTH } = require('./project-scaffold.cjs');

test('a plain name passes through trimmed', () => {
  assert.equal(sanitizeProjectName('  my-app  '), 'my-app');
  assert.equal(sanitizeProjectName('My Project'), 'My Project');
});

test('trailing dots and spaces are stripped, Windows-style', () => {
  assert.equal(sanitizeProjectName('demo...'), 'demo');
  assert.equal(sanitizeProjectName('demo. .'), 'demo');
});

test('empty and non-string names are refused', () => {
  for (const bad of ['', '   ', '...', null, undefined, 42]) {
    assert.throws(() => sanitizeProjectName(bad), /name/i);
  }
});

test('path separators and Windows-illegal characters are refused, not stripped', () => {
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    assert.throws(() => sanitizeProjectName(bad), /cannot contain/);
  }
});

test('traversal and dot-folder names are refused', () => {
  assert.throws(() => sanitizeProjectName('..'), /not a project name/);
  assert.throws(() => sanitizeProjectName('.hidden'), /dot/);
});

test('control characters are refused', () => {
  assert.throws(() => sanitizeProjectName('a\u0000b'), /control characters/);
  assert.throws(() => sanitizeProjectName('a\nb'), /control characters/);
});

test('Windows reserved device names are refused, with or without an extension', () => {
  for (const bad of ['CON', 'con', 'NUL.txt', 'com1', 'LPT9.log', 'aux']) {
    assert.throws(() => sanitizeProjectName(bad), /reserved/);
  }
  assert.equal(sanitizeProjectName('console'), 'console');
});

test('overlong names are refused', () => {
  assert.throws(() => sanitizeProjectName('x'.repeat(MAX_NAME_LENGTH + 1)), /under 64/);
  assert.equal(sanitizeProjectName('x'.repeat(MAX_NAME_LENGTH)).length, MAX_NAME_LENGTH);
});

// The sanitizer rejects every character that could open a tag or attribute.
test('a name shaped like markup is refused outright', () => {
  assert.throws(() => sanitizeProjectName('<img src=x onerror=alert(1)>'), /cannot contain/);
  assert.throws(() => sanitizeProjectName("a\"><script>alert(1)</script>"), /cannot contain/);
});
