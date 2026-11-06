'use strict';

/**
 * The main-process Debug Adapter Protocol host.
 *
 * One session at a time, owned by the active workspace. The renderer never
 * speaks DAP directly: it asks this host for bounded snapshots and receives
 * lifecycle events over `debug:event`. The adapter process is spawned with an
 * argv array (`shell: false`), so no value from `shadrox.debug.json` is ever
 * interpolated into a command line.
 *
 * Framing lives in `electron/dap-framing.cjs`, shared with the renderer-side
 * TypeScript client. This module adds sequence matching, request timeouts and
 * the response bounds the renderer relies on.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isPathInsideDirectory } = require('./desktop-security.cjs');
const { resolveExecutable } = require('./preview-runtime.cjs');
const { createFrameParser, encodeFrame } = require('./dap-framing.cjs');

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIGURATIONS = 10;
const MAX_NAME_CHARS = 120;
const MAX_ARG_CHARS = 2000;
const MAX_ARGS = 50;
const MAX_THREADS = 50;
const MAX_FRAMES = 50;
const MAX_SCOPES = 20;
const MAX_VARIABLES = 100;
const MAX_VALUE_CHARS = 500;
const MAX_EXPRESSION_CHARS = 500;
const MAX_OUTPUT_CHARS = 4000;
const MAX_STDERR_TAIL = 4000;
const MAX_TOTAL_OUTPUT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const START_TIMEOUT_MS = 20000;
const STOP_GRACE_MS = 1500;

const JS_DEBUG_INSTALL_HINT =
  'Install it in the workspace with "npm install --no-save @vscode/js-debug", or point adapterCommand at ' +
  'node_modules/@vscode/js-debug/src/dapDebugServer.js. Looked for node_modules/.bin/js-debug-adapter and @vscode/js-debug.';

function clip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= max) return value;
  return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

function hasControlCharacters(value) {
  return /[\0\r\n]/.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPathLike(value) {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

/** Resolve a workspace-relative or absolute path and require it to stay inside the workspace. */
function resolveInside(root, candidate, label) {
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  if (!isPathInsideDirectory(root, absolute)) {
    throw new Error(`${label} resolves outside the opened workspace: ${candidate}`);
  }
  return absolute;
}

function normalizeStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings.`);
  if (value.length > MAX_ARGS) throw new Error(`${label} holds more than ${MAX_ARGS} entries.`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${label}[${index}] must be a string.`);
    if (entry.length > MAX_ARG_CHARS) throw new Error(`${label}[${index}] is longer than ${MAX_ARG_CHARS} characters.`);
    if (hasControlCharacters(entry)) throw new Error(`${label}[${index}] contains a NUL or newline, which is not allowed.`);
    return entry;
  });
}

function jsDebugCandidates(root) {
  const bin = process.platform === 'win32' ? ['js-debug-adapter.cmd', 'js-debug-adapter.exe', 'js-debug-adapter'] : ['js-debug-adapter'];
  return [
    ...bin.map((name) => path.join(root, 'node_modules', '.bin', name)),
    path.join(root, 'node_modules', '@vscode', 'js-debug', 'src', 'dapDebugServer.js'),
    path.join(root, 'node_modules', '@vscode', 'js-debug', 'dist', 'src', 'dapDebugServer.js')
  ];
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Point a configured adapter at a real executable without a shell.
 * Bare names are resolved from PATH (never the workspace); path-looking
 * values must exist inside the workspace. A `js-debug-adapter` name falls
 * back to the workspace's installed adapter when PATH has no such binary.
 */
function resolveAdapterCommand(command, root) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('adapterCommand must be a non-empty string.');
  }
  if (command.length > MAX_ARG_CHARS) throw new Error(`adapterCommand is longer than ${MAX_ARG_CHARS} characters.`);
  if (hasControlCharacters(command)) throw new Error('adapterCommand contains a NUL or newline, which is not allowed.');

  if (isPathLike(command)) {
    // An absolute adapter path (a system Node, a debugpy venv) may live outside
    // the workspace just like a PATH-resolved executable; a relative one must
    // stay inside it. Either way it is spawned as argv, never through a shell.
    const absolute = path.isAbsolute(command) ? path.resolve(command) : resolveInside(root, command, 'adapterCommand');
    try {
      if (fs.statSync(absolute).isFile()) return absolute;
    } catch {
      // fall through to the install hint
    }
    throw new Error(`Debug adapter not found at ${absolute}. ${JS_DEBUG_INSTALL_HINT}`);
  }

  if (/^js-debug-adapter(?:\.exe)?$/i.test(command)) {
    const installed = firstExisting(jsDebugCandidates(root));
    if (installed) return installed;
    throw new Error(`Debug adapter "${command}" is not installed in this workspace. ${JS_DEBUG_INSTALL_HINT}`);
  }

  const resolved = resolveExecutable(command, { root });
  if (!resolved) {
    throw new Error(
      `Debug adapter "${command}" was not found on PATH. ${JS_DEBUG_INSTALL_HINT}`
    );
  }
  return resolved;
}

