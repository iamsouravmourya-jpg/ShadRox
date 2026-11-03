import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInitialLayout,
  nearestKey,
  paneCount,
  paneSessionKeys,
  removePane,
  setRatioDeep,
  splitPane
} from './panes';

test('splitPane adds a horizontal or vertical sibling without mutating the input tree', () => {
  const initial = createInitialLayout('one');
  const horizontal = splitPane(initial.root, 'one', 'two', 'horizontal');
  assert.deepEqual(initial.root, { type: 'leaf', sessionKey: 'one' });
  assert.equal(paneCount(horizontal), 2);
  assert.deepEqual(paneSessionKeys(horizontal), ['one', 'two']);
  assert.equal(horizontal.type, 'split');
  if (horizontal.type === 'split') assert.equal(horizontal.orientation, 'horizontal');

  const vertical = splitPane(horizontal, 'two', 'three', 'vertical');
  assert.equal(paneCount(vertical), 3);
  assert.deepEqual(paneSessionKeys(vertical), ['one', 'two', 'three']);
  assert.equal(vertical.type, 'split');
  if (vertical.type === 'split' && vertical.second.type === 'split') {
    assert.equal(vertical.second.orientation, 'vertical');
  } else {
    assert.fail('Expected the second pane to be split vertically.');
  }
});

test('removePane collapses the parent split and identifies a surviving focus target', () => {
  const split = splitPane(createInitialLayout('one').root, 'one', 'two', 'horizontal');
  const threePanes = splitPane(split, 'two', 'three', 'vertical');

  assert.equal(nearestKey(threePanes, 'two'), 'three');
  const remaining = removePane(threePanes, 'two');
  assert.ok(remaining);
  assert.equal(paneCount(remaining), 2);
  assert.deepEqual(paneSessionKeys(remaining), ['one', 'three']);

  const only = removePane({ type: 'leaf', sessionKey: 'one' }, 'one');
  assert.equal(only, null);
});

test('setRatioDeep clamps the selected split and leaves other splits unchanged', () => {
  const root = splitPane(createInitialLayout('one').root, 'one', 'two', 'horizontal');
  if (root.type !== 'split') assert.fail('Expected a split root.');
  const nested = splitPane(root, 'two', 'three', 'vertical');
  if (nested.type !== 'split' || nested.second.type !== 'split') assert.fail('Expected a nested split.');

  const resized = setRatioDeep(nested, nested.second, 2);
  if (resized.type !== 'split' || resized.second.type !== 'split') assert.fail('Expected a nested split.');
  assert.equal(resized.ratio, 0.5);
  assert.equal(resized.second.ratio, 0.9);
  assert.equal(nested.second.ratio, 0.5);
});
