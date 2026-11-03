const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { createMcpClient, validateServerConfig, isSafeHttpUrl } = require('./mcp-client.cjs');

const CLIENT_VERSION = '9.9.9';
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

const FAKE_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized') initialized = true;
    return;
  }
  if (message.method === 'initialize') {
    const params = message.params || {};
    const info = params.clientInfo || {};
    if (params.protocolVersion !== '2025-06-18' || info.name !== 'ShadRox' || info.version !== '${CLIENT_VERSION}') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'invalid initialize params' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.2.3' }
    } });
    return;
  }
  if (message.method === 'tools/list') {
    if (!initialized) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'initialize notification missing' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: {} } },
      { name: 'explode', description: 'Always fails' }
    ] } });
    return;
  }
  if (message.method === 'tools/call') {
    if (message.params.name === 'explode') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Tool exploded on purpose' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'args:' + JSON.stringify(message.params.arguments) }]
    } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + message.method } });
});
`;

const NOISY_SERVER = `
process.stdout.write('booting fake MCP server\\n');
process.stdout.write('{"broken":\\n');
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { ignored: true } }) + '\\n');
${FAKE_SERVER}
`;

const TIMEOUT_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } });
  }
});
`;

const EXIT_SERVER = `
process.stdin.once('data', () => {
  process.stderr.write('fake server crashed\\n');
  process.exit(7);
});
`;

