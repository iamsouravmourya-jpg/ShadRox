import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TERMINAL_TRANSCRIPTS,
  TERMINAL_MAX_LINE_LENGTH,
  TERMINAL_RING_LINES,
  appendTerminalTranscript,
  createLineRing,
  dropTerminalTranscript,
  peekTerminalTranscriptLineCount,
  takeTerminalTranscript,
  terminalTranscriptKey
} from './ringBuffer';

test('a ring keeps the newest lines and drops the oldest past its capacity', () => {
  const ring = createLineRing(3);
  for (const line of ['one', 'two', 'three', 'four', 'five']) ring.push(`${line}\n`);
  assert.deepEqual(ring.lines(), ['three', 'four', 'five']);
  assert.equal(ring.lineCount(), 3);
});

test('a line split across chunks stays one line', () => {
  const ring = createLineRing(10);
  ring.push('npm run ');
  ring.push('build\nnext');
  assert.deepEqual(ring.lines(), ['npm run build']);
  ring.push('\nline\r\n');
  assert.deepEqual(ring.lines(), ['npm run build', 'next', 'line']);
});

test('carriage returns break lines and \r\n counts once', () => {
  const ring = createLineRing(10);
  ring.push('a\rb\r\n');
  assert.deepEqual(ring.lines(), ['a', 'b']);
});

test('a monster line is truncated instead of being kept whole', () => {
  const ring = createLineRing(4);
  ring.push(`${'x'.repeat(TERMINAL_MAX_LINE_LENGTH + 500)}\n`);
  assert.equal(ring.lines()[0].length, TERMINAL_MAX_LINE_LENGTH + '... truncated ...'.length);
  assert.match(ring.lines()[0], /truncated \.\.\.$/);
});

test('ansi colour bytes survive the round trip', () => {
  const ring = createLineRing(4);
  ring.push('\x1b[32mgreen\x1b[0m text\n');
  const key = terminalTranscriptKey('ws-a', 'tab-1');
  appendTerminalTranscript(key, '\x1b[32mgreen\x1b[0m text\nsecond\n');
  assert.equal(takeTerminalTranscript(key), '\x1b[32mgreen\x1b[0m text\r\nsecond\r\n');
});

test('taking a transcript consumes it so a re-mounted tab is not printed twice', () => {
  const key = terminalTranscriptKey('ws-b', 'tab-2');
  appendTerminalTranscript(key, 'output\n');
  assert.equal(takeTerminalTranscript(key), 'output\r\n');
  assert.equal(takeTerminalTranscript(key), '');
  assert.equal(peekTerminalTranscriptLineCount(key), 0);
});

test('take can ask for fewer lines than the ring holds', () => {
  const key = terminalTranscriptKey('ws-c', 'tab-3');
  appendTerminalTranscript(key, 'one\ntwo\nthree\n');
  assert.equal(takeTerminalTranscript(key, 2), 'two\r\nthree\r\n');
});

test('transcripts are bounded across sessions and drop cleanly', () => {
  for (let index = 0; index < MAX_TERMINAL_TRANSCRIPTS + 5; index += 1) {
    appendTerminalTranscript(terminalTranscriptKey('ws-d', `tab-${index}`), 'x\n');
  }
  const oldest = terminalTranscriptKey('ws-d', 'tab-0');
  assert.equal(peekTerminalTranscriptLineCount(oldest), 0);
  const newest = terminalTranscriptKey('ws-d', `tab-${MAX_TERMINAL_TRANSCRIPTS + 4}`);
  assert.equal(peekTerminalTranscriptLineCount(newest), 1);
  dropTerminalTranscript(newest);
  assert.equal(peekTerminalTranscriptLineCount(newest), 0);
});

test('the default capacity matches the documented line count', () => {
  const ring = createLineRing();
  for (let index = 0; index < TERMINAL_RING_LINES + 50; index += 1) ring.push(`line ${index}\n`);
  assert.equal(ring.lineCount(), TERMINAL_RING_LINES);
  assert.equal(ring.lines()[ring.lines().length - 1], `line ${TERMINAL_RING_LINES + 49}`);
});
