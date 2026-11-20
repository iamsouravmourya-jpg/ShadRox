const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

// main.cjs boots Electron when required, so the terminal output forwarder and
// the terminal IPC handlers are extracted from source and evaluated with their
// free variables injected (the same approach main.test.cjs uses).
const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in main.cjs`);
  const end = mainSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} must end with a top-level closing brace`);
  return mainSource.slice(start, end + 2);
}

function extractConstant(name) {
  const match = mainSource.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `${name} must be defined in main.cjs`);
  return new Function(`return ${match[1]};`)();
}

function extractHandler(channel) {
  const start = mainSource.indexOf(`handleMachineSensitive('${channel}'`);
  assert.notEqual(start, -1, `${channel} handler must exist`);
  const end = mainSource.indexOf('handleMachineSensitive(', start + 10);
  assert.notEqual(end, -1, `${channel} handler must be followed by another handler`);
  return mainSource.slice(start, end);
}

const COALESCE_MS = extractConstant('TERMINAL_OUTPUT_COALESCE_MS');
const FLUSH_BYTES = extractConstant('TERMINAL_OUTPUT_FLUSH_BYTES');
const PAUSE_BYTES = extractConstant('TERMINAL_OUTPUT_PAUSE_BYTES');

const createTerminalOutputForwarder = new Function(
  'TERMINAL_OUTPUT_COALESCE_MS', 'TERMINAL_OUTPUT_FLUSH_BYTES', 'TERMINAL_OUTPUT_PAUSE_BYTES',
  `${extractFunction('createTerminalOutputForwarder')}\nreturn createTerminalOutputForwarder;`
)(COALESCE_MS, FLUSH_BYTES, PAUSE_BYTES);

const terminalDescriptor = new Function('path', `${extractFunction('terminalDescriptor')}\nreturn terminalDescriptor;`)(path);

