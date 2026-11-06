import assert from 'node:assert/strict';
import test from 'node:test';
import { isHoverableIdentifier } from './hoverValues';

test('hover evaluation is limited to one dotted identifier', () => {
  for (const name of ['answer', 'user', '$ref', '_tmp', 'state.count', 'a.b.c']) {
    assert.equal(isHoverableIdentifier(name), true, name);
  }
  // Anything that could execute, index, call or span lines is not a hover.
  for (const name of ['', 'a b', 'fn()', 'items[0]', 'a\nprocess.exit()', 'x = 1', 'foo;bar', '`tpl`', '1ac']) {
    assert.equal(isHoverableIdentifier(name), false, JSON.stringify(name));
  }
});