/** Resolve `.js` adapter-entry arguments and verify they exist inside the workspace. */
function resolveAdapterArgs(args, root) {
  return args.map((arg) => {
    if (arg.startsWith('-')) return arg;
    if (/\.[cm]?js$/i.test(arg)) {
      const absolute = path.isAbsolute(arg) ? path.resolve(arg) : resolveInside(root, arg, 'adapterArgs entry');
      try {
        if (fs.statSync(absolute).isFile()) return absolute;
      } catch {
        // fall through to the actionable error
      }
      throw new Error(`Debug adapter entry not found at ${absolute}. ${JS_DEBUG_INSTALL_HINT}`);
    }
    return arg;
  });
}

function normalizeConfig(raw, index, root, names) {
  const label = `configurations[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${label} must be an object.`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`${label}.name is required.`);
  const name = raw.name.trim();
  if (name.length > MAX_NAME_CHARS) throw new Error(`${label}.name is longer than ${MAX_NAME_CHARS} characters.`);
  if (names.has(name)) throw new Error(`Duplicate launch configuration name: ${name}`);
  names.add(name);

  if (raw.type !== 'node') throw new Error(`${label}.type must be "node".`);
  if (raw.request !== 'launch') throw new Error(`${label}.request must be "launch".`);

  if (typeof raw.program !== 'string' || !raw.program.trim()) throw new Error(`${label}.program is required.`);
  if (hasControlCharacters(raw.program)) throw new Error(`${label}.program contains a NUL or newline.`);

  const cwdInput = raw.cwd === undefined ? '.' : raw.cwd;
  if (typeof cwdInput !== 'string' || !cwdInput.trim()) throw new Error(`${label}.cwd must be a non-empty string when present.`);
  if (hasControlCharacters(cwdInput)) throw new Error(`${label}.cwd contains a NUL or newline.`);
  const cwdPath = resolveInside(root, cwdInput, `${label}.cwd`);
  try {
    if (!fs.statSync(cwdPath).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`${label}.cwd is not a directory inside the workspace: ${cwdInput}`);
  }

  const programPath = resolveInside(cwdPath, raw.program, `${label}.program`);
  try {
    if (!fs.statSync(programPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`${label}.program does not exist: ${raw.program}`);
  }

  const args = normalizeStringArray(raw.args, `${label}.args`);

  let runtimeExecutable;
  if (raw.runtimeExecutable !== undefined) {
    if (typeof raw.runtimeExecutable !== 'string' || !raw.runtimeExecutable.trim()) {
      throw new Error(`${label}.runtimeExecutable must be a non-empty string.`);
    }
    if (hasControlCharacters(raw.runtimeExecutable)) throw new Error(`${label}.runtimeExecutable contains a NUL or newline.`);
    runtimeExecutable = raw.runtimeExecutable;
  }

  if (typeof raw.adapterCommand !== 'string') throw new Error(`${label}.adapterCommand is required.`);
  const adapterCommand = resolveAdapterCommand(raw.adapterCommand, root);
  const adapterArgs = resolveAdapterArgs(normalizeStringArray(raw.adapterArgs, `${label}.adapterArgs`), root);

  return {
    name,
    type: 'node',
    request: 'launch',
    program: raw.program,
    runtimeExecutable,
    args,
    cwd: cwdInput,
    adapterCommand: raw.adapterCommand,
    adapterArgs: raw.adapterArgs ?? [],
    // Internal, never sent to the renderer:
    programPath,
    cwdPath,
    resolvedAdapterCommand: adapterCommand,
    resolvedAdapterArgs: adapterArgs
  };
}

