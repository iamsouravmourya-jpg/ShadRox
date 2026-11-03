const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';
const CONFIG_MAX_BYTES = 1024 * 1024;
const BODY_MAX_BYTES = 64 * 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const UTF8_BOM = /^\uFEFF/;

/**
 * Parse the workspace's automations.json into the minimal webhook surface the
 * server needs. Malformed JSON, unknown shapes, disabled entries, non-webhook
 * triggers and unusable secrets are all silently ignored: the endpoint answers
 * 404 for anything it cannot serve and never echoes file contents.
 *
 * Both the array form and `{ automations: [...] }` are accepted, matching
 * `src/lib/automations/parseAutomations`.
 */
function parseWebhookDefinitions(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(UTF8_BOM, ''));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.automations)
      ? parsed.automations
      : null;
  if (!list) return [];

  const definitions = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128) continue;
    if (item.enabled !== true) continue;
    const trigger = item.trigger;
    if (!trigger || typeof trigger !== 'object' || trigger.type !== 'webhook') continue;
    if (typeof trigger.path !== 'string' || !trigger.path.startsWith('/') || trigger.path.length > 1024) continue;
    if (typeof trigger.secret !== 'string' || trigger.secret.length < 16) continue;
    definitions.push({ id: item.id, path: trigger.path, secret: trigger.secret });
  }
  return definitions;
}

function matchWebhook(definitions, pathname) {
  // Lowest id wins so the outcome never depends on file order.
  const sorted = [...definitions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const definition of sorted) {
    if (definition.path === pathname) return definition;
  }
  return null;
}

/**
 * Compare two strings in constant time. Both sides are hashed first so the
 * comparison always runs over the same number of bytes and cannot be timed by
 * input length.
 */
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function readProvidedSecret(request) {
  const headers = request.headers || {};
  const direct = headers['x-shadrox-secret'];
  if (typeof direct === 'string' && direct) return direct;
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match) return match[1];
  }
  return '';
}

function readRequestBody(request, limit) {
  return new Promise((resolve) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ tooLarge: true, body: null });
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish({ tooLarge: true, body: null });
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => finish({ tooLarge: false, body: Buffer.concat(chunks) }));
    request.once('error', () => finish({ tooLarge: true, body: null }));
    request.once('aborted', () => finish({ tooLarge: true, body: null }));
  });
}

