import assert from 'node:assert/strict';
import test from 'node:test';
import { createFailureRepeatTracker, failureNudge, failureBlockMessage } from './stuck';

const fail = (key: string, error: string) => ({ key, ok: false, error });

test('the first failure is silent; the second identical one nudges', () => {
  const tracker = createFailureRepeatTracker();
  assert.equal(tracker.note(fail('k', 'ENOENT')), null);
  assert.equal(tracker.note(fail('k', 'ENOENT')), 'nudge');
  assert.equal(tracker.isBlocked('k'), false);
});

test('the third identical failure blocks the call for the turn', () => {
  const tracker = createFailureRepeatTracker();
  tracker.note(fail('k', 'boom'));
  tracker.note(fail('k', 'boom'));
  assert.equal(tracker.note(fail('k', 'boom')), 'block');
  assert.equal(tracker.isBlocked('k'), true);
  assert.equal(tracker.note(fail('k', 'boom')), null, 'already blocked; no repeat verdict');
});

test('a different error on the same call is new information and resets the run', () => {
  const tracker = createFailureRepeatTracker();
  tracker.note(fail('k', 'error one'));
  tracker.note(fail('k', 'error two'));
  assert.equal(tracker.note(fail('k', 'error two')), 'nudge', 'the run restarted at error two');
  assert.equal(tracker.isBlocked('k'), false);
});

test('whitespace differences do not make a new error', () => {
  const tracker = createFailureRepeatTracker();
  tracker.note(fail('k', 'ENOENT:  no such\n file'));
  assert.equal(tracker.note(fail('k', 'ENOENT: no such file')), 'nudge');
});

test('a success or a guard refusal never counts', () => {
  const tracker = createFailureRepeatTracker();
  assert.equal(tracker.note({ key: 'k', ok: true }), null);
  assert.equal(tracker.note({ key: 'k', ok: false, refused: true, error: 'guard said no' }), null);
  assert.equal(tracker.note(fail('k', 'real failure')), null, 'the refusal did not start a run');
});

test('different calls track independently', () => {
  const tracker = createFailureRepeatTracker();
  tracker.note(fail('a', 'x'));
  tracker.note(fail('b', 'x'));
  assert.equal(tracker.note(fail('a', 'x')), 'nudge');
  assert.equal(tracker.isBlocked('b'), false);
});

test('reset clears runs and blocks after a successful mutation', () => {
  const tracker = createFailureRepeatTracker();
  tracker.note(fail('k', 'x'));
  tracker.note(fail('k', 'x'));
  tracker.note(fail('k', 'x'));
  assert.equal(tracker.isBlocked('k'), true);
  tracker.reset();
  assert.equal(tracker.isBlocked('k'), false, 'a verify blocked before a fix is free after it');
  assert.equal(tracker.note(fail('k', 'x')), null, 'the run starts over');
});

test('the nudge and block messages name the call and the next step', () => {
  assert.match(failureNudge('edit_file · a.ts'), /failed the same way twice/);
  assert.match(failureNudge('edit_file · a.ts'), /change approach/);
  assert.match(failureBlockMessage('edit_file · a.ts'), /blocked/);
  assert.match(failureBlockMessage('edit_file · a.ts'), /three times/);
});