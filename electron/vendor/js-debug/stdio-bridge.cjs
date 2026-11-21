'use strict';

/**
 * Self-contained multi-session stdio-to-TCP DAP bridge for Microsoft's bundled `dapDebugServer.js`.
 *
 * `dapDebugServer.js` listens on localhost TCP and delegates actual Node/browser target execution
 * to a child DAP session created via the `startDebugging` reverse request. This bridge exposes a
 * standard single-session stdio DAP interface to ShadRox's `debug-host.cjs` while managing the
 * parent + target TCP connections transparently (zero external dependencies; works inside
 * `resources/js-debug` in packaged Electron builds).
 */

const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const serverPath = process.argv[2];
if (!serverPath || !fs.existsSync(serverPath)) {
  process.stderr.write(`Bundled js-debug server not found: ${serverPath || '(missing)'}\n`);
  process.exit(1);
}

function encodeDap(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function createDapParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  let expected = -1;
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (expected >= 0) {
          if (buffer.length < expected) return;
          const body = buffer.subarray(0, expected).toString('utf8');
          buffer = buffer.subarray(expected);
          expected = -1;
          try {
            onMessage(JSON.parse(body));
          } catch (err) {
            if (onError) onError(err);
          }
          continue;
        }
        const sep = buffer.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const header = buffer.subarray(0, sep).toString('utf8');
        buffer = buffer.subarray(sep + 4);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) continue;
        expected = Number(match[1]);
      }
    }
  };
}

