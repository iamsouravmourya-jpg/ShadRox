import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminalStateManager } from '../lib/terminal/state';
import { setTerminalRunRouter, subscribeTerminalDockEvents } from '../lib/terminal/echoChannel';
import { injectStdinWithApproval, setTerminalDockMounted, wasInjected } from '../lib/terminal/injectStdin';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(path.join(here, 'TerminalPanel.tsx'), 'utf8');

// TerminalPanel.tsx imports xterm and CSS, which cannot load under node --test.
// The write queue is written in plain JS syntax inside the component file, so
// (like main.test.cjs) it is extracted from source and evaluated directly.
function extractWriteQueue() {
  const start = panelSource.indexOf('export function createTerminalWriteQueue(');
  assert.notEqual(start, -1, 'createTerminalWriteQueue must exist in TerminalPanel.tsx');
  const end = panelSource.indexOf('\n}', start);
  assert.notEqual(end, -1, 'createTerminalWriteQueue must end with a top-level closing brace');
  const fnText = panelSource.slice(start, end + 2).replace('export ', '');
  return new Function(
    'MAX_TERMINAL_WRITE_QUEUE_BYTES', 'TERMINAL_WRITE_BATCH_BYTES',
    `${fnText}\nreturn createTerminalWriteQueue;`
  )(512 * 1024, 64 * 1024) as (options: Record<string, unknown>) => {
    push(data: string): void;
    pushExit(code: number | null): void;
    drain(): void;
    stats(): { queuedBytes: number; droppedBytes: number; items: number; inFlight: boolean };
    clear(): void;
    dispose(): void;
  };
}

const createTerminalWriteQueue = extractWriteQueue();

/** Fake xterm: writes are captured; callbacks fire only when released. */
function fakeTerminal() {
  const writes: string[] = [];
  const waiting: Array<() => void> = [];
  const scheduled: Array<() => void> = [];
  const exits: Array<number | null> = [];
  const recorded: string[] = [];
  const queue = createTerminalWriteQueue({
    write(text: string, done: () => void) { writes.push(text); waiting.push(done); },
    record(text: string) { recorded.push(text); },
    onExit(code: number | null) { exits.push(code); },
    schedule(fn: () => void) { scheduled.push(fn); }
  });
  const releaseOne = () => {
    const done = waiting.shift();
    if (done) done();
    const next = scheduled.shift();
    if (next) next();
  };
  const releaseAll = () => {
    let guard = 0;
    while ((waiting.length > 0 || scheduled.length > 0) && guard < 100_000) { releaseOne(); guard += 1; }
  };
  return { writes, recorded, exits, queue, releaseOne, releaseAll, pendingWrites: () => waiting.length };
}

test('a prompt write with NO newline reaches the terminal buffer immediately (fast path)', () => {
  const t = fakeTerminal();
  t.queue.push('enter first digit: ');
  assert.deepEqual(t.writes, ['enter first digit: '], 'the prompt is written in the same turn, no timer');
  assert.deepEqual(t.recorded, ['enter first digit: '], 'the transcript/state path sees the prompt too');
  t.releaseAll();
  // A prompt ending in a complete CSI (colour reset) must be written RAW: the
  // shell-integration parser would withhold that tail until the next chunk,
  // which never comes while the program waits on stdin.
  t.queue.push('Overwrite? [y/N] \x1b[0m');
  assert.equal(t.writes[1], 'Overwrite? [y/N] \x1b[0m', 'ESC-terminated prompts are not withheld');
});

test('the display path no longer writes parser cleanText (the hidden-prompt root cause)', () => {
  assert.equal(panelSource.includes('terminal.write(clean)'), false, 'cleanText must not drive the display');
  assert.ok(panelSource.includes('terminalStateManager.feed(session.key, text)'), 'state is still fed from the raw stream');
  assert.ok(panelSource.includes('writeQueue.push(output.data)'), 'pty data rides the bounded queue');
});

test('heavy output is coalesced into bounded batches with zero loss', () => {
  const t = fakeTerminal();
  const chunks = Array.from({ length: 400 }, (_, i) => `chunk-${i}\r\n`);
  const big = chunks.map((c) => c.repeat(100)); // ~440KB total, under the 512KB cap
  for (const chunk of big) t.queue.push(chunk);
  const stats = t.queue.stats();
  assert.equal(stats.droppedBytes, 0, 'nothing under the cap may be dropped');
  assert.ok(stats.queuedBytes <= 512 * 1024, 'the queue stays bounded');
  t.releaseAll();
  const written = t.writes.join('');
  assert.equal(written, big.join(''), 'every byte arrives, in order');
  assert.ok(t.writes.length < big.length / 10, `expected coalescing, got ${t.writes.length} writes for ${big.length} chunks`);
  for (const write of t.writes) {
    assert.ok(write.length <= 64 * 1024 + big[0].length, 'batches stay near the batch cap');
  }
});

