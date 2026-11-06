'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDebugHost, readLaunchConfigs, LIMITS } = require('./debug-host.cjs');

/**
 * A DAP adapter small enough to sit in a string. It exercises the exact
 * handshake the host must drive and over-fills every collection so the host's
 * response bounds are observable.
 */
const FAKE_ADAPTER = String.raw`
'use strict';
const fs = require('node:fs');
let buffer = Buffer.alloc(0);
let contentLength = -1;
let seq = 1;
let programPath = process.env.SHADROX_FAKE_PROGRAM || '';

function send(message) {
  message.seq = seq++;
  if (message.type === 'event') message.type = 'event';
  const json = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}
function respond(request, body) {
  send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body });
}
function fail(request, message) {
  send({ type: 'response', request_seq: request.seq, success: false, command: request.command, message });
}
function dispatch(message) {
  if (message.type !== 'request') return;
  switch (message.command) {
    case 'initialize':
      respond(message, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: false });
      send({ type: 'event', event: 'initialized' });
      break;
    case 'launch':
      programPath = (message.arguments && message.arguments.program) || programPath;
      respond(message, {});
      break;
    case 'configurationDone':
      respond(message, {});
      send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true } });
      break;
    case 'setBreakpoints':
      respond(message, {
        breakpoints: ((message.arguments && message.arguments.breakpoints) || []).map((bp, index) => ({
          id: index + 1, verified: true, line: bp.line
        }))
      });
      break;
    case 'threads':
      respond(message, {
        threads: Array.from({ length: 70 }, (_, index) => ({ id: index + 1, name: 'Thread ' + (index + 1) }))
      });
      break;
    case 'stackTrace':
      respond(message, {
        stackFrames: Array.from({ length: 60 }, (_, index) => ({
          id: index + 1,
          name: 'frame' + index,
          line: 10 + index,
          column: 2,
          source: { name: 'main.js', path: programPath }
        }))
      });
      break;
    case 'scopes':
      respond(message, {
        scopes: Array.from({ length: 30 }, (_, index) => ({
          name: index === 0 ? 'Locals' : 'Scope ' + index,
          variablesReference: 100 + index,
          expensive: false
        }))
      });
      break;
    case 'variables':
      respond(message, {
        variables: Array.from({ length: 120 }, (_, index) => ({
          name: 'v' + index,
          value: index === 0 ? 'x'.repeat(600) : 'value' + index,
          type: 'string',
          variablesReference: index === 1 ? 900 : 0
        }))
      });
      break;
    case 'continue':
      respond(message, {});
      send({ type: 'event', event: 'continued', body: { threadId: 1 } });
      break;
    case 'next':
    case 'stepIn':
    case 'stepOut':
      respond(message, {});
      send({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 1 } });
      break;
    case 'pause':
      respond(message, {});
      send({ type: 'event', event: 'output', body: { category: 'stdout', output: 'paused by user' } });
      send({ type: 'event', event: 'stopped', body: { reason: 'pause', threadId: 1 } });
      break;
    case 'disconnect':
      respond(message, {});
      setTimeout(() => process.exit(0), 20);
      break;
    case 'exceptionInfo':
      respond(message, {});
      break;
    case 'evaluate':
      respond(message, { result: '42', type: 'number', variablesReference: 0 });
      break;
    default:
      fail(message, 'unsupported: ' + message.command);
  }
}
function drain() {
  while (true) {
    if (contentLength >= 0) {
      if (buffer.length < contentLength) return;
      const body = buffer.toString('utf8', 0, contentLength);
      buffer = buffer.subarray(contentLength);
      contentLength = -1;
      try { dispatch(JSON.parse(body)); } catch (error) { process.stderr.write(String(error) + '\n'); }
      continue;
    }
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.toString('utf8', 0, headerEnd);
    buffer = buffer.subarray(headerEnd + 4);
    const match = /Content-Length:\s*(\d+)/.exec(header);
    if (!match) return;
    contentLength = Number(match[1]);
  }
}
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
process.stdin.on('end', () => process.exit(0));
`;

function makeWorkspace(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-debug-'));
  fs.writeFileSync(path.join(root, 'main.js'), 'console.log("main");\n');
  fs.writeFileSync(path.join(root, 'fake-adapter.cjs'), FAKE_ADAPTER);
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, 'shadrox.debug.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return root;
}

function defaultConfig() {
  return {
    configurations: [
      {
        name: 'Fake Node',
        type: 'node',
        request: 'launch',
        program: 'main.js',
        adapterCommand: process.execPath,
        adapterArgs: ['fake-adapter.cjs']
      }
    ]
  };
}