/**
 * Read and validate `<workspace>/shadrox.debug.json`.
 * Returns `{ found, path, configurations, error }`; a missing file is not an
 * error, it is the honest "no debug configuration" empty state.
 */
function readLaunchConfigs(root) {
  const file = path.join(root, 'shadrox.debug.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { found: false, path: file, configurations: [], error: null };
  }
  if (!stat.isFile()) return { found: false, path: file, configurations: [], error: 'shadrox.debug.json is not a regular file.' };
  if (stat.size > MAX_CONFIG_BYTES) {
    return {
      found: true,
      path: file,
      configurations: [],
      error: `shadrox.debug.json is ${stat.size} bytes; the limit is ${MAX_CONFIG_BYTES} bytes.`
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { found: true, path: file, configurations: [], error: `shadrox.debug.json is not valid JSON: ${error.message}` };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.configurations)) {
    return { found: true, path: file, configurations: [], error: 'shadrox.debug.json must be { "configurations": [...] }.' };
  }
  if (parsed.configurations.length > MAX_CONFIGURATIONS) {
    return {
      found: true,
      path: file,
      configurations: [],
      error: `shadrox.debug.json declares ${parsed.configurations.length} configurations; the limit is ${MAX_CONFIGURATIONS}.`
    };
  }

  const configurations = [];
  const names = new Set();
  try {
    parsed.configurations.forEach((raw, index) => {
      const normalized = normalizeConfig(raw, index, root, names);
      // Strip the resolved fields from the renderer-facing copy.
      const {
        programPath: _programPath,
        cwdPath: _cwdPath,
        resolvedAdapterCommand: _resolvedCommand,
        resolvedAdapterArgs: _resolvedArgs,
        ...publicConfig
      } = normalized;
      configurations.push({ ...publicConfig, __resolved: normalized });
    });
  } catch (error) {
    return { found: true, path: file, configurations: [], error: error.message };
  }

  return {
    found: true,
    path: file,
    configurations: configurations.map((entry) => {
      const { __resolved, ...publicConfig } = entry;
      return publicConfig;
    }),
    resolved: configurations.map((entry) => entry.__resolved),
    error: null
  };
}

