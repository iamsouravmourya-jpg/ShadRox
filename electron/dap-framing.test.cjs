'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFrameParser, encodeFrame, encodeFrameBuffer } = require('./dap-framing.cjs');

function parseAll(chunks, options = {}) {
  const messages = [];
  const errors = [];
  const parser = createFrameParser({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
    ...options
  });
  for (const chunk of chunks) parser.push(chunk);
  return { messages, errors, parser };
}

test('encodeFrame writes a Content-Length that equals the UTF-8 byte length', () => {
  const message = { seq: 1, type: 'event', event: 'output', body: { output: 'héllo ✓' } };
  const frame = encodeFrame(message);
  const match = /^Content-Length: (\d+)\r\n\r\n/.exec(frame);
  assert.ok(match, `expected a header, got ${frame.slice(0, 40)}`);
  const body = frame.slice(match[0].length);
  assert.equal(Number(match[1]), Buffer.byteLength(body, 'utf8'));
  assert.deepEqual(JSON.parse(body), message);
  assert.deepEqual(encodeFrameBuffer(message), Buffer.from(frame, 'utf8'));
});

test('a header split across chunks yields exactly one message', () => {
  const frame = encodeFrame({ seq: 2, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } });
  const { messages, errors } = parseAll([frame.slice(0, 11), frame.slice(11, 22), frame.slice(22)]);
  assert.deepEqual(errors, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, 'stopped');
});

test('a body split mid-JSON is buffered until complete', () => {
  const frame = encodeFrame({
    seq: 3,
    type: 'response',
    request_seq: 2,
    success: true,
    command: 'threads',
    body: { threads: [{ id: 1, name: 'main' }] }
  });
  const bodyStart = frame.indexOf('{');
  const first = parseAll([frame.slice(0, bodyStart + 12)]);
  assert.equal(first.messages.length, 0, 'an incomplete body must not parse');
  assert.ok(first.parser.bufferedBytes > 0);

  const second = parseAll([frame.slice(0, bodyStart + 12), frame.slice(bodyStart + 12)]);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].request_seq, 2);
});

test('several frames in one chunk are dispatched in order', () => {
  const chunk = [
    encodeFrame({ seq: 1, type: 'event', event: 'initialized' }),
    encodeFrame({ seq: 2, type: 'event', event: 'output', body: { output: 'a' } }),
    encodeFrame({ seq: 3, type: 'event', event: 'output', body: { output: 'b' } })
  ].join('');
  const { messages } = parseAll([chunk]);
  assert.deepEqual(messages.map((message) => message.seq), [1, 2, 3]);
});

test('extra header lines are ignored and the terminator is found correctly', () => {
  const body = JSON.stringify({ seq: 1, type: 'event', event: 'initialized' });
  const frame = `X-Adapter: js-debug\r\nContent-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  const { messages, errors } = parseAll([frame]);
  assert.deepEqual(errors, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, 'initialized');
});

test('malformed JSON surfaces an error and keeps the parser usable', () => {
  const body = '{not json';
  const bad = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  const good = encodeFrame({ seq: 9, type: 'event', event: 'terminated' });
  const { messages, errors } = parseAll([bad + good]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not json/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, 'terminated');
});

test('a frame larger than the configured cap is rejected instead of buffered', () => {
  const body = JSON.stringify({ seq: 1, type: 'event', event: 'x', pad: 'y'.repeat(200) });
  const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  const { messages, errors } = parseAll([frame], { maxContentLength: 64 });
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeds the 64-byte limit/);
});

test('a header without Content-Length is reported and dropped', () => {
  const { messages, errors } = parseAll(['X-Thing: 1\r\n\r\n{"seq":1}']);
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /missing a valid Content-Length/);
});

test('reset drops partial state', () => {
  const frame = encodeFrame({ seq: 1, type: 'event', event: 'output', body: { output: 'x' } });
  const parser = createFrameParser({ onMessage: () => assert.fail('no message expected') });
  parser.push(frame.slice(0, 20));
  assert.ok(parser.bufferedBytes > 0);
  parser.reset();
  assert.equal(parser.bufferedBytes, 0);
});