function parsePayload(body) {
  if (!body || body.length === 0) return null;
  const text = body.toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function writeResponse(response, statusCode, message) {
  if (!response || response.writableEnded || response.destroyed) return;
  const body = JSON.stringify({ status: statusCode, message });
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

/**
 * Loopback-only HTTP receiver for webhook automations.
 *
 * The server never reads workspace actions and never executes anything: it
 * authenticates a request, applies a per-automation rate limit, and hands a
 * plain `{ automationId, receivedAt, payload }` event to the renderer, which
 * runs the action through its normal gates.
 *
 * @param {{
 *   getRoot: () => string|null,
 *   onTrigger: (event: { automationId: string, receivedAt: number, payload: unknown }) => void,
 *   readFile?: (filePath: string) => Promise<Buffer|string>
 * }} options
 */
function createAutomationWebhook({ getRoot, onTrigger, readFile = (filePath) => fs.readFile(filePath) } = {}) {
  if (typeof getRoot !== 'function') throw new Error('createAutomationWebhook requires a getRoot function.');
  if (typeof onTrigger !== 'function') throw new Error('createAutomationWebhook requires an onTrigger function.');

  const triggerTimes = new Map();
  let server = null;
  let port = null;
  let error = null;
  let starting = null;

  function status() {
    return { running: Boolean(server), port, error };
  }

  function allowTrigger(automationId, now) {
    const cutoff = now - RATE_WINDOW_MS;
    const recent = (triggerTimes.get(automationId) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= RATE_LIMIT) {
      triggerTimes.set(automationId, recent);
      return false;
    }
    recent.push(now);
    triggerTimes.set(automationId, recent);
    return true;
  }

  async function loadDefinitions(root) {
    const file = path.join(root, '.shadrox', 'automations.json');
    let raw;
    try {
      raw = await readFile(file);
    } catch {
      return [];
    }
    let buffer;
    if (typeof raw === 'string') buffer = Buffer.from(raw, 'utf8');
    else if (Buffer.isBuffer(raw)) buffer = raw;
    else return [];
    if (buffer.length > CONFIG_MAX_BYTES) return [];
    return parseWebhookDefinitions(buffer.toString('utf8'));
  }

  async function handleRequest(request, response) {
    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      writeResponse(response, 404, 'Not found');
      return;
    }

    let target;
    try {
      target = new URL(request.url || '/', `http://${HOST}`);
    } catch {
      writeResponse(response, 404, 'Not found');
      return;
    }

    let root = null;
    try {
      root = getRoot();
    } catch {
      root = null;
    }
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      writeResponse(response, 404, 'Not found');
      return;
    }

    const definitions = await loadDefinitions(root);
    const definition = matchWebhook(definitions, target.pathname);
    if (!definition) {
      writeResponse(response, 404, 'Not found');
      return;
    }

    const provided = readProvidedSecret(request);
    if (!provided || !constantTimeEqual(provided, definition.secret)) {
      writeResponse(response, 401, 'Unauthorized');
      return;
    }

    const body = await readRequestBody(request, BODY_MAX_BYTES);
    if (body.tooLarge) {
      writeResponse(response, 413, 'Payload too large');
      // Drain whatever is still arriving so the socket can be reused.
      request.resume();
      return;
    }

    const receivedAt = Date.now();
    if (!allowTrigger(definition.id, receivedAt)) {
      writeResponse(response, 429, 'Rate limit exceeded');
      return;
    }

    writeResponse(response, 202, 'Accepted');
    try {
      onTrigger({ automationId: definition.id, receivedAt, payload: parsePayload(body.body) });
    } catch {
      // A renderer-side failure belongs to the caller; the request was accepted.
    }
  }

  function start() {
    if (server) return Promise.resolve(status());
    if (starting) return starting;

    starting = new Promise((resolve) => {
      const instance = http.createServer((request, response) => {
        handleRequest(request, response).catch(() => {
          writeResponse(response, 500, 'Automation webhook failed');
        });
      });
      // A malformed request line must not crash the main process.
      instance.on('clientError', (_clientError, socket) => {
        try {
          socket.destroy();
        } catch {
          // The socket already closed.
        }
      });

      const onStartupError = (startupError) => {
        error = startupError instanceof Error ? startupError.message : String(startupError);
        server = null;
        port = null;
        starting = null;
        try {
          instance.close();
        } catch {
          // The listener never bound.
        }
        resolve(status());
      };
      instance.once('error', onStartupError);

      instance.listen(0, HOST, () => {
        instance.removeListener('error', onStartupError);
        const address = instance.address();
        if (!address || typeof address === 'string') {
          error = 'The automation webhook could not determine its local port.';
          server = null;
          port = null;
          starting = null;
          try {
            instance.close();
          } catch {
            // The listener never bound.
          }
          resolve(status());
          return;
        }
        server = instance;
        port = address.port;
        error = null;
        starting = null;
        // Runtime errors after a successful bind are reported, not thrown.
        instance.on('error', (runtimeError) => {
          error = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
        });
        resolve(status());
      });
    });

    return starting;
  }

  function stop() {
    const current = server;
    server = null;
    port = null;
    starting = null;
    triggerTimes.clear();
    if (!current) {
      error = null;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        error = null;
        resolve();
      };
      current.close(() => finish());
      // Keep-alive sockets from a renderer or curl would otherwise hold the
      // close callback open; both helpers exist on supported Node versions.
      if (typeof current.closeIdleConnections === 'function') current.closeIdleConnections();
      if (typeof current.closeAllConnections === 'function') current.closeAllConnections();
      const fallback = setTimeout(finish, 2000);
      if (typeof fallback.unref === 'function') fallback.unref();
    });
  }

  return { start, stop, status };
}

module.exports = {
  BODY_MAX_BYTES,
  CONFIG_MAX_BYTES,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  constantTimeEqual,
  createAutomationWebhook,
  parseWebhookDefinitions
};
