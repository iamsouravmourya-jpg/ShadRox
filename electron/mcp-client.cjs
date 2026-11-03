const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'ShadRox';
const DEFAULT_CLIENT_VERSION = '0.0.3';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 200;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 4_096;
const MAX_TOOL_PAGES = 10;
const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const SAFE_ENVIRONMENT_VARIABLES = new Set([
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'HTTPS_PROXY', 'HTTP_PROXY',
  'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NO_PROXY', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME',
  'USERPROFILE', 'WINDIR'
]);

const FORBIDDEN_HEADERS = new Set([
  'connection', 'content-length', 'host', 'mcp-session-id', 'transfer-encoding', 'upgrade'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Only an absolute http(s) URL is acceptable for the streamable HTTP
 * transport. Userinfo is rejected because the credentials would be sent on
 * every request and would end up in logs and error messages.
 */
function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return false;
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;
  return true;
}

/** Validates a user-authored server entry and returns a normalized copy. */
function validateServerConfig(config) {
  if (!isPlainObject(config)) throw new Error('An MCP server configuration object is required.');
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    throw new Error('MCP server transport must be "stdio" or "http".');
  }
  const name = typeof config.name === 'string' ? config.name.trim().slice(0, 120) : '';
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error('MCP timeoutMs must be an integer between 100 and 120000.');
  }

  if (config.transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command.trim() : '';
    if (!command) throw new Error('An MCP stdio server needs a command to launch.');
    if (command.length > 1024) throw new Error('The MCP stdio command is too long.');
    if (command.includes('\0')) throw new Error('The MCP stdio command contains a NUL character.');

    const args = config.args === undefined ? [] : config.args;
    if (!Array.isArray(args) || args.length > 128) throw new Error('MCP stdio args must be an array of at most 128 strings.');
    const normalizedArgs = args.map((value) => {
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
        throw new Error('MCP stdio args must be strings shorter than 8192 characters without NUL bytes.');
      }
      return value;
    });

    const env = config.env === undefined ? {} : config.env;
    if (!isPlainObject(env) || Object.keys(env).length > 128) {
      throw new Error('MCP stdio env must be an object with at most 128 variables.');
    }
    const normalizedEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`"${key}" is not a valid environment variable name for an MCP server.`);
      }
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
        throw new Error(`The MCP environment variable "${key}" must be a string without NUL characters.`);
      }
      normalizedEnv[key] = value;
    }

    const cwd = config.cwd === undefined ? undefined : config.cwd;
    if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
      throw new Error('MCP stdio cwd must be an absolute path.');
    }
    return { name, transport: 'stdio', timeoutMs, command, args: normalizedArgs, env: normalizedEnv, cwd };
  }

  if (!isSafeHttpUrl(config.url)) {
    throw new Error('An MCP HTTP server needs an absolute http(s) URL without embedded credentials.');
  }
  const headers = config.headers === undefined ? {} : config.headers;
  if (!isPlainObject(headers) || Object.keys(headers).length > 32) {
    throw new Error('MCP HTTP headers must be an object with at most 32 entries.');
  }
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(key)) throw new Error(`"${key}" is not a valid HTTP header name.`);
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      throw new Error(`The MCP HTTP header "${key}" is managed by ShadRox and cannot be overridden.`);
    }
    if (typeof value !== 'string' || value.length > MAX_HEADER_BYTES || /[\0\r\n]/.test(value)) {
      throw new Error(`The MCP HTTP header "${key}" must be a string without control characters.`);
    }
    normalizedHeaders[key] = value.trim();
  }
  return { name, transport: 'http', timeoutMs, url: config.url, headers: normalizedHeaders };
}

function createRpcError(method, error) {
  const detail = isPlainObject(error) ? error : {};
  const code = Number.isInteger(detail.code) ? detail.code : null;
  const message = typeof detail.message === 'string' && detail.message.trim()
    ? detail.message.trim()
    : 'The MCP server reported an error without a message.';
  const result = new Error(`MCP request "${method}" failed (code ${code === null ? 'unknown' : code}): ${message}`);
  if (code !== null) result.code = code;
  if (detail.data !== undefined) result.data = detail.data;
  return result;
}

