import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFinish, FINISH_TOOL_NAME, parseFinishArguments } from './finishTool';

test('finish is the tool name the loop must honour', () => {
  assert.equal(FINISH_TOOL_NAME, 'finish');
});

test('a summary and a blocked reason come back trimmed', () => {
  const parsed = parseFinishArguments({ summary: '  added the export  ', blocked: ' no test runner installed ' });
  assert.deepEqual(parsed, { summary: 'added the export', blocked: 'no test runner installed' });
});

test('blocked is null when it is missing, blank or not text', () => {
  for (const raw of [{ summary: 'done' }, { summary: 'done', blocked: '   ' }, { summary: 'done', blocked: 7 }, { summary: 'done', blocked: null }]) {
    assert.deepEqual(parseFinishArguments(raw), { summary: 'done', blocked: null });
  }
});

test('a bare string is the summary', () => {
  assert.deepEqual(parseFinishArguments('  the export is wired up '), { summary: 'the export is wired up', blocked: null });
});

test('the keys the model reaches for instead of summary still parse', () => {
  assert.deepEqual(parseFinishArguments({ answer: 'read the folder' }), { summary: 'read the folder', blocked: null });
  assert.deepEqual(parseFinishArguments({ result: 'read it', reason: 'missing key' }), { summary: 'read it', blocked: 'missing key' });
});

test('an argument set with no summary is unusable', () => {
  for (const raw of [null, undefined, 0, '', '   ', {}, { blocked: 'why' }, { summary: 42 }, [], ['done']]) {
    assert.equal(parseFinishArguments(raw), null);
  }
});

test('the finish paragraph teaches the end-of-turn rules', () => {
  const text = describeFinish();
  assert.match(text, /FINISHING THE TURN/);
  assert.match(text, /"name":"finish"/);
  assert.match(text, /ends the turn/);
  assert.match(text, /no tool call after it/);
  assert.match(text, /"blocked"/);
  assert.doesNotMatch(text, /\n/);
});