/** Deterministic clock: timers only fire when advance() is called. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending() { return timers.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = target;
    }
  };
}

function harness(options = {}) {
  const sent = [];
  const clock = fakeClock();
  const pauses = [];
  const resumes = [];
  const forwarder = createTerminalOutputForwarder((data) => sent.push(data), {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    pause: () => pauses.push(true),
    resume: () => resumes.push(true),
    ...options
  });
  return { sent, clock, pauses, resumes, forwarder };
}

test('a prompt write with NO newline is forwarded immediately, without waiting on any timer', () => {
  const { sent, clock, forwarder } = harness();
  forwarder.push('enter first digit: ');
  assert.deepEqual(sent, ['enter first digit: '], 'the prompt must reach the renderer in the same turn');
  assert.equal(forwarder.pendingBytes(), 0, 'no prompt bytes may sit in the buffer');
  clock.advance(COALESCE_MS); // the coalescing window closes; the next quiet spell is leading-edge again
  // A prompt that ends in a colour reset (a complete CSI, no BEL/ST) is still
  // forwarded verbatim — the forwarder never inspects or buffers by content.
  forwarder.push('Overwrite? [y/N] \x1b[0m');
  assert.equal(sent.length, 2);
  assert.equal(sent[1], 'Overwrite? [y/N] \x1b[0m');
});

test('sustained bursts coalesce onto one short timer instead of one IPC message per chunk', () => {
  const { sent, clock, forwarder } = harness();
  const chunks = Array.from({ length: 500 }, (_, i) => `line ${i}\r\n`);
  for (const chunk of chunks) forwarder.push(chunk);
  // Leading edge went out at once; the rest waits on a single timer.
  assert.ok(sent.length <= 2, `expected coalescing, got ${sent.length} sends for 500 chunks`);
  assert.equal(clock.pending(), 1);
  clock.advance(COALESCE_MS);
  assert.equal(sent.join(''), chunks.join(''), 'coalescing must not drop or reorder bytes');
  assert.ok(sent.length <= 3, 'a 500-chunk burst must arrive as a handful of messages');
});

test('pending bytes stay bounded and the pty is paused above the high-water mark, resumed on flush', () => {
  const { sent, clock, pauses, resumes, forwarder } = harness({ pauseBytes: 1024, flushBytes: 4096 });
  const block = 'x'.repeat(128);
  for (let i = 0; i < 16; i += 1) {
    forwarder.push(block);
    assert.ok(forwarder.pendingBytes() <= 4096, 'pending must never exceed the flush cap');
  }
  assert.equal(pauses.length, 1, 'the pty is paused once while the backlog is above the high-water mark');
  assert.equal(resumes.length, 0);
  clock.advance(COALESCE_MS);
  assert.equal(resumes.length, 1, 'the flush resumes the pty');
  assert.equal(forwarder.pendingBytes(), 0);
  assert.equal(sent.join('').length, 16 * 128, 'flow control must not lose bytes');
  // A single monster chunk flushes immediately rather than growing pending.
  forwarder.push('y'.repeat(9000));
  assert.equal(forwarder.pendingBytes(), 0);
  assert.equal(sent[sent.length - 1].length, 9000);
});

test('dispose flushes the coalesced tail before exit and ignores later pushes', () => {
  const { sent, clock, forwarder } = harness();
  forwarder.push('first');
  forwarder.push(' tail without newline');
  assert.equal(sent.length, 1, 'the tail is still coalescing');
  forwarder.dispose();
  assert.deepEqual(sent, ['first', ' tail without newline'], 'the last prompt must not die in the buffer');
  forwarder.push('after exit');
  clock.advance(COALESCE_MS * 4);
  assert.equal(sent.length, 2, 'nothing is forwarded after dispose');
});

test('terminal:create wires onData through the forwarder and flushes it before the exit marker', () => {
  const createSource = extractHandler('terminal:create');
  assert.ok(createSource.includes('createTerminalOutputForwarder('), 'create must build a forwarder');
  assert.ok(createSource.includes('terminal.onData((data) => forwarder.push(data))'), 'onData rides the forwarder');
  assert.ok(createSource.includes('pause: () => terminal.pause()'), 'flow control pauses the pty');
  assert.ok(createSource.includes('resume: () => terminal.resume()'), 'flow control resumes the pty');
  const exitBlock = createSource.slice(createSource.indexOf('terminal.onExit'));
  assert.ok(exitBlock.indexOf('forwarder.dispose()') < exitBlock.indexOf("type: 'exit'"), 'the tail flushes before exit');
  const closeSource = extractHandler('terminal:close');
  assert.ok(closeSource.includes('sessionInfo.forwarder?.dispose()'), 'close flushes the tail too');
});

/**
 * End-to-end through the REAL terminal:create / terminal:write handler bodies:
 * a fake node-pty and a fake webContents prove prompt bytes reach the renderer
 * unbuffered and that terminal_answer's bytes reach the pty.
 */