function relativeToRoot(root, candidate) {
  if (typeof candidate !== 'string' || !candidate) return null;
  let absolute = candidate;
  if (absolute.startsWith('file://')) {
    try {
      absolute = require('node:url').fileURLToPath(absolute);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(absolute)) return null;
  if (!isPathInsideDirectory(root, absolute)) return null;
  const relative = path.relative(root, absolute);
  return relative ? toPosix(relative) : null;
}

function normalizeBreakpointLines(lines) {
  if (!Array.isArray(lines)) throw new Error('Breakpoint lines must be an array of numbers.');
  const seen = new Set();
  for (const line of lines) {
    if (!Number.isSafeInteger(line) || line < 1) throw new Error(`Invalid breakpoint line: ${String(line)}`);
    seen.add(line);
  }
  return [...seen].sort((a, b) => a - b);
}

function emptyState(workspaceId) {
  return {
    status: 'idle',
    workspaceId: workspaceId ?? null,
    configName: null,
    threadId: null,
    frameId: null,
    stopReason: null,
    exception: false,
    message: null,
    output: ''
  };
}

/**
 * A tiny DAP client: sequence matching, per-request timeouts, event dispatch,
 * and a refusal for adapter→client requests this host does not implement.
 */
function createDapClient(child, hooks) {
  let sequence = 0;
  let disposed = false;
  const pending = new Map();
  const waiters = [];

  const parser = createFrameParser({
    onMessage: (message) => handleMessage(message),
    onError: (error) => hooks.onError(error)
  });

  child.stdout.on('data', (chunk) => parser.push(chunk));

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') {
      const waiter = pending.get(message.request_seq);
      if (!waiter) return;
      pending.delete(message.request_seq);
      clearTimeout(waiter.timer);
      if (message.success) waiter.resolve(message);
      else waiter.reject(new Error(message.message || `Debug adapter request '${waiter.command}' failed.`));
      return;
    }
    if (message.type === 'event') {
      hooks.onEvent(message);
      const matching = waiters.filter((waiter) => waiter.event === message.event);
      for (const waiter of matching) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
      return;
    }
    if (message.type === 'request') {
      // runInTerminal/startDebugging are not hosted here; answer instead of
      // leaving the adapter waiting for a response forever.
      write({
        seq: ++sequence,
        type: 'response',
        request_seq: message.seq,
        success: false,
        command: message.command,
        message: `ShadRox does not implement '${message.command}'`
      });
    }
  }

  function write(message) {
    if (!child.stdin || child.stdin.destroyed) throw new Error('The debug adapter stdin is closed.');
    child.stdin.write(encodeFrame(message), 'utf8');
  }

  function request(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (disposed) return Promise.reject(new Error('The debug adapter is closed.'));
    return new Promise((resolve, reject) => {
      const requestSeq = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(requestSeq);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for '${command}' from the debug adapter.`));
      }, timeoutMs);
      pending.set(requestSeq, { resolve, reject, timer, command });
      try {
        const payload = { seq: requestSeq, type: 'request', command };
        if (args && Object.keys(args).length > 0) payload.arguments = args;
        write(payload);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestSeq);
        reject(error);
      }
    });
  }

  function waitForEvent(event, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for the '${event}' event from the debug adapter.`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function failAll(error) {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  return {
    request,
    waitForEvent,
    failAll,
    dispose() {
      disposed = true;
      parser.reset();
      failAll(new Error('The debug session ended.'));
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
    }
  };
}

/**
 * @param {{
 *   getWorkspace: (workspaceId: string) => { root: string } | null | undefined,
 *   broadcast: (event: Record<string, unknown>) => void
 * }} options
 */
function createDebugHost(options) {
  const getWorkspace = options.getWorkspace;
  const broadcastToRenderer = typeof options.broadcast === 'function' ? options.broadcast : () => {};
  let session = null;
  /** Breakpoints stay meaningful while no session is running, so they outlive one. */
  const pendingBreakpoints = new Map();

  function pendingFor(workspaceId) {
    let map = pendingBreakpoints.get(workspaceId);
    if (!map) {
      map = new Map();
      pendingBreakpoints.set(workspaceId, map);
    }
    return map;
  }

  function broadcast(event) {
    try {
      broadcastToRenderer(event);
    } catch {
      // A closing window must not break the debugger teardown.
    }
  }

  function workspaceRoot(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace || typeof workspace.root !== 'string') throw new Error('Unknown workspace for the debugger.');
    return workspace.root;
  }

  function snapshot(active) {
    if (!active) return emptyState(null);
    return {
      status: active.status,
      workspaceId: active.workspaceId,
      configName: active.configName,
      threadId: active.threadId,
      frameId: active.frameId,
      stopReason: active.stopReason,
      exception: active.exception,
      message: active.message,
      output: active.output
    };
  }

  function emitState(active = session) {
    if (!active) return;
    broadcast({ type: 'state', workspaceId: active.workspaceId, state: snapshot(active) });
  }

  function emit(active, event) {
    broadcast({ workspaceId: active.workspaceId, ...event });
  }

  function appendOutput(active, text) {
    if (!text) return;
    active.output = clip(`${active.output}${text}`, MAX_TOTAL_OUTPUT);
  }

  function setStatus(active, status) {
    if (active.status === status) return;
    active.status = status;
    emitState(active);
  }

  function requireSession(workspaceId, allowRunning = false) {
    if (!session || session.workspaceId !== workspaceId) {
      throw new Error('No debug session is active for this workspace.');
    }
    if (!allowRunning && session.status !== 'stopped') {
      throw new Error('The debugger is not paused.');
    }
    return session;
  }

  function killChild(active, graceful) {
    const child = active?.child;
    if (!child) return;
    active.child = null;
    try {
      if (graceful) {
        child.stdin?.end();
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* already gone */ }
        }, STOP_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => clearTimeout(timer));
      } else {
        child.kill();
      }
    } catch {
      // process already exited
    }
  }

  function finishSession(active, status, message) {
    if (!active) return;
    try { active.client?.dispose(); } catch { /* closed */ }
    active.client = null;
    killChild(active, false);
    active.status = status;
    active.message = message ?? null;
    active.threadId = null;
    active.frameId = null;
    active.stopReason = null;
    active.exception = false;
    emitState(active);
  }

  function handleAdapterEvent(active, event) {
    switch (event.event) {
      case 'stopped': {
        active.eventGeneration += 1;
        const body = isPlainObject(event.body) ? event.body : {};
        active.status = 'stopped';
        active.threadId = Number.isSafeInteger(body.threadId) ? body.threadId : active.threadId;
        active.stopReason = typeof body.reason === 'string' ? body.reason : 'breakpoint';
        active.exception = active.stopReason === 'exception' || active.stopReason === 'uncaught';
        active.message = active.exception ? 'Paused on an exception.' : null;
        emitState(active);
        emit(active, {
          type: 'stopped',
          threadId: active.threadId,
          reason: active.stopReason,
          exception: active.exception,
          allThreadsStopped: body.allThreadsStopped === true
        });
        break;
      }
      case 'continued': {
        active.eventGeneration += 1;
        active.status = 'running';
        active.frameId = null;
        active.stopReason = null;
        active.exception = false;
        emitState(active);
        emit(active, { type: 'continued', threadId: isPlainObject(event.body) ? event.body.threadId ?? null : null });
        break;
      }
      case 'terminated': {
        active.eventGeneration += 1;
        active.status = 'terminated';
        active.frameId = null;
        emitState(active);
        emit(active, { type: 'terminated', message: 'The debuggee terminated.' });
        break;
      }
      case 'output': {
        const body = isPlainObject(event.body) ? event.body : {};
        const text = clip(typeof body.output === 'string' ? body.output : '', MAX_OUTPUT_CHARS);
        if (!text) break;
        appendOutput(active, text);
        emit(active, {
          type: 'output',
          category: typeof body.category === 'string' ? body.category : 'console',
          text
        });
        break;
      }
      case 'breakpoint': {
        const body = isPlainObject(event.body) ? event.body : {};
        const breakpoint = isPlainObject(body.breakpoint) ? body.breakpoint : null;
        if (breakpoint) {
          emit(active, {
            type: 'breakpoint',
            reason: typeof body.reason === 'string' ? body.reason : 'changed',
            breakpoint: {
              id: Number.isSafeInteger(breakpoint.id) ? breakpoint.id : null,
              verified: breakpoint.verified === true,
              line: Number.isSafeInteger(breakpoint.line) ? breakpoint.line : null,
              file: breakpoint.source && typeof breakpoint.source.path === 'string'
                ? relativeToRoot(active.root, breakpoint.source.path)
                : null
            }
          });
        }
        break;
      }
      default:
        break;
    }
  }

  async function applyStoredBreakpoints(active) {
    for (const [file, lines] of active.breakpoints) {
      if (lines.length === 0) continue;
      try {
        await sendBreakpoints(active, file, lines);
      } catch {
        // A stale breakpoint must not prevent the session from starting; the
        // setBreakpoints call the renderer makes later will report the error.
      }
    }
  }

  async function sendBreakpoints(active, file, lines) {
    const absolute = path.resolve(active.root, file);
    if (!isPathInsideDirectory(active.root, absolute)) throw new Error('Breakpoint file resolves outside the workspace.');
    const response = await active.client.request('setBreakpoints', {
      source: { path: absolute },
      breakpoints: lines.map((line) => ({ line }))
    });
    const returned = Array.isArray(response.body?.breakpoints) ? response.body.breakpoints.slice(0, lines.length) : [];
    return lines.map((line, index) => {
      const entry = isPlainObject(returned[index]) ? returned[index] : {};
      return {
        file: toPosix(file),
        line: Number.isSafeInteger(entry.line) ? entry.line : line,
        verified: entry.verified === true,
        id: Number.isSafeInteger(entry.id) ? entry.id : null
      };
    });
  }

  async function start(workspaceId, configName) {
    const root = workspaceRoot(workspaceId);
    const configs = readLaunchConfigs(root);
    if (!configs.found) {
      throw new Error('No shadrox.debug.json in this workspace. Add one at the workspace root to start a debug session.');
    }
    if (configs.error) throw new Error(configs.error);
    const resolvedList = configs.resolved ?? [];
    const chosen = configName
      ? resolvedList.find((entry) => entry.name === configName)
      : resolvedList[0];
    if (!chosen) {
      throw new Error(configName
        ? `No launch configuration named "${configName}" in shadrox.debug.json.`
        : 'shadrox.debug.json has no launch configurations.');
    }

    // One session at a time: replacing the debuggee is the explicit start.
    if (session) await stop(session.workspaceId);

    const active = {
      workspaceId,
      root,
      status: 'starting',
      configName: chosen.name,
      threadId: null,
      frameId: null,
      stopReason: null,
      exception: false,
      message: null,
      output: '',
      /** Bumped by every lifecycle event so a late request response cannot undo a stop. */
      eventGeneration: 0,
      child: null,
      client: null,
      stderrTail: '',
      breakpoints: new Map(pendingFor(workspaceId))
    };
    session = active;
    emitState(active);

    let child;
    try {
      child = spawn(chosen.resolvedAdapterCommand, chosen.resolvedAdapterArgs, {
        cwd: chosen.cwdPath,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      active.child = child;
      child.on('error', (error) => {
        if (session !== active) return;
        active.stderrTail = clip(`${active.stderrTail}${error.message}\n`, MAX_STDERR_TAIL);
      });
      child.stderr?.on('data', (chunk) => {
        // Raw adapter stderr never crosses into the renderer. Keep a bounded
        // tail for the one error message that needs a cause.
        active.stderrTail = clip(active.stderrTail + chunk.toString('utf8'), MAX_STDERR_TAIL);
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.on('exit', (code, signal) => {
        if (session !== active) return;
        if (active.status !== 'terminated' && active.status !== 'error') {
          active.status = 'terminated';
          active.threadId = null;
          active.frameId = null;
          active.message = `The debug adapter exited (${signal ?? code ?? 'unknown'}).`;
          emitState(active);
          emit(active, { type: 'terminated', message: active.message });
        }
      });

      const client = createDapClient(child, {
        onEvent: (event) => handleAdapterEvent(active, event),
        onError: (error) => {
          active.message = error.message;
          emit(active, { type: 'error', message: clip(error.message, 1000) });
        }
      });
      active.client = client;

      // Register before sending initialize so an eager adapter cannot race us.
      const initialized = client.waitForEvent('initialized', START_TIMEOUT_MS);
      const initResponse = await client.request('initialize', {
        adapterID: 'node',
        clientID: 'shadrox',
        clientName: 'ShadRox',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsConfigurationDoneRequest: true
      }, START_TIMEOUT_MS);
      const capabilities = isPlainObject(initResponse.body) ? initResponse.body : {};
      await initialized;

      const launchArgs = {
        type: 'node',
        request: 'launch',
        name: chosen.name,
        program: chosen.programPath,
        cwd: chosen.cwdPath,
        args: chosen.args
      };
      if (chosen.runtimeExecutable) launchArgs.runtimeExecutable = chosen.runtimeExecutable;
      await client.request('launch', launchArgs, START_TIMEOUT_MS);

      await applyStoredBreakpoints(active);

      if (capabilities.supportsConfigurationDoneRequest === true) {
        await client.request('configurationDone', {}, START_TIMEOUT_MS);
      }

      if (active.status === 'starting') {
        active.status = 'running';
        emitState(active);
      }
      return snapshot(active);
    } catch (error) {
      const detail = clip(`${error.message}${active.stderrTail.trim() ? `\n${active.stderrTail.trim()}` : ''}`, 2000);
      try { active.client?.dispose(); } catch { /* closed */ }
      active.client = null;
      killChild(active, false);
      active.status = 'error';
      active.message = detail;
      active.threadId = null;
      active.frameId = null;
      emitState(active);
      emit(active, { type: 'error', message: detail });
      throw new Error(detail);
    }
  }

  async function stop(workspaceId) {
    const active = session && (!workspaceId || session.workspaceId === workspaceId) ? session : null;
    if (!active) return;
    if (active.client) {
      try {
        await active.client.request('disconnect', { terminateDebuggee: true }, STOP_GRACE_MS);
      } catch {
        // The adapter may already be gone; teardown still runs.
      }
    }
    session = null;
    active.status = 'terminated';
    try { active.client?.dispose(); } catch { /* closed */ }
    active.client = null;
    killChild(active, true);
    emitState(active);
    emit(active, { type: 'terminated', message: 'Debug session stopped.' });
  }

  /** Synchronous teardown for workspace switches and window close. */
  function stopWorkspace(workspaceId) {
    pendingBreakpoints.delete(workspaceId);
    if (!session || session.workspaceId !== workspaceId) return;
    const active = session;
    session = null;
    try { active.client?.dispose(); } catch { /* closed */ }
    active.client = null;
    killChild(active, false);
    active.status = 'terminated';
    emitState(active);
    emit(active, { type: 'terminated', message: 'Debug session stopped.' });
  }

  function disposeAll() {
    if (session) stopWorkspace(session.workspaceId);
  }

  async function threads(workspaceId) {
    const active = session && session.workspaceId === workspaceId ? session : null;
    if (!active?.client) return [];
    const response = await active.client.request('threads', {});
    const list = Array.isArray(response.body?.threads) ? response.body.threads : [];
    return list.slice(0, MAX_THREADS).map((thread, index) => ({
      id: Number.isSafeInteger(thread.id) ? thread.id : index + 1,
      name: clip(typeof thread.name === 'string' ? thread.name : `Thread ${index + 1}`, 200)
    }));
  }

  async function stack(workspaceId) {
    const active = requireSession(workspaceId);
    const response = await active.client.request('stackTrace', {
      threadId: active.threadId ?? 1,
      startFrame: 0,
      levels: MAX_FRAMES
    });
    const list = Array.isArray(response.body?.stackFrames) ? response.body.stackFrames : [];
    return list.slice(0, MAX_FRAMES).map((frame, index) => ({
      id: Number.isSafeInteger(frame.id) ? frame.id : index + 1,
      name: clip(typeof frame.name === 'string' ? frame.name : '(anonymous)', 200),
      file: frame.source && typeof frame.source.path === 'string' ? relativeToRoot(active.root, frame.source.path) : null,
      line: Number.isSafeInteger(frame.line) ? frame.line : null,
      column: Number.isSafeInteger(frame.column) ? frame.column : null,
      sourceName: frame.source && typeof frame.source.name === 'string' ? clip(frame.source.name, 200) : null
    }));
  }

  async function scopes(workspaceId, frameId) {
    const active = requireSession(workspaceId);
    const id = Number.isSafeInteger(frameId) ? frameId : active.frameId;
    if (!Number.isSafeInteger(id)) throw new Error('A stack frame id is required.');
    const response = await active.client.request('scopes', { frameId: id });
    const list = Array.isArray(response.body?.scopes) ? response.body.scopes : [];
    return list.slice(0, MAX_SCOPES).map((scope, index) => ({
      name: clip(typeof scope.name === 'string' ? scope.name : `Scope ${index + 1}`, 200),
      variablesReference: Number.isSafeInteger(scope.variablesReference) ? scope.variablesReference : 0,
      expensive: scope.expensive === true,
      presentationHint: typeof scope.presentationHint === 'string' ? clip(scope.presentationHint, 100) : null
    }));
  }

  async function variables(workspaceId, variablesReference) {
    const active = requireSession(workspaceId);
    if (!Number.isSafeInteger(variablesReference) || variablesReference <= 0) {
      throw new Error('A positive variablesReference is required.');
    }
    const response = await active.client.request('variables', { variablesReference });
    const list = Array.isArray(response.body?.variables) ? response.body.variables : [];
    return list.slice(0, MAX_VARIABLES).map((variable, index) => ({
      name: clip(typeof variable.name === 'string' ? variable.name : `var${index}`, 200),
      value: clip(typeof variable.value === 'string' ? variable.value : '', MAX_VALUE_CHARS),
      type: typeof variable.type === 'string' ? clip(variable.type, 100) : null,
      variablesReference: Number.isSafeInteger(variable.variablesReference) ? variable.variablesReference : 0
    }));
  }

  /**
   * Hover evaluation. Only a *paused* session may evaluate, because that is the
   * only time a frame id is meaningful and the only time the debuggee is not
   * running the user's code. The expression is a single bounded line, so a
   * hover can never smuggle a multi-statement program into the debuggee.
   */
  async function evaluate(workspaceId, frameId, expression) {
    const active = requireSession(workspaceId);
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('An expression is required.');
    }
    if (expression.length > MAX_EXPRESSION_CHARS || /[\r\n]/.test(expression)) {
      throw new Error(`The hover expression must be one line of at most ${MAX_EXPRESSION_CHARS} characters.`);
    }
    const id = Number.isSafeInteger(frameId) ? frameId : active.frameId;
    if (!Number.isSafeInteger(id)) throw new Error('A stack frame id is required.');
    const response = await active.client.request('evaluate', {
      expression,
      frameId: id,
      context: 'hover'
    });
    const body = isPlainObject(response.body) ? response.body : {};
    return {
      result: clip(typeof body.result === 'string' ? body.result : '', MAX_VALUE_CHARS),
      type: typeof body.type === 'string' ? clip(body.type, 100) : null,
      variablesReference: Number.isSafeInteger(body.variablesReference) ? body.variablesReference : 0
    };
  }

  async function setBreakpoints(workspaceId, file, lines) {
    const root = workspaceRoot(workspaceId);
    if (typeof file !== 'string' || !file.trim()) throw new Error('A workspace-relative file path is required.');
    const normalizedFile = toPosix(file);
    const absolute = path.resolve(root, normalizedFile);
    if (!isPathInsideDirectory(root, absolute)) throw new Error('Breakpoint file resolves outside the workspace.');
    const normalizedLines = normalizeBreakpointLines(lines);

    pendingFor(workspaceId).set(normalizedFile, normalizedLines);
    const active = session && session.workspaceId === workspaceId ? session : null;
    if (!active?.client || active.status === 'starting' || active.status === 'terminated' || active.status === 'error') {
      // Store for the next start; report the requested lines as unverified.
      if (active) active.breakpoints.set(normalizedFile, normalizedLines);
      return normalizedLines.map((line) => ({ file: normalizedFile, line, verified: false, id: null }));
    }
    active.breakpoints.set(normalizedFile, normalizedLines);
    return sendBreakpoints(active, normalizedFile, normalizedLines);
  }

  async function resume(workspaceId, command, threadId) {
    const active = requireSession(workspaceId, true);
    const id = Number.isSafeInteger(threadId) ? threadId : active.threadId ?? 1;
    const generation = active.eventGeneration;
    await active.client.request(command, { threadId: id });
    if (command === 'continue' || command === 'next' || command === 'stepIn' || command === 'stepOut') {
      // A fast adapter can emit `stopped` before the response is even
      // dispatched. Only mark running if no lifecycle event raced the request.
      if (active.eventGeneration === generation && active.status !== 'terminated' && active.status !== 'error') {
        active.status = 'running';
        active.frameId = null;
        active.stopReason = null;
        active.exception = false;
        emitState(active);
      }
    }
    return snapshot(active);
  }

  function state(workspaceId) {
    if (!session || session.workspaceId !== workspaceId) return emptyState(workspaceId);
    return snapshot(session);
  }

  function breakpoints(workspaceId) {
    const map = session && session.workspaceId === workspaceId
      ? session.breakpoints
      : pendingFor(workspaceId);
    return Object.fromEntries([...map].map(([file, lines]) => [file, [...lines]]));
  }

  return {
    configs: (workspaceId) => {
      const root = workspaceRoot(workspaceId);
      const result = readLaunchConfigs(root);
      return {
        found: result.found,
        path: result.path,
        configurations: result.configurations,
        error: result.error
      };
    },
    start,
    stop,
    stopWorkspace,
    disposeAll,
    state,
    breakpoints,
    setBreakpoints,
    threads,
    stack,
    scopes,
    variables,
    evaluate,
    continue: (workspaceId, threadId) => resume(workspaceId, 'continue', threadId),
    next: (workspaceId, threadId) => resume(workspaceId, 'next', threadId),
    stepIn: (workspaceId, threadId) => resume(workspaceId, 'stepIn', threadId),
    stepOut: (workspaceId, threadId) => resume(workspaceId, 'stepOut', threadId),
    pause: (workspaceId, threadId) => resume(workspaceId, 'pause', threadId)
  };
}

module.exports = {
  createDebugHost,
  readLaunchConfigs,
  resolveAdapterCommand,
  LIMITS: {
    MAX_CONFIG_BYTES,
    MAX_CONFIGURATIONS,
    MAX_THREADS,
    MAX_FRAMES,
    MAX_SCOPES,
    MAX_VARIABLES,
    MAX_VALUE_CHARS,
    MAX_EXPRESSION_CHARS,
    MAX_OUTPUT_CHARS
  }
};