const child = spawn(process.execPath, [serverPath, '0', '127.0.0.1'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let serverHost = '127.0.0.1';
let serverPort = 0;
let parentSock = null;
let targetSock = null;
let parentSeq = 1;
let targetSeq = 1;
let parentConnected = false;
let stdoutBanner = '';
const hostPendingMessages = [];
/** Remap adapter request_seq -> host request_seq so multi-session routing never collides. */
const parentInFlight = new Map();
const targetInFlight = new Map();
/** Stored host `setBreakpoints` arguments replayed onto child target sessions. */
const storedBreakpoints = new Map();
/** Breakpoints sent before a target connected; resolved against host once replied or target applies. */
const TARGET_COMMANDS = new Set([
  'threads',
  'stackTrace',
  'scopes',
  'variables',
  'evaluate',
  'exceptionInfo',
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'pause',
  'setBreakpoints'
]);

function sendToHost(msg) {
  process.stdout.write(encodeDap(msg), 'utf8');
}

function sendOnSocket(sock, nextSeqFn, inFlightMap, hostMsg) {
  if (!sock || sock.destroyed) return false;
  const localSeq = nextSeqFn();
  if (hostMsg.type === 'request') {
    inFlightMap.set(localSeq, hostMsg.seq);
  }
  sock.write(encodeDap({ ...hostMsg, seq: localSeq }), 'utf8');
  return true;
}

function spawnTargetSession(startReq) {
  const reqArgs = startReq.arguments || {};
  const cmd = reqArgs.request === 'attach' ? 'attach' : 'launch';
  const config = reqArgs.configuration || {};
  const sock = net.connect({ host: serverHost, port: serverPort });
  let localSeq = 1;
  let initializedDone = false;
  let readyForHost = false;
  const localPending = new Set();

  function sendInternal(msg) {
    const seq = localSeq++;
    localPending.add(seq);
    sock.write(encodeDap({ ...msg, seq }), 'utf8');
    return seq;
  }

  const parser = createDapParser((msg) => {
    if (msg.type === 'response') {
      if (localPending.has(msg.request_seq)) {
        localPending.delete(msg.request_seq);
        if (msg.command === cmd) {
          readyForHost = true;
        }
        return;
      }
      if (targetInFlight.has(msg.request_seq)) {
        const hostSeq = targetInFlight.get(msg.request_seq);
        targetInFlight.delete(msg.request_seq);
        sendToHost({ ...msg, request_seq: hostSeq });
      }
      return;
    }

    if (msg.type === 'event') {
      if (msg.event === 'initialized' && !initializedDone) {
        initializedDone = true;
        for (const bpArgs of storedBreakpoints.values()) {
          sendInternal({ type: 'request', command: 'setBreakpoints', arguments: bpArgs });
        }
        sendInternal({ type: 'request', command: cmd, arguments: config });
        sendInternal({ type: 'request', command: 'configurationDone', arguments: {} });
        return;
      }
      if (msg.event === 'terminated') {
        sendToHost({ seq: 0, type: 'event', event: 'terminated', body: msg.body || {} });
        return;
      }
      if (readyForHost || msg.event === 'stopped' || msg.event === 'output' || msg.event === 'breakpoint' || msg.event === 'continued') {
        sendToHost(msg);
      }
      return;
    }

    if (msg.type === 'request') {
      sock.write(encodeDap({
        seq: localSeq++,
        type: 'response',
        request_seq: msg.seq,
        success: false,
        command: msg.command,
        message: `ShadRox does not implement '${msg.command}'`
      }), 'utf8');
    }
  });

  sock.on('data', (chunk) => parser.push(chunk));
  sock.on('error', (err) => {
    process.stderr.write(`js-debug target socket error: ${err.message}\n`);
  });
  sock.on('close', () => {
    if (targetSock === sock) targetSock = null;
    for (const hostSeq of targetInFlight.values()) {
      sendToHost({
        seq: 0,
        type: 'response',
        request_seq: hostSeq,
        success: false,
        command: 'unknown',
        message: 'Target debug session closed.'
      });
    }
    targetInFlight.clear();
  });

  targetSock = sock;
  targetSeq = () => localSeq++;
  sendInternal({
    type: 'request',
    command: 'initialize',
    arguments: {
      adapterID: 'pwa-node',
      clientID: 'shadrox',
      clientName: 'ShadRox',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsConfigurationDoneRequest: true
    }
  });
}

function forwardHostMessage(msg) {
  if (msg.type !== 'request') return;

  if (msg.command === 'setBreakpoints' && msg.arguments?.source?.path) {
    storedBreakpoints.set(msg.arguments.source.path, msg.arguments);
    if (targetSock && !targetSock.destroyed) {
      sendOnSocket(targetSock, () => targetSeq(), targetInFlight, msg);
      return;
    }
    // No target attached yet: echo immediate unverified placeholder so host does not hang before launch.
    const lines = Array.isArray(msg.arguments.breakpoints) ? msg.arguments.breakpoints : [];
    sendToHost({
      seq: 0,
      type: 'response',
      request_seq: msg.seq,
      success: true,
      command: 'setBreakpoints',
      body: {
        breakpoints: lines.map((bp) => ({ verified: false, line: bp.line }))
      }
    });
    return;
  }

  if (msg.command === 'disconnect') {
    if (targetSock && !targetSock.destroyed) {
      try {
        targetSock.write(encodeDap({ seq: targetSeq(), type: 'request', command: 'disconnect', arguments: msg.arguments || {} }), 'utf8');
      } catch {
        // ignore
      }
    }
    sendOnSocket(parentSock, () => parentSeq++, parentInFlight, msg);
    return;
  }

  if (TARGET_COMMANDS.has(msg.command) && targetSock && !targetSock.destroyed) {
    sendOnSocket(targetSock, () => targetSeq(), targetInFlight, msg);
    return;
  }

  let outbound = msg;
  if (msg.command === 'initialize' && msg.arguments?.adapterID === 'node') {
    outbound = { ...msg, arguments: { ...msg.arguments, adapterID: 'pwa-node' } };
  } else if ((msg.command === 'launch' || msg.command === 'attach') && msg.arguments?.type === 'node') {
    outbound = { ...msg, arguments: { ...msg.arguments, type: 'pwa-node' } };
  }

  sendOnSocket(parentSock, () => parentSeq++, parentInFlight, outbound);
}

const hostParser = createDapParser(
  (msg) => {
    if (!parentConnected || !parentSock || parentSock.destroyed) {
      hostPendingMessages.push(msg);
      return;
    }
    forwardHostMessage(msg);
  },
  (err) => process.stderr.write(`js-debug bridge parse error: ${err.message}\n`)
);

process.stdin.on('data', (chunk) => hostParser.push(chunk));

function cleanup() {
  try { if (targetSock && !targetSock.destroyed) targetSock.destroy(); } catch { /* ignore */ }
  try { if (parentSock && !parentSock.destroyed) parentSock.destroy(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}

process.stdin.on('end', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.stdout.on('data', (chunk) => {
  if (parentConnected) return;
  stdoutBanner += chunk.toString('utf8');
  const match = /Debug server listening at\s+(?:([^:\s]+):)?(\d+)/i.exec(stdoutBanner);
  if (!match) return;
  serverHost = match[1] || '127.0.0.1';
  serverPort = Number(match[2]);
  parentConnected = true;

  parentSock = net.connect({ port: serverPort, host: serverHost }, () => {
    while (hostPendingMessages.length > 0) {
      forwardHostMessage(hostPendingMessages.shift());
    }
  });

  const parentParser = createDapParser((msg) => {
    if (msg.type === 'response') {
      const hostSeq = parentInFlight.get(msg.request_seq);
      if (hostSeq !== undefined) {
        parentInFlight.delete(msg.request_seq);
        sendToHost({ ...msg, request_seq: hostSeq });
      }
      return;
    }
    if (msg.type === 'request') {
      if (msg.command === 'startDebugging') {
        parentSock.write(encodeDap({
          seq: parentSeq++,
          type: 'response',
          request_seq: msg.seq,
          success: true,
          command: 'startDebugging',
          body: {}
        }), 'utf8');
        spawnTargetSession(msg);
        return;
      }
      sendToHost(msg);
      return;
    }
    if (msg.type === 'event') {
      // Forward parent events cleanly; `terminated` still exits when parent closes.
      sendToHost(msg);
    }
  });

  parentSock.on('data', (data) => parentParser.push(data));
  parentSock.on('error', (err) => {
    process.stderr.write(`js-debug bridge socket error: ${err.message}\n`);
    cleanup();
    process.exit(1);
  });
  parentSock.on('close', () => {
    cleanup();
    process.exit(0);
  });
});

child.on('error', (err) => {
  process.stderr.write(`js-debug failed to spawn: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (!parentConnected) {
    process.exit(code ?? 1);
  }
});