const HEAVY_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const tools = [{ name: 'bad name' }, { name: '' }, null, { name: 'tool_0' }];
for (let index = 1; index <= 240; index += 1) {
  tools.push({ name: 'tool_' + index, description: 'Generated tool', inputSchema: { type: 'object' } });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'heavy', version: '1.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  }
});
`;

function heartbeatServer(marker) {
  return `
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
setInterval(() => { try { fs.appendFileSync(marker, 'x'); } catch {} }, 50);
${FAKE_SERVER}
`;
}

function stdioOptions(script, overrides = {}) {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
    version: CLIENT_VERSION,
    ...overrides
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withClient(options, run) {
  const client = createMcpClient(options);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function startHttpServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        url: `${origin}/mcp`,
        requests: [],
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

async function readJsonBody(request) {
  return JSON.parse(await readBody(request));
}

test('validateServerConfig normalizes stdio defaults and HTTP headers', () => {
  const stdio = validateServerConfig({ transport: 'stdio', command: ' node ' });
  assert.deepEqual(stdio, {
    name: '',
    transport: 'stdio',
    timeoutMs: 15_000,
    command: 'node',
    args: [],
    env: {},
    cwd: undefined
  });
  const httpConfig = validateServerConfig({
    transport: 'http',
    url: 'https://example.com/mcp',
    name: 'Docs',
    headers: { 'x-api-key': 'abc' }
  });
  assert.equal(httpConfig.timeoutMs, 15_000);
  assert.equal(httpConfig.name, 'Docs');
  assert.deepEqual(httpConfig.headers, { 'x-api-key': 'abc' });
});

test('validateServerConfig rejects malformed stdio servers', () => {
  assert.throws(() => validateServerConfig(null), /configuration object/);
  assert.throws(() => validateServerConfig({ transport: 'sse', command: 'node' }), /transport/);
  assert.throws(() => validateServerConfig({ transport: 'stdio' }), /command/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', args: 'nope' }), /args/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', args: [1] }), /args/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', env: { 'BAD KEY': 'x' } }), /environment variable/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', env: { TOKEN: 5 } }), /must be a string/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => validateServerConfig({ transport: 'stdio', command: 'node', timeoutMs: 500_000 }), /timeoutMs/);
});

test('HTTP configuration rejects unsafe URLs and reserved headers', () => {
  assert.equal(isSafeHttpUrl('http://127.0.0.1:3000/mcp'), true);
  assert.equal(isSafeHttpUrl('https://example.com/mcp'), true);
  assert.equal(isSafeHttpUrl('http://user:secret@127.0.0.1:3000/mcp'), false);
  assert.equal(isSafeHttpUrl('ftp://127.0.0.1/mcp'), false);
  assert.equal(isSafeHttpUrl('file:///tmp/mcp.json'), false);
  assert.equal(isSafeHttpUrl(''), false);
  assert.throws(() => createMcpClient({ transport: 'http', url: 'http://user:secret@127.0.0.1:3000/mcp' }), /credentials/);
  assert.throws(
    () => validateServerConfig({ transport: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { 'Mcp-Session-Id': 'x' } }),
    /managed by ShadRox/
  );
  assert.throws(
    () => validateServerConfig({ transport: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { 'x-key': 'bad\r\nvalue' } }),
    /control characters/
  );
});

test('stdio initializes the session, sends notifications/initialized and lists tools', async () => {
  await withClient(stdioOptions(FAKE_SERVER), async (client) => {
    const handshake = await client.initialize();
    assert.equal(handshake.protocolVersion, '2025-06-18');
    assert.deepEqual(handshake.serverInfo, { name: 'fake-mcp', version: '1.2.3' });
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'explode']);
    assert.equal(tools[0].description, 'Echo the arguments');
    assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {} });
    assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: {} });
  });
});

test('stdio listTools caps at 200 tools and drops invalid or duplicate names', async () => {
  await withClient(stdioOptions(HEAVY_SERVER), async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.length, 200);
    assert.equal(tools[0].name, 'tool_0');
    assert.equal(tools[199].name, 'tool_199');
    assert.ok(tools.every((tool) => TOOL_NAME_PATTERN.test(tool.name)));
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 200);
  });
});

test('stdio callTool awaits the approval gate and returns normalized content', async () => {
  const approvals = [];
  const options = stdioOptions(FAKE_SERVER, {
    onApproveTool: async (request) => {
      await delay(40);
      approvals.push(request);
      return true;
    }
  });
  await withClient(options, async (client) => {
    const result = await client.callTool('echo', { message: 'hi' });
    assert.equal(result.isError, false);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].text, 'args:{"message":"hi"}');
  });
  assert.deepEqual(approvals, [{ name: 'echo', arguments: { message: 'hi' } }]);
});

test('callTool refuses to run without an explicit true approval', async () => {
  await withClient(stdioOptions(FAKE_SERVER, {
    onApproveTool: async () => {
      await delay(25);
      return false;
    }
  }), async (client) => {
    await assert.rejects(() => client.callTool('echo', {}), /not approved/);
  });
  await withClient(stdioOptions(FAKE_SERVER, { onApproveTool: () => undefined }), async (client) => {
    await assert.rejects(() => client.callTool('echo', {}), /not approved/);
  });
  await withClient(stdioOptions(FAKE_SERVER), async (client) => {
    await assert.rejects(() => client.callTool('echo', {}), /approval handler/);
  });
});

test('callTool validates tool names and arguments before asking for approval', async () => {
  let approvals = 0;
  await withClient(stdioOptions(FAKE_SERVER, {
    onApproveTool: () => {
      approvals += 1;
      return true;
    }
  }), async (client) => {
    await assert.rejects(() => client.callTool('bad name', {}), /tool names/);
    await assert.rejects(() => client.callTool(`t${'x'.repeat(128)}`, {}), /tool names/);
    await assert.rejects(() => client.callTool('echo', 'nope'), /must be an object/);
  });
  assert.equal(approvals, 0);
});

test('stdio JSON-RPC errors become Error objects with code and message', async () => {
  await withClient(stdioOptions(FAKE_SERVER, { onApproveTool: () => true }), async (client) => {
    const error = await client.callTool('explode', {}).then(() => null, (value) => value);
    assert.ok(error instanceof Error);
    assert.equal(error.code, -32001);
    assert.match(error.message, /Tool exploded on purpose/);
  });
});

test('stdio requests time out instead of hanging forever', async () => {
  const started = Date.now();
  const error = await withClient(stdioOptions(TIMEOUT_SERVER, { timeoutMs: 1500, onApproveTool: () => true }), async (client) => {
    await client.initialize();
    return client.callTool('slow', {}).then(() => null, (value) => value);
  });
  const elapsed = Date.now() - started;
  assert.ok(error instanceof Error, 'a timeout must reject');
  assert.match(error.message, /timed out after 1500 ms/);
  assert.ok(elapsed >= 1400, `timeout fired too early: ${elapsed} ms`);
  assert.ok(elapsed < 6000, `timeout fired too late: ${elapsed} ms`);
});

test('an unexpected server exit rejects pending requests with the exit code', async () => {
  const client = createMcpClient(stdioOptions(EXIT_SERVER, { timeoutMs: 5000 }));
  try {
    await assert.rejects(() => client.initialize(), /exited \(code 7\)/);
  } finally {
    await client.close();
  }
});

test('malformed stdout lines are ignored and do not stall requests', async () => {
  await withClient(stdioOptions(NOISY_SERVER), async (client) => {
    const handshake = await client.initialize();
    assert.equal(handshake.serverInfo.name, 'fake-mcp');
    const tools = await client.listTools();
    assert.equal(tools.length, 2);
  });
});

test('a missing stdio command fails with a clear start error', async () => {
  await withClient({ transport: 'stdio', command: 'shadrox-missing-mcp-server-xyz', timeoutMs: 2000 }, async (client) => {
    await assert.rejects(() => client.initialize(), /could not be started|ENOENT/i);
  });
});

test('close terminates a child that survives stdin closure and the client refuses later calls', async () => {
  const marker = path.join(os.tmpdir(), `shadrox-mcp-${randomUUID()}.log`);
  const client = createMcpClient(stdioOptions(heartbeatServer(marker)));
  try {
    await client.initialize();
    await delay(150);
    assert.ok(fs.existsSync(marker), 'the heartbeat child never started');
    const started = Date.now();
    await client.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1800, `close returned before SIGTERM was needed: ${elapsed} ms`);
    const sizeAtClose = fs.statSync(marker).size;
    await delay(300);
    assert.equal(fs.statSync(marker).size, sizeAtClose, 'the child kept running after close');
    await assert.rejects(() => client.listTools(), /closed/);
  } finally {
    await client.close();
    fs.rmSync(marker, { force: true });
  }
});

test('close is idempotent before the child ever starts', async () => {
  const client = createMcpClient(stdioOptions(FAKE_SERVER));
  await client.close();
  await client.close();
  await assert.rejects(() => client.listTools(), /closed/);
  await assert.rejects(() => client.callTool('echo', {}), /closed/);
});

test('streamable HTTP performs the handshake, reuses the session id and calls a tool', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    endpoint.requests.push({ path: request.url, headers: request.headers, body });
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-abc' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'http-fake', version: '2.0.0' }
        }
      }));
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (body.method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
      }));
      return;
    }
    if (body.method === 'tools/call') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: `called:${body.params.name}` }] }
      }));
      return;
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } }));
  });
  try {
    const client = createMcpClient({
      transport: 'http',
      url: endpoint.url,
      headers: { 'x-api-key': 'test-key' },
      onApproveTool: () => true
    });
    const handshake = await client.initialize();
    assert.equal(handshake.serverInfo.name, 'http-fake');
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo']);
    const result = await client.callTool('echo', { ping: 1 });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, 'called:echo');

    assert.equal(endpoint.requests.length, 4);
    assert.equal(endpoint.requests[0].body.params.protocolVersion, '2025-06-18');
    assert.equal(endpoint.requests[0].body.params.clientInfo.name, 'ShadRox');
    assert.equal(endpoint.requests[0].headers['mcp-session-id'], undefined);
    assert.equal(endpoint.requests[1].body.method, 'notifications/initialized');
    assert.equal(endpoint.requests[1].headers['mcp-session-id'], 'session-abc');
    assert.equal(endpoint.requests[1].headers['x-api-key'], 'test-key');
    assert.equal(endpoint.requests[2].body.method, 'tools/list');
    assert.equal(endpoint.requests[2].headers['mcp-session-id'], 'session-abc');
    assert.equal(endpoint.requests[2].headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(endpoint.requests[3].headers['mcp-session-id'], 'session-abc');
    await client.close();
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP accepts a server-sent events response', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sse-server', version: '3.0.0' } }
      }));
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`);
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url }, async (client) => {
      const handshake = await client.initialize();
      assert.equal(handshake.serverInfo.name, 'sse-server');
      assert.deepEqual(await client.listTools(), []);
    });
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP refuses redirects instead of following them', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    endpoint.requests.push({ path: request.url });
    response.writeHead(302, { location: '/elsewhere' });
    response.end();
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url }, async (client) => {
      await assert.rejects(() => client.initialize(), /redirects are not followed/);
    });
    assert.equal(endpoint.requests.length, 1);
    assert.equal(endpoint.requests[0].path, '/mcp');
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP sends no tools/call when approval is denied', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    endpoint.requests.push({ body });
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fake', version: '2.0.0' } }
      }));
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }));
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url, onApproveTool: () => false }, async (client) => {
      await assert.rejects(() => client.callTool('echo', {}), /not approved/);
    });
    assert.equal(endpoint.requests.filter((entry) => entry.body.method === 'tools/call').length, 0);
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP reports non-2xx status codes with the server message', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    await readBody(request);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'server is warming up' } }));
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url }, async (client) => {
      await assert.rejects(() => client.initialize(), /status 503.*warming up/);
    });
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP maps JSON-RPC errors to Error objects', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fake', version: '2.0.0' } }
      }));
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params here' } }));
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url, onApproveTool: () => true }, async (client) => {
      const error = await client.callTool('echo', {}).then(() => null, (value) => value);
      assert.ok(error instanceof Error);
      assert.equal(error.code, -32602);
      assert.match(error.message, /Invalid params here/);
    });
  } finally {
    await endpoint.close();
  }
});

test('streamable HTTP rejects tool results larger than 1 MB', async () => {
  const endpoint = await startHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    if (body.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fake', version: '2.0.0' } }
      }));
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: 'x'.repeat(1_100_000) }] }
    }));
  });
  try {
    await withClient({ transport: 'http', url: endpoint.url, timeoutMs: 5000, onApproveTool: () => true }, async (client) => {
      await assert.rejects(() => client.callTool('huge', {}), /1 MB limit/);
    });
  } finally {
    await endpoint.close();
  }
});
