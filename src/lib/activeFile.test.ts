import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveFileIndex } from './activeFile';

test('an unselected index still points at the file that is on screen', () => {
  // Mounting a workspace leaves the selection at -1 while the editor shows the
  // first document. Keystrokes used to be written to files[-1], so the edit
  // never reached state and could never be saved.
  assert.equal(resolveActiveFileIndex(-1, 1), 0);
  assert.equal(resolveActiveFileIndex(-1, 12), 0);
});

test('a selected index is used unchanged', () => {
  assert.equal(resolveActiveFileIndex(0, 12), 0);
  assert.equal(resolveActiveFileIndex(7, 12), 7);
});

test('an index past the end falls back to the rendered file', () => {
  assert.equal(resolveActiveFileIndex(12, 12), 0);
  assert.equal(resolveActiveFileIndex(40, 3), 0);
});

test('an empty workspace has no active file', () => {
  assert.equal(resolveActiveFileIndex(-1, 0), -1);
  assert.equal(resolveActiveFileIndex(0, 0), -1);
});