test('an unbounded flood cannot grow the queue: oldest bytes drop with a visible marker', () => {
  const t = fakeTerminal();
  const chunk = 'x'.repeat(1024);
  const count = 2000; // 2MB against a 512KB cap
  for (let i = 0; i < count; i += 1) t.queue.push(chunk);
  const stats = t.queue.stats();
  assert.ok(stats.queuedBytes <= 512 * 1024, `queue must stay bounded, got ${stats.queuedBytes}`);
  assert.ok(stats.droppedBytes > 0, 'the flood overflow is counted, not silent');
  t.releaseAll();
  const written = t.writes.join('');
  assert.ok(written.includes('[shadrox] skipped'), 'the user is told output was skipped');
  assert.ok(written.includes(chunk), 'newest output survives');
  const totalAccounted = written.replace(/\r\n\x1b\[90m\[shadrox\] skipped \d+ bytes of output to keep the terminal responsive\x1b\[0m\r\n/g, '').length + stats.droppedBytes;
  assert.equal(totalAccounted, count * 1024, 'written + dropped accounts for every pushed byte');
});

test('exit is ordered after queued data and never dropped', () => {
  const t = fakeTerminal();
  t.queue.push('last output');
  t.queue.pushExit(3);
  assert.deepEqual(t.exits, [], 'exit waits for the in-flight write');
  t.releaseAll();
  assert.deepEqual(t.writes, ['last output']);
  assert.deepEqual(t.exits, [3], 'exit fires after the data, with its code');
});

test('clear drops stale queued output on restart without killing the queue', () => {
  const t = fakeTerminal();
  t.queue.push('old shell output'); // fast path, in flight
  t.queue.push('stale tail');
  t.queue.pushExit(1);
  t.queue.clear();
  t.releaseAll();
  assert.deepEqual(t.writes, ['old shell output'], 'only the in-flight write completes');
  assert.deepEqual(t.exits, [], 'the old shell exit does not fire after a restart');
  t.queue.push('new shell prompt: ');
  assert.equal(t.writes[1], 'new shell prompt: ', 'the queue still serves the new shell immediately');
});

test('terminal_state sees a running command awaiting input after a no-newline prompt', () => {
  const sessionId = 'queue-test-session';
  // OSC 633;C marks the command as executing; the prompt itself has no newline.
  terminalStateManager.feed(sessionId, '\x1b]633;E;node game.js\x07\x1b]633;C\x07');
  terminalStateManager.feed(sessionId, 'enter first digit: \x1b[0m');
  const summary = terminalStateManager.getSummaryFor(sessionId, Date.now() + 11_000);
  assert.equal(summary.isExecuting, true);
  assert.equal(summary.activeCommand, 'node game.js');
  assert.equal(summary.awaitingInput, true, 'the agent is told the command waits on stdin');
  terminalStateManager.dropSession(sessionId);
});

test('terminal_answer input travels the approval gate and run router into the pty write', async () => {
  const sessionId = 'answer-test-session';
  const ptyWrites: string[] = [];
  terminalStateManager.feed(sessionId, '\x1b]633;C\x07');
  setTerminalDockMounted(true);
  const unsubscribe = subscribeTerminalDockEvents(() => {});
  setTerminalRunRouter((event) => {
    // This is exactly what TerminalSurface.run does with an approved answer.
    ptyWrites.push(`${event.command}\r`);
    return true;
  });
  try {
    const outcome = await injectStdinWithApproval(sessionId, 'y', { confirm: async () => true });
    assert.equal(wasInjected(outcome), true);
    assert.deepEqual(ptyWrites, ['y\r'], 'the approved answer reaches the pty write path');
    const refused = await injectStdinWithApproval(sessionId, 'y', { confirm: async () => false });
    assert.equal(wasInjected(refused), false);
    assert.deepEqual(ptyWrites, ['y\r'], 'a cancelled answer types nothing');
  } finally {
    setTerminalRunRouter(null);
    unsubscribe();
    setTerminalDockMounted(false);
    terminalStateManager.dropSession(sessionId);
  }
});