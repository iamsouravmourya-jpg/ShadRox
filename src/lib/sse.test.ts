import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseDecoder, type SseEvent } from './sse';

function collect(chunks: string[], flush = true): SseEvent[] {
  const events: SseEvent[] = [];
  const decoder = createSseDecoder((event) => events.push(event));
  chunks.forEach((chunk) => decoder.push(chunk));
  if (flush) decoder.flush();
  return events;
}

test('decodes a data event split across chunks', () => {
  const events = collect(['data: {"type":"del', 'ta","text":"hi"}\n\n']);
  assert.deepEqual(events, [{ event: 'message', data: '{"type":"delta","text":"hi"}' }]);
});

test('handles CRLF line endings', () => {
  const events = collect(['data: one\r\n\r\ndata: two\r\n\r\n']);
  assert.deepEqual(events.map((event) => event.data), ['one', 'two']);
});

test('joins multi-line data fields with newlines', () => {
  const events = collect(['data: line 1\ndata: line 2\n\n']);
  assert.deepEqual(events, [{ event: 'message', data: 'line 1\nline 2' }]);
});

test('ignores comments and keeps event names', () => {
  const events = collect([': keep-alive\n', 'event: delta\ndata: payload\n\n']);
  assert.deepEqual(events, [{ event: 'delta', data: 'payload' }]);
});

test('flushes a final event that has no trailing blank line', () => {
  const events = collect(['data: last'], true);
  assert.deepEqual(events, [{ event: 'message', data: 'last' }]);
});

test('does not emit empty dispatches for keep-alive comments', () => {
  const events = collect([': ping\n\n', ': ping\n\n']);
  assert.deepEqual(events, []);
});
