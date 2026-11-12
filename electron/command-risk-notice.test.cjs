'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_RISK_NOTICE_CHARS, sanitizeRiskNotice } = require('./command-risk-notice.cjs');

test('a renderer notice reaches the dialog as one line', () => {
  const notice = sanitizeRiskNotice('This deletes files.\n\nIt also runs a script.');
  assert.equal(notice, 'This deletes files. It also runs a script.');
  assert.equal(notice.includes('\n'), false);
});

test('control characters cannot smuggle escape sequences or fake dialog lines', () => {
  const notice = sanitizeRiskNotice('a\u0000b\u001b[31mred\u001b[0mc\r\nd\u0007');
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(notice), false);
  assert.equal(notice.includes('\n'), false);
  assert.equal(notice.includes('\r'), false);
});

test('an untrusted notice is capped so it cannot push the command off-screen', () => {
  const notice = sanitizeRiskNotice('x'.repeat(MAX_RISK_NOTICE_CHARS + 500));
  assert.equal(notice.length, MAX_RISK_NOTICE_CHARS);
});

test('anything that is not a string becomes no notice at all', () => {
  for (const value of [undefined, null, 0, 42, true, false, {}, [], ['a'], () => 'a', Symbol('s')]) {
    assert.equal(sanitizeRiskNotice(value), '', `value: ${String(value)}`);
  }
});

test('blank or whitespace-only input collapses to no notice', () => {
  for (const value of ['', '   ', '\n\n', '\t', ' \u0000 ']) {
    assert.equal(sanitizeRiskNotice(value), '');
  }
});

test('ordinary risk wording survives untouched', () => {
  const notice = 'rm -rf removes files and directories outside this workspace.';
  assert.equal(sanitizeRiskNotice(notice), notice);
});