function makeHost(root, events = []) {
  return createDebugHost({
    getWorkspace: (workspaceId) => (workspaceId === 'ws' ? { root } : null),
    broadcast: (event) => events.push(event)
  });
}

async function startedHost(root, events = []) {
  const host = makeHost(root, events);
  const state = await host.start('ws');
  return { host, state };
}

/** The adapter decides when the debuggee first stops; give it a moment. */
async function waitForState(host, status, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (host.state('ws').status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`debug state did not become ${status}; it is ${host.state('ws').status}`);
}

async function waitForEvent(events, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected event never arrived; saw ${events.map((event) => event.type).join(', ')}`);
}

test('a missing shadrox.debug.json is an honest empty state, not an error', () => {
  const root = makeWorkspace(undefined);
  const configs = readLaunchConfigs(root);
  assert.equal(configs.found, false);
  assert.deepEqual(configs.configurations, []);
  assert.equal(configs.error, null);
});

test('invalid JSON is reported with the file path', () => {
  const root = makeWorkspace('{ not json');
  const configs = readLaunchConfigs(root);
  assert.equal(configs.found, true);
  assert.match(configs.error, /not valid JSON/);
});

test('a program that escapes the workspace is refused', () => {
  const root = makeWorkspace(defaultConfig());
  const escape = path.join(root, '..', 'outside.js');
  fs.writeFileSync(escape, '1');
  const config = defaultConfig();
  config.configurations[0].program = '../outside.js';
  fs.writeFileSync(path.join(root, 'shadrox.debug.json'), JSON.stringify(config));
  const configs = readLaunchConfigs(root);
  assert.match(configs.error, /outside the opened workspace/);
});

test('a cwd that escapes the workspace is refused', () => {
  const root = makeWorkspace(defaultConfig());
  const config = defaultConfig();
  config.configurations[0].cwd = '..';
  fs.writeFileSync(path.join(root, 'shadrox.debug.json'), JSON.stringify(config));
  const configs = readLaunchConfigs(root);
  assert.match(configs.error, /outside the opened workspace/);
});

test('more than ten configurations is refused', () => {
  const root = makeWorkspace(undefined);
  const config = { configurations: Array.from({ length: 11 }, (_, index) => ({ ...defaultConfig().configurations[0], name: 'C' + index })) };
  fs.writeFileSync(path.join(root, 'shadrox.debug.json'), JSON.stringify(config));
  const configs = readLaunchConfigs(root);
  assert.match(configs.error, /limit is 10/);
});

test('a missing adapter returns an actionable js-debug install error', () => {
  const root = makeWorkspace(defaultConfig());
  const config = defaultConfig();
  config.configurations[0].adapterCommand = 'js-debug-adapter-not-installed';
  fs.writeFileSync(path.join(root, 'shadrox.debug.json'), JSON.stringify(config));
  const configs = readLaunchConfigs(root);
  assert.match(configs.error, /not found/i);
  assert.match(configs.error, /@vscode\/js-debug/);
});

test('adapter arguments with a newline are refused (no shell interpolation)', () => {
  const root = makeWorkspace(defaultConfig());
  const config = defaultConfig();
  config.configurations[0].adapterArgs = ['fake-adapter.cjs\necho pwned'];
  fs.writeFileSync(path.join(root, 'shadrox.debug.json'), JSON.stringify(config));
  const configs = readLaunchConfigs(root);
  assert.match(configs.error, /NUL or newline/);
});

test('configs() exposes validated configurations without resolved internals', () => {
  const root = makeWorkspace(defaultConfig());
  const host = makeHost(root);
  const configs = host.configs('ws');
  assert.equal(configs.found, true);
  assert.equal(configs.error, null);
  assert.equal(configs.configurations.length, 1);
  assert.equal(configs.configurations[0].name, 'Fake Node');
  assert.equal(configs.configurations[0].resolvedAdapterCommand, undefined);
});

test('hover evaluation works only while paused and never sends a multi-line program', async (t) => {
  const root = makeWorkspace(defaultConfig());
  const idle = makeHost(root);
  t.after(() => idle.disposeAll());
  await assert.rejects(idle.evaluate('ws', 1, 'answer'), /No debug session/i);

  const { host } = await startedHost(root);
  t.after(() => host.disposeAll());
  await waitForState(host, 'stopped');
  const [frame] = await host.stack('ws');
  const value = await host.evaluate('ws', frame.id, 'answer');
  assert.deepEqual(value, { result: '42', type: 'number', variablesReference: 0 });

  await assert.rejects(host.evaluate('ws', frame.id, 'a\nprocess.exit(0)'), /one line/i);
  await assert.rejects(host.evaluate('ws', frame.id, '   '), /expression is required/i);
  await assert.rejects(host.evaluate('ws', frame.id, 'x'.repeat(LIMITS.MAX_EXPRESSION_CHARS + 1)), /one line/i);

  await host.stop('ws');
});

test('handshake drives initialize -> launch -> configurationDone and reports stopped', async (t) => {
  const root = makeWorkspace(defaultConfig());
  const events = [];
  const { host } = await startedHost(root, events);
  t.after(() => host.disposeAll());
  await waitForState(host, 'stopped');

  const stopped = host.state('ws');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.threadId, 1);
  assert.equal(stopped.stopReason, 'breakpoint');
  assert.ok(events.some((event) => event.type === 'stopped' && event.reason === 'breakpoint'));

  const threads = await host.threads('ws');
  assert.equal(threads.length, LIMITS.MAX_THREADS);
  assert.equal(threads[0].name, 'Thread 1');

  const frames = await host.stack('ws');
  assert.equal(frames.length, LIMITS.MAX_FRAMES);
  assert.equal(frames[0].file, 'main.js');
  assert.equal(frames[0].line, 10);

  const scopes = await host.scopes('ws', frames[0].id);
  assert.equal(scopes.length, LIMITS.MAX_SCOPES);
  assert.equal(scopes[0].name, 'Locals');

  const variables = await host.variables('ws', scopes[0].variablesReference);
  assert.equal(variables.length, LIMITS.MAX_VARIABLES);
  assert.equal(variables[0].value.length, LIMITS.MAX_VALUE_CHARS, 'value is clipped with an ellipsis');
  assert.equal(variables[1].variablesReference, 900);

  await host.stop('ws');
});

test('breakpoints are stored before start, verified after, and keep their requested lines', async (t) => {
  const root = makeWorkspace(defaultConfig());
  const host = makeHost(root);
  t.after(() => host.disposeAll());

  const pending = await host.setBreakpoints('ws', 'main.js', [4, 4, 9, 2]);
  assert.deepEqual(pending.map((entry) => entry.line), [2, 4, 9]);
  assert.equal(pending.every((entry) => entry.verified === false), true);

  await host.start('ws');
  const verified = await host.setBreakpoints('ws', 'main.js', [3, 7]);
  assert.deepEqual(verified.map((entry) => entry.line), [3, 7]);
  assert.equal(verified.every((entry) => entry.verified === true), true);
  assert.deepEqual(host.breakpoints('ws')['main.js'], [3, 7]);

  await host.stop('ws');
});

test('continue resumes, step pauses again, pause emits an output event', async (t) => {
  const root = makeWorkspace(defaultConfig());
  const events = [];
  const { host } = await startedHost(root, events);
  t.after(() => host.disposeAll());
  await waitForState(host, 'stopped');

  assert.equal((await host.continue('ws', 1)).status, 'running');
  await waitForEvent(events, (event) => event.type === 'continued');

  // The fake adapter stops on `next`; emulate reaching it from a stopped state.
  const root2 = makeWorkspace(defaultConfig());
  const second = makeHost(root2, events);
  t.after(() => second.disposeAll());
  await second.start('ws');
  await waitForState(second, 'stopped');
  // The fake adapter answers `next` and stops in the same stdout chunk. Whether
  // the snapshot is 'running' or already 'stopped' depends on which lands first,
  // so only the settled state below is deterministic.
  const stepped = (await second.next('ws', 1)).status;
  assert.ok(stepped === 'running' || stepped === 'stopped', `unexpected step status: ${stepped}`);
  await waitForState(second, 'stopped');

  await second.pause('ws', 1);
  await waitForEvent(events, (event) => event.type === 'output' && /paused by user/.test(event.text));

  await second.stop('ws');
  await host.stop('ws');
});

test('stop() terminates the adapter child and reports terminated', async (t) => {
  const root = makeWorkspace(defaultConfig());
  const events = [];
  const { host } = await startedHost(root, events);
  t.after(() => host.disposeAll());
  await waitForState(host, 'stopped');
  await host.stop('ws');
  assert.equal(host.state('ws').status, 'idle');
  assert.ok(events.some((event) => event.type === 'terminated'));
});