/** Streamable HTTP servers may answer a POST with either JSON or an SSE stream. */
function readSseMessage(text, expectedId) {
  const events = [];
  let dataLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      if (dataLines.length > 0) events.push(dataLines.join('\n'));
      dataLines = [];
      continue;
    }
    if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length > 0) events.push(dataLines.join('\n'));
  const messages = [];
  for (const event of events) {
    try {
      const message = JSON.parse(event);
      if (isPlainObject(message)) messages.push(message);
    } catch {
      // Non-JSON event payloads are not responses and are ignored.
    }
  }
  const matched = messages.find((message) => message.id === expectedId);
  if (matched) return matched;
  return messages.find((message) => 'result' in message || 'error' in message) || null;
}

function buildEnvironment(overrides) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (SAFE_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) environment[key] = value;
  }
  // Explicit server variables are merged last so users can supply the tokens a
  // server needs without inheriting every credential of the ShadRox process.
  return { ...environment, ...overrides };
}

/**
 * Creates a single MCP server session. The returned client lazily starts the
 * stdio child, keeps one HTTP session id, and requires `onApproveTool` before
 * any tool is executed.
 */
function createMcpClient(options = {}) {
  const config = validateServerConfig(options);
  const approvalHandler = typeof options.onApproveTool === 'function' ? options.onApproveTool : null;
  const stderrListener = typeof options.onStderr === 'function' ? options.onStderr : () => {};
  const clientVersion = typeof options.version === 'string' && options.version.trim()
    ? options.version.trim().slice(0, 64)
    : DEFAULT_CLIENT_VERSION;

  const pending = new Map();
  let nextId = 1;
  let child = null;
  let childClosed = false;
  let childFailure = null;
  let stdoutBuffer = '';
  let sessionId = null;
  let protocolVersion = null;
  let handshake = null;
  let handshakePromise = null;
  let closed = false;
  let closing = null;

  function rejectPending(error) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function ensureChild() {
    if (closed) throw new Error('The MCP client is closed.');
    if (childFailure) throw childFailure;
    if (child) return child;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(config.command)) {
      throw new Error(
        'MCP stdio servers cannot be launched through a Windows shell. Point the command at an executable ' +
        'such as node.exe or the server binary instead of a .cmd or .bat shim.'
      );
    }
    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: buildEnvironment(config.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => handleStdout(String(chunk)));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      // Never retain stderr: servers commonly print tokens or workspace paths.
      stderrListener(String(chunk));
    });
    proc.stdin.on('error', (error) => {
      rejectPending(new Error(`The MCP server input stream failed: ${error.message}`));
    });
    proc.once('error', (error) => {
      childFailure = new Error(`MCP server "${config.command}" could not be started: ${error.message}`);
      rejectPending(childFailure);
    });
    proc.once('close', (code, signal) => {
      childClosed = true;
      const reason = signal ? `signal ${signal}` : `code ${code === null || code === undefined ? 'unknown' : code}`;
      childFailure = new Error(`MCP server process exited (${reason}).`);
      rejectPending(childFailure);
    });
    return proc;
  }

  function writeStdioMessage(message) {
    const proc = ensureChild();
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function handleStdout(chunk) {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > 4 * MAX_RESULT_BYTES && stdoutBuffer.indexOf('\n') === -1) {
      stdoutBuffer = '';
      rejectPending(new Error('The MCP server emitted more than 4 MB without a message boundary.'));
      return;
    }
    let boundary = stdoutBuffer.indexOf('\n');
    while (boundary !== -1) {
      const line = stdoutBuffer.slice(0, boundary).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(boundary + 1);
      if (line.trim()) handleStdioLine(line);
      boundary = stdoutBuffer.indexOf('\n');
    }
  }

  function handleStdioLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Servers legitimately print banners to stdout; a malformed line is not a
      // protocol message and must not stall pending requests.
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const entry of messages) handleServerMessage(entry);
  }

  function handleServerMessage(message) {
    if (!isPlainObject(message)) return;
    if (typeof message.method === 'string') {
      // ShadRox declares no client capabilities, so server-initiated requests
      // (sampling, roots, elicitation) are answered as unsupported.
      if (message.id !== undefined) {
        try {
          writeStdioMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Unsupported client method: ${message.method}` }
          });
        } catch {
          // A dying child is reported through its close handler.
        }
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const entry = pending.get(message.id)
      || pending.get(String(message.id))
      || pending.get(Number(message.id));
    if (!entry) return;
    pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(createRpcError(entry.method, message.error));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
      entry.reject(new Error(`The MCP response for "${entry.method}" contained neither a result nor an error.`));
      return;
    }
    entry.resolve(message.result);
  }

  function sendStdioRequest(method, params) {
    let proc;
    try {
      proc = ensureChild();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = nextId;
    nextId += 1;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`MCP request "${method}" timed out after ${config.timeoutMs} ms.`));
      }, config.timeoutMs);
      pending.set(id, { id, method, resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP request "${method}" could not be sent: ${error.message}`));
      }
    });
  }

  function sendHttpExchange(message, expectResponse) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('The MCP client is closed.'));
        return;
      }
      const target = new URL(config.url);
      const transport = target.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(body.length),
        ...config.headers
      };
      if (sessionId) headers[SESSION_HEADER] = sessionId;
      if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;

      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const request = transport.request(target, { method: 'POST', headers, agent: false }, (response) => {
        const status = response.statusCode || 0;
        const session = response.headers[SESSION_HEADER];
        if (typeof session === 'string' && session.trim() && session.length <= 256) sessionId = session.trim();

        if (status >= 300 && status < 400) {
          response.resume();
          settle(reject, new Error(
            `The MCP HTTP server answered with HTTP ${status}; redirects are not followed. ` +
            'Configure the final MCP endpoint URL instead.'
          ));
          return;
        }
        if (!expectResponse) {
          response.resume();
          response.once('end', () => {
            if (status >= 400) {
              settle(reject, new Error(`The MCP HTTP notification "${message.method}" failed with status ${status}.`));
              return;
            }
            settle(resolve, null);
          });
          response.once('error', (error) => settle(reject, error));
          return;
        }

        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESULT_BYTES) {
            request.destroy(new Error(`The MCP response exceeded the ${MAX_RESULT_BYTES / (1024 * 1024)} MB limit.`));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', (error) => settle(reject, error));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            let detail = '';
            try {
              const parsed = JSON.parse(text);
              if (isPlainObject(parsed) && isPlainObject(parsed.error) && typeof parsed.error.message === 'string') {
                detail = ` ${parsed.error.message}`;
              }
            } catch {
              // An empty or non-JSON error body still reports its status code.
            }
            settle(reject, new Error(`The MCP HTTP request "${message.method}" failed with status ${status}.${detail}`));
            return;
          }
          const contentType = String(response.headers['content-type'] || '').toLowerCase();
          let reply = null;
          if (contentType.includes('text/event-stream')) {
            reply = readSseMessage(text, message.id);
          } else {
            try {
              reply = JSON.parse(text);
            } catch {
              settle(reject, new Error(`The MCP HTTP response for "${message.method}" was not valid JSON.`));
              return;
            }
          }
          if (!isPlainObject(reply)) {
            settle(reject, new Error(`The MCP HTTP response for "${message.method}" did not contain a JSON-RPC message.`));
            return;
          }
          if (reply.error !== undefined) {
            settle(reject, createRpcError(message.method, reply.error));
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(reply, 'result')) {
            settle(reject, new Error(`The MCP response for "${message.method}" contained neither a result nor an error.`));
            return;
          }
          settle(resolve, reply.result);
        });
      });

      const timer = setTimeout(() => {
        request.destroy(new Error(`MCP request "${message.method}" timed out after ${config.timeoutMs} ms.`));
      }, config.timeoutMs);
      request.once('error', (error) => settle(reject, error));
      request.end(body);
    });
  }

  function sendRequest(method, params) {
    if (closed) return Promise.reject(new Error('The MCP client is closed.'));
    if (config.transport === 'stdio') return sendStdioRequest(method, params);
    const message = { jsonrpc: '2.0', id: nextId, method };
    nextId += 1;
    if (params !== undefined) message.params = params;
    return sendHttpExchange(message, true);
  }

  function sendNotification(method, params) {
    if (closed) return Promise.reject(new Error('The MCP client is closed.'));
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    if (config.transport === 'stdio') {
      return Promise.resolve().then(() => {
        writeStdioMessage(message);
      });
    }
    return sendHttpExchange(message, false);
  }

  async function performInitialize() {
    const result = await sendRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: clientVersion }
    });
    if (!isPlainObject(result)) throw new Error('The MCP initialize result was not an object.');
    if (typeof result.protocolVersion !== 'string' || !result.protocolVersion.trim()) {
      throw new Error('The MCP initialize result did not include a protocol version.');
    }
    const serverInfo = isPlainObject(result.serverInfo)
      ? {
        name: typeof result.serverInfo.name === 'string' ? result.serverInfo.name : 'unknown',
        version: typeof result.serverInfo.version === 'string' ? result.serverInfo.version : 'unknown'
      }
      : { name: 'unknown', version: 'unknown' };
    protocolVersion = result.protocolVersion;
    handshake = {
      protocolVersion: result.protocolVersion,
      capabilities: isPlainObject(result.capabilities) ? result.capabilities : {},
      serverInfo
    };
    await sendNotification('notifications/initialized');
    return handshake;
  }

  function initialize() {
    if (closed) return Promise.reject(new Error('The MCP client is closed.'));
    if (handshake) return Promise.resolve(handshake);
    if (!handshakePromise) {
      handshakePromise = performInitialize().finally(() => {
        handshakePromise = null;
      });
    }
    return handshakePromise;
  }

  async function listTools() {
    await initialize();
    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS; page += 1) {
      const result = await sendRequest('tools/list', cursor ? { cursor } : {});
      if (!isPlainObject(result)) throw new Error('The MCP tools/list result was not an object.');
      if (result.tools !== undefined && !Array.isArray(result.tools)) {
        throw new Error('The MCP tools/list result did not include a tool array.');
      }
      for (const tool of result.tools || []) {
        if (tools.length >= MAX_TOOLS) break;
        if (!isPlainObject(tool)) continue;
        const name = typeof tool.name === 'string' ? tool.name.trim() : '';
        if (!TOOL_NAME_PATTERN.test(name) || seen.has(name)) continue;
        seen.add(name);
        tools.push({
          name,
          description: typeof tool.description === 'string' ? tool.description.slice(0, 4096) : '',
          inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} }
        });
      }
      const nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor : '';
      if (!nextCursor || tools.length >= MAX_TOOLS) break;
      cursor = nextCursor;
    }
    return tools;
  }

  function normalizeToolResult(name, result) {
    if (!isPlainObject(result)) throw new Error(`The MCP tool "${name}" returned an invalid result.`);
    const serialized = JSON.stringify(result);
    const size = Buffer.byteLength(serialized, 'utf8');
    if (size > MAX_RESULT_BYTES) {
      throw new Error(
        `The MCP tool "${name}" returned ${size} bytes, which exceeds the ${MAX_RESULT_BYTES / (1024 * 1024)} MB limit.`
      );
    }
    if (result.content !== undefined && !Array.isArray(result.content)) {
      throw new Error(`The MCP tool "${name}" returned content that is not an array.`);
    }
    const content = (result.content || []).filter((item) => isPlainObject(item)).slice(0, MAX_TOOLS);
    const normalized = { isError: result.isError === true, content };
    if (result.structuredContent !== undefined) normalized.structuredContent = result.structuredContent;
    return normalized;
  }

  async function callTool(name, args = {}) {
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
      throw new Error('MCP tool names must match ^[A-Za-z0-9_.-]{1,128}$.');
    }
    const toolArguments = args === undefined || args === null ? {} : args;
    if (!isPlainObject(toolArguments)) throw new Error(`The arguments for MCP tool "${name}" must be an object.`);
    if (closed) throw new Error('The MCP client is closed.');
    if (!approvalHandler) {
      throw new Error(`The MCP tool "${name}" was not run because no approval handler is configured.`);
    }
    await initialize();
    const approved = await approvalHandler({ name, arguments: toolArguments });
    if (approved !== true) throw new Error(`The MCP tool "${name}" was not approved, so it was not run.`);
    const result = await sendRequest('tools/call', { name, arguments: toolArguments });
    return normalizeToolResult(name, result);
  }

  function close() {
    if (closing) return closing;
    closed = true;
    rejectPending(new Error('The MCP client was closed before the request completed.'));
    if (!child) {
      closing = Promise.resolve();
      return closing;
    }
    const proc = child;
    let termTimer = null;
    let killTimer = null;
    let forceTimer = null;
    closing = new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        resolve();
      };
      proc.once('close', finish);
      if (childClosed || proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }
      try {
        proc.stdin.end();
      } catch {
        // The stream may already be destroyed by a crashing child.
      }
      termTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          finish();
          return;
        }
        try {
          proc.kill('SIGTERM');
        } catch {
          // The process already disappeared between the check and the signal.
        }
        killTimer = setTimeout(() => {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            finish();
            return;
          }
          try {
            proc.kill('SIGKILL');
          } catch {
            finish();
          }
          forceTimer = setTimeout(finish, 500);
        }, 2000);
      }, 2000);
    });
    return closing;
  }

  return { initialize, listTools, callTool, close };
}

module.exports = {
  createMcpClient,
  validateServerConfig,
  isSafeHttpUrl,
  TOOL_NAME_PATTERN,
  MAX_TOOLS,
  MAX_RESULT_BYTES
};
