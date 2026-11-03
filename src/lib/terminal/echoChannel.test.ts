import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_QUEUED_TERMINAL_EVENTS,
  clearTerminalDockQueue,
  formatDuration,
  formatTerminalDockEvent,
  isSafeCommandLine,
  pendingTerminalDockEvents,
  publishTerminalDockEvent,
  sanitizeEchoLine,
  subscribeTerminalDockEvents,
  truncateEchoOutput
} from './echoChannel';
import type { TerminalDockEvent } from './echoChannel';

function withSubscriber(run: (received: TerminalDockEvent[]) => void): void {
  clearTerminalDockQueue();
  const received: TerminalDockEvent[] = [];
  const unsubscribe = subscribeTerminalDockEvents((event) => received.push(event));
  try {
    run(received);
  } finally {
    unsubscribe();
    clearTerminalDockQueue();
  }
}

test('a command echo is one visible line carrying its source', () => {
  const text = formatTerminalDockEvent({ kind: 'command', command: 'npm test', source: 'assistant' });
  assert.match(text, /\[assistant\] \$/);
  assert.equal(text.includes('\x1b[1mnpm test\x1b[0m'), true);
  assert.equal(formatTerminalDockEvent({ kind: 'command', command: '   ', source: 'user' }), '');
});

test('a result line names the exit code, the source and the duration', () => {
  const ok = formatTerminalDockEvent({
    kind: 'result',
    command: 'npm run build',
    source: 'assistant',
    exitCode: 0,
    durationMs: 1250,
    stdout: 'vite built in 1s'
  });
  assert.match(ok, /exit 0/);
  assert.match(ok, /\[assistant ran\] npm run build \(1\.3s\)/);
  assert.match(ok, /vite built in 1s/);

  const failed = formatTerminalDockEvent({ kind: 'result', command: 'git push', source: 'user', exitCode: 128, stderr: 'rejected' });
  assert.match(failed, /exit 128/);
  assert.match(failed, /rejected/);

  const signalled = formatTerminalDockEvent({ kind: 'result', command: 'npm run dev', source: 'system', exitCode: null, signal: 'SIGTERM' });
  assert.match(signalled, /terminated by SIGTERM/);
  assert.match(signalled, /\(no output\)/);
});

test('command text cannot smuggle escapes or control bytes into the transcript', () => {
  // A full CSI sequence is dropped, not merely neutralised, so `clear` cannot fire.
  assert.equal(sanitizeEchoLine('npm \x1b[2Jtest\x07'), 'npm test');
  assert.equal(sanitizeEchoLine('a\nb'), 'a b');
  assert.equal(sanitizeEchoLine('x'.repeat(50), 10), 'xxxxxxxxxx [trimmed]');
  // The formatter's own colour sequences (dim, reset, bold, reset) are the only
  // escapes allowed through: 4 sequences = 5 split parts.
  assert.equal(formatTerminalDockEvent({
    kind: 'command',
    command: 'echo \x1b[31mred\x1b[0m',
    source: 'assistant'
  }).split('\x1b').length, 5);
});

test('only a single printable line may be typed into a live shell', () => {
  assert.equal(isSafeCommandLine('npm run build'), true);
  assert.equal(isSafeCommandLine('git commit -m "fixed the diff view"'), true);
  assert.equal(isSafeCommandLine('npm run build\nrm -rf /'), false);
  assert.equal(isSafeCommandLine('powershell -Command "Get-Process\taskhostw.exe"'), false);
  assert.equal(isSafeCommandLine('\x1b[2J'), false);
  assert.equal(isSafeCommandLine('   '), false);
  assert.equal(isSafeCommandLine('x'.repeat(2001)), false);
});

test('long output is truncated with a marker instead of flooding the scrollback', () => {
  assert.equal(truncateEchoOutput('abc', 10), 'abc');
  const long = truncateEchoOutput('y'.repeat(30), 10);
  assert.equal(long.startsWith('y'.repeat(10)), true);
  assert.match(long, /truncated/);
});

test('durations are human scale and unknown durations disappear', () => {
  assert.equal(formatDuration(420), '420ms');
  assert.equal(formatDuration(9_500), '9.5s');
  assert.equal(formatDuration(75_000), '1m 15s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-5), '');
});

test('events published while the dock is closed are queued and flushed on mount', () => {
  clearTerminalDockQueue();
  assert.equal(publishTerminalDockEvent({ kind: 'command', command: 'ls', source: 'assistant' }), false);
  assert.equal(publishTerminalDockEvent({ kind: 'result', command: 'ls', source: 'assistant', exitCode: 0 }), false);
  assert.equal(pendingTerminalDockEvents().length, 2);

  const received: TerminalDockEvent[] = [];
  const unsubscribe = subscribeTerminalDockEvents((event) => received.push(event));
  assert.equal(received.length, 2);
  assert.deepEqual(received.map((event) => event.kind), ['command', 'result']);
  assert.equal(pendingTerminalDockEvents().length, 0);
  unsubscribe();
});

test('the queue is bounded and drops the oldest events', () => {
  clearTerminalDockQueue();
  const published = MAX_QUEUED_TERMINAL_EVENTS + 6;
  for (let index = 0; index < published; index += 1) {
    publishTerminalDockEvent({ kind: 'command', command: `echo ${index}`, source: 'system' });
  }
  const pending = pendingTerminalDockEvents();
  assert.equal(pending.length, MAX_QUEUED_TERMINAL_EVENTS);
  const first = pending[0];
  const last = pending[pending.length - 1];
  assert.equal(first.kind === 'command' && first.command, `echo ${published - MAX_QUEUED_TERMINAL_EVENTS}`);
  assert.equal(last.kind === 'command' && last.command, `echo ${published - 1}`);
  clearTerminalDockQueue();
});

test('a live dock receives events immediately and nothing is queued', () => {
  withSubscriber((received) => {
    assert.equal(publishTerminalDockEvent({ kind: 'command', command: 'npm i', source: 'user', run: true }), true);
    assert.equal(received.length, 1);
    assert.equal(pendingTerminalDockEvents().length, 0);
  });
});

test('an empty command is never delivered', () => {
  withSubscriber((received) => {
    assert.equal(publishTerminalDockEvent({ kind: 'command', command: '   ', source: 'user' }), false);
    assert.equal(received.length, 0);
  });
});