function bootTerminalHandlers() {
  const sessions = new Map();
  const messages = [];
  const ptyWrites = [];
  const dataListeners = [];
  const exitListeners = [];
  let pauseCalls = 0;
  let resumeCalls = 0;
  const fakePty = {
    spawn() {
      return {
        onData(fn) { dataListeners.push(fn); },
        onExit(fn) { exitListeners.push(fn); },
        write(data) { ptyWrites.push(data); },
        resize() {},
        kill() { for (const fn of exitListeners) fn({ exitCode: 0 }); },
        pause() { pauseCalls += 1; },
        resume() { resumeCalls += 1; }
      };
    }
  };
  const mainWindow = { webContents: { send(channel, payload) { messages.push({ channel, payload }); } } };
  const handlers = new Map();
  const deps = {
    handleMachineSensitive(channel, fn) { handlers.set(channel, fn); },
    assertTrustedRenderer() {},
    pty: fakePty,
    workspaceAccess: { getWorkspace: (id) => (id === 'w1' ? { root: 'C:\\proj' } : null) },
    terminalSessions: sessions,
    maxTerminalSessionsPerWorkspace: 12,
    resolveTerminalPlan: () => ({ mode: 'system', label: 'Shell', shellPath: 'powershell.exe', shellArgs: [], env: {} }),
    systemEnvironment: (env) => env,
    applyShellIntegration: (plan) => plan,
    normalizeTerminalSessionKey: (key) => (typeof key === 'string' && key ? key : null),
    clampTerminalSize: (cols, rows) => ({ cols, rows }),
    randomUUID,
    mainWindow,
    path,
    terminalDescriptor,
    createTerminalOutputForwarder
  };
  const names = Object.keys(deps);
  const body = `${extractHandler('terminal:create')}\n${extractHandler('terminal:write')}`;
  new Function(...names, body)(...names.map((name) => deps[name]));
  return {
    sessions, messages, ptyWrites, dataListeners, exitListeners,
    create: handlers.get('terminal:create'),
    write: handlers.get('terminal:write'),
    pauseCalls: () => pauseCalls,
    resumeCalls: () => resumeCalls
  };
}

test('terminal:create forwards a no-newline prompt to the renderer immediately and raw', async () => {
  const h = bootTerminalHandlers();
  const descriptor = await h.create({}, 'w1', 100, 30, 'system', 'tab-1');
  assert.equal(descriptor.sessionId, 'tab-1');
  const prompt = 'enter first digit: \x1b[0m';
  h.dataListeners[0](prompt);
  const dataMessages = h.messages.filter((m) => m.channel === 'terminal:output' && m.payload.type === 'data');
  assert.equal(dataMessages.length, 1, 'a lone prompt is one immediate message');
  assert.equal(dataMessages[0].payload.data, prompt, 'prompt bytes arrive verbatim, ESC tail included');
  assert.equal(dataMessages[0].payload.sessionId, 'tab-1');
});

test('terminal:create coalesces a heavy burst and flushes the tail before exit', async () => {
  const h = bootTerminalHandlers();
  await h.create({}, 'w1', 100, 30, 'system', 'tab-2');
  // Real timers here: the burst coalesces on the production 8ms timer.
  for (let i = 0; i < 300; i += 1) h.dataListeners[0](`npm http fetch ${i}\r\n`);
  h.dataListeners[0]('Continue? [y/N] ');
  h.exitListeners[0]({ exitCode: 0 });
  const payloads = h.messages.filter((m) => m.channel === 'terminal:output').map((m) => m.payload);
  const data = payloads.filter((p) => p.type === 'data');
  assert.ok(data.length < 300, `burst must coalesce, got ${data.length} messages`);
  assert.ok(data[data.length - 1].data.endsWith('Continue? [y/N] '), 'the final prompt survives the flush');
  assert.equal(payloads[payloads.length - 1].type, 'exit', 'exit is the last message');
  assert.equal(data.map((p) => p.data).join('').includes('npm http fetch 299'), true, 'no burst bytes lost');
});

test('terminal:write delivers terminal_answer bytes straight to the pty and refuses foreign sessions', async () => {
  const h = bootTerminalHandlers();
  await h.create({}, 'w1', 100, 30, 'system', 'tab-3');
  await h.write({}, 'w1', 'tab-3', 'y\r');
  assert.deepEqual(h.ptyWrites, ['y\r'], 'the approved answer reaches the pty exactly');
  await h.write({}, 'w1', 'tab-3', '42\r');
  assert.deepEqual(h.ptyWrites, ['y\r', '42\r']);
  await assert.rejects(() => h.write({}, 'w2', 'tab-3', 'no'), /Invalid terminal session/);
  await assert.rejects(() => h.write({}, 'w1', 'tab-3', 'z'.repeat(64_001)), /Invalid terminal session/);
  assert.deepEqual(h.ptyWrites, ['y\r', '42\r'], 'refused input never reaches the pty');
});