const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  createPreviewRuntime,
  findPreviewProject,
  findStaticPreviewProjects,
  getPackageManager,
  getPreviewScript,
  getRunArgs,
  getScriptPort,
  getFrameworkDefaultPort,
  getPortOverrideStrategy,
  findAvailableDevPort,
  findNextFreeDevPort,
  findExistingNextDevServer,
  removeStaleNextDevLock,
  reapOrphanedPreviews,
  recordOrphanChild,
  isPortBusy,
  hasHmrSupport,
  parsePreviewUrl,
  resolveExecutable
} = require('./preview-runtime.cjs');

/** True when 127.0.0.1:<port> can be bound right now. */
async function tryBindPort(port) {
  const server = net.createServer();
  const bound = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (bound) await new Promise((resolve) => server.close(resolve));
  return bound;
}

/**
 * A run of `length` currently-free consecutive ports. The relocation tests
 * need the squatter's port and the expected next port to both be predictable,
 * which an ephemeral listen(0) alone does not guarantee.
 */
async function findFreePortRun(length) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const start = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    let allFree = true;
    for (let offset = 0; offset < length; offset++) {
      if (!await tryBindPort(start + offset)) {
        allFree = false;
        break;
      }
    }
    if (allFree) return start;
  }
  throw new Error('No free port run was available for the preview tests.');
}

/**
 * A fake package-manager spawner that stands in for a real dev server: each
 * `run dev` bind-opens the port the invocation ends with (`--port N`/`-p N`)
 * or the script's pinned default, prints its Local URL, and serves it. A
 * `taskkill.exe` call closes that session's server completely before the
 * killer exits, exactly as the Windows stop path expects.
 */
function createFakeDevSpawner(pinnedPort) {
  const calls = [];
  const sessions = new Map();
  let nextPid = 5000;
  const spawnProcess = (command, args, options) => {
    const invocation = [command, ...args].join(' ').replace(/"/g, ' ');
    calls.push({ command, args, options, invocation });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    if (command === 'taskkill.exe') {
      const pid = Number(args[args.indexOf('/pid') + 1]);
      const session = sessions.get(pid);
      if (session) {
        sessions.delete(pid);
        session.server.closeAllConnections?.();
        session.server.close(() => {
          session.child.exitCode = 1;
          session.child.emit('close', 1);
          setImmediate(() => child.emit('close', 0));
        });
      } else {
        setImmediate(() => child.emit('close', 0));
      }
      return child;
    }
    child.pid = nextPid++;
    const portMatch = [...invocation.matchAll(/(?:^|\s)(?:--port|-p)[= ](\d{2,5})(?=\s|$)/g)].at(-1);
    const bindPort = portMatch ? Number(portMatch[1]) : pinnedPort;
    const server = http.createServer((_request, response) => response.end('served by fake dev server'));
    sessions.set(child.pid, { server, child });
    server.listen(bindPort, '127.0.0.1', () => {
      child.stdout.write(`Local: http://127.0.0.1:${bindPort}/\n`);
    });
    child.kill = () => {
      server.closeAllConnections?.();
      server.close();
      return true;
    };
    return child;
  };
  return { spawnProcess, calls };
}

async function writeProject(directory, scriptCommand) {
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { dev: scriptCommand } }));
  return directory;
}

test('selects package manager and local preview script deterministically', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-manager-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const available = () => true;
  assert.equal(getPackageManager({ packageManager: 'pnpm@9.12.0' }, root, available), 'pnpm');
  await fs.writeFile(path.join(root, 'yarn.lock'), '');
  assert.equal(getPackageManager({}, root, available), 'yarn');

  // A lockfile for a manager that is not installed must fall back, not spawn it.
  await fs.writeFile(path.join(root, 'bun.lock'), '');
  assert.equal(getPackageManager({ packageManager: 'bun@1.1.0' }, root, (name) => name !== 'bun'), 'yarn');
  assert.equal(getPackageManager({ packageManager: 'bun@1.1.0' }, root, () => false), 'npm');
  assert.deepEqual(getPreviewScript({ scripts: { start: 'vite preview', dev: 'vite' } }), {
    name: 'dev',
    command: 'vite'
  });
  assert.deepEqual(getPreviewScript({ scripts: { start: 'node server.js' } }), {
    name: 'start',
    command: 'node server.js'
  });
  assert.equal(getPreviewScript({ scripts: { test: 'node test.js' } }), null);
});

test('resolves runtime commands from PATH and never from the workspace', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-root-'));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-bin-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-outside-'));
  const originalPath = process.env.PATH;
  context.after(async () => {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(bin, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const ext = process.platform === 'win32' ? '.exe' : '';
  const fakePython = path.join(bin, `python${ext}`);
  const plantedPython = path.join(root, `python${ext}`);
  await fs.writeFile(fakePython, '');
  await fs.writeFile(plantedPython, '');
  process.env.PATH = [root, bin].join(path.delimiter);

  assert.equal(resolveExecutable('python', { root, cwd: root })?.toLowerCase(), fakePython.toLowerCase());
  assert.equal(resolveExecutable('missing-runtime', { root, cwd: root }), null);

  // A Maven wrapper is project code, but only the one inside the chosen cwd.
  const wrapper = path.join(root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  await fs.writeFile(wrapper, '');
  assert.equal(resolveExecutable('mvnw', { root, cwd: root })?.toLowerCase(), wrapper.toLowerCase());
  assert.equal(resolveExecutable('mvnw', { root, cwd: outside }), null);
});

test('binds recognized web dev servers to localhost and extracts local preview URLs', () => {  assert.deepEqual(
    getRunArgs('npm', { name: 'dev' }, 'vite --port 5173'),
    ['run', 'dev', '--', '--host', '127.0.0.1']
  );
  assert.deepEqual(
    getRunArgs('npm', { name: 'dev' }, 'next dev'),
    ['run', 'dev']
  );
  assert.equal(parsePreviewUrl('Local: http://localhost:5173/'), 'http://localhost:5173/');
  assert.equal(parsePreviewUrl('http://0.0.0.0:8080/'), 'http://127.0.0.1:8080/');
  assert.equal(parsePreviewUrl('https://example.com:443/'), null);
  assert.equal(hasHmrSupport('vite --port 5173'), true);
  assert.equal(hasHmrSupport('next dev'), true);
  assert.equal(hasHmrSupport('node server.js'), false);
});

test('relocates a dev server whose pinned port is already taken', async () => {
  assert.equal(getScriptPort('next dev -p 3000 -H 0.0.0.0'), 3000);
  assert.equal(getScriptPort('vite --port 5173'), 5173);
  assert.equal(getScriptPort('PORT=4000 node server.js'), 4000);
  assert.equal(getScriptPort('next dev'), null);

  // The override is appended after the script's own flags so it wins.
  // Next gets no forced hostname: it binds localhost itself and serves HMR
  // from the same origin the preview pane loads.
  assert.deepEqual(
    getRunArgs('npm', { name: 'dev' }, 'next dev -p 3000', 3001),
    ['run', 'dev', '--', '-p', '3001']
  );
  assert.deepEqual(
    getRunArgs('npm', { name: 'dev' }, 'vite', 5174),
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5174']
  );

  const net = require('node:net');
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const takenPort = squatter.address().port;
  assert.equal(await isPortBusy(takenPort), true);
  await new Promise((resolve) => squatter.close(resolve));
});

test('skips occupied fallback ports when relocating a pinned dev server', async (context) => {
  assert.equal(
    await findAvailableDevPort(new Set([3000]), async (port) => port === 3001),
    3002
  );

  assert.equal(getFrameworkDefaultPort('vite'), 5173);
  assert.equal(getFrameworkDefaultPort('next dev'), 3000);
  assert.equal(getFrameworkDefaultPort('node server.js'), null);

  assert.equal(getPortOverrideStrategy('vite --port 5173'), 'flag');
  assert.equal(getPortOverrideStrategy('next dev -p 3000'), 'flag');
  assert.equal(getPortOverrideStrategy('node server.js'), 'env');
  assert.equal(getPortOverrideStrategy('nodemon server.js'), 'env');
  // An inline PORT= assignment re-sets the port after any child environment,
  // so nothing ShadRox passes can move it.
  assert.equal(getPortOverrideStrategy('PORT=4000 node server.js'), null);
  assert.equal(getPortOverrideStrategy('some-unknown-runner'), null);

  // Port flags are only appended for CLIs that actually parse them.
  assert.deepEqual(getRunArgs('npm', { name: 'dev' }, 'node server.js', 4000), ['run', 'dev']);

  // Vite's rule: walk upward from the occupied port one by one.
  const busy = new Set([3000, 3001]);
  assert.equal(await findNextFreeDevPort(3000, { isBusy: async (port) => busy.has(port) }), 3002);
  assert.equal(
    await findNextFreeDevPort(3000, {
      excludedPorts: new Set([3002]),
      isBusy: async (port) => port <= 3002
    }),
    3003
  );
});

test('starts on the pinned port when it is free and appends no override', async (context) => {
  const base = await findFreePortRun(1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-port-free-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProject(root, `vite --port ${base}`);
  const { spawnProcess, calls } = createFakeDevSpawner(base);
  const runtime = createPreviewRuntime({ spawnProcess, readyTimeout: 4000 });
  context.after(() => runtime.stopAll());

  const result = await runtime.start('port-free-workspace', root);
  assert.equal(result.port, base);
  assert.equal(result.url, `http://127.0.0.1:${base}/`);
  const devCall = calls.find(({ invocation }) => invocation.includes(' run dev '));
  assert.ok(!/--port|\s-p\s/.test(devCall.invocation), devCall.invocation);
  assert.equal(devCall.options.env.PORT, undefined);
  assert.equal(await (await fetch(result.url)).text(), 'served by fake dev server');
});

test('keeps the host the dev server printed so Next.js HMR stays same-origin', async (context) => {
  // The synthetic readiness scan only probes COMMON_DEV_PORTS, so the race
  // against the printed URL needs a port from that list, free on both stacks.
  const bindFree = (port, host) => new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  let base = null;
  for (const port of [3000, 3001, 3002, 4173, 4174, 4200, 4321, 5000, 5173, 5174, 8000, 8001, 8080, 8081, 9000]) {
    if (await bindFree(port, '127.0.0.1') && await bindFree(port, '::1')) { base = port; break; }
  }
  assert.ok(base, 'A free common dev port is required for the readiness race.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-hmr-origin-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProject(root, `next dev -p ${base}`);
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 5100;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const server = http.createServer((_request, response) => response.end('served by fake next server'));
  // Graceful close only: a server-side FIN burst would leave the port in
  // TIME_WAIT and poison the next test run's port selection on Windows.
  const closeServer = (done) => server.close(done);
  child.kill = () => {
    closeServer();
    return true;
  };
  const spawnProcess = (command, args) => {
    if (command === 'taskkill.exe') {
      closeServer(() => {
        child.exitCode = 1;
        child.emit('close', 1);
      });
      const killer = new EventEmitter();
      setImmediate(() => killer.emit('close', 0));
      return killer;
    }
    if (!/\brun dev\b/.test([command, ...args].join(' '))) {
      const probe = new EventEmitter();
      probe.exitCode = 0;
      setImmediate(() => probe.emit('close', 0));
      return probe;
    }
    // Both hosts answer (localhost falls back to IPv4), but the printed Local
    // URL lands after the port scan's first synthetic probe, so the scan wins
    // the readiness race unless the hinted host is preferred.
    server.listen(base, '127.0.0.1', () => {
      setTimeout(() => child.stdout.write(`Local: http://localhost:${base}/\n`), 500);
    });
    return child;
  };
  const runtime = createPreviewRuntime({ spawnProcess, readyTimeout: 6000 });
  context.after(() => runtime.stopAll());

  const result = await runtime.start('hmr-origin-workspace', root);
  assert.equal(result.url, `http://localhost:${base}/`);
  assert.equal(result.port, base);
  assert.equal(result.hmr, true);
});

test('relocates over a foreign process on the pinned port without killing it', async (context) => {
  const base = await findFreePortRun(2);
  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(base, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => squatter.close(resolve)));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-port-foreign-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProject(root, `vite --port ${base}`);
  const { spawnProcess, calls } = createFakeDevSpawner(base);
  const output = [];
  const runtime = createPreviewRuntime({ spawnProcess, onOutput: (entry) => output.push(entry), readyTimeout: 4000 });
  context.after(() => runtime.stopAll());

  const result = await runtime.start('foreign-port-workspace', root);
  assert.equal(result.port, base + 1);
  assert.equal(result.url, `http://127.0.0.1:${base + 1}/`);
  const devCall = calls.find(({ invocation }) => invocation.includes(' run dev '));
  assert.match(devCall.invocation, new RegExp(`--port ${base + 1}`));
  assert.equal(devCall.options.env.PORT, String(base + 1));
  assert.ok(output.some((entry) =>
    entry.type === 'status' &&
    entry.message.includes(`Port ${base} is already used by another local server. Starting on port ${base + 1} instead.`)
  ));
  assert.ok(await isPortBusy(base), 'The foreign listener must survive the preview start.');
});

test('reports a structured conflict when the pinned port is taken and cannot be overridden', async (context) => {
  const base = await findFreePortRun(1);
  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(base, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => squatter.close(resolve)));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-port-conflict-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProject(root, `PORT=${base} node server.js`);
  const output = [];
  const runtime = createPreviewRuntime({
    spawnProcess: () => assert.fail('A port that cannot be overridden must not start a doomed dev server.'),
    onOutput: (entry) => output.push(entry)
  });

  await assert.rejects(runtime.start('port-conflict-workspace', root), (error) => {
    assert.equal(error.code, 'PREVIEW_PORT_CONFLICT');
    assert.equal(error.port, base);
    assert.match(error.message, new RegExp(`Port ${base} is already in use by another local application`));
    assert.match(error.message, /Close the other application or change the project's port/);
    return true;
  });
  assert.ok(output.some((entry) => entry.type === 'error' && entry.message.includes(`Port ${base}`)));
});

test('restarts its own previous session and only relocates around other previews', async (context) => {
  const base = await findFreePortRun(2);
  const rootA = await writeProject(await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-session-a-')), `vite --port ${base}`);
  const rootB = await writeProject(await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-session-b-')), `vite --port ${base}`);
  context.after(async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });
  const { spawnProcess, calls } = createFakeDevSpawner(base);
  const output = [];
  const runtime = createPreviewRuntime({ spawnProcess, onOutput: (entry) => output.push(entry), readyTimeout: 4000 });
  context.after(() => runtime.stopAll());

  const first = await runtime.start('session-workspace-a', rootA);
  assert.equal(first.port, base);

  // Another workspace's live preview is foreign too: relocate, never kill it.
  const second = await runtime.start('session-workspace-b', rootB);
  assert.equal(second.port, base + 1);
  assert.ok(output.some((entry) =>
    entry.type === 'status' &&
    entry.message.includes('another ShadRox preview') &&
    entry.message.includes(`Starting on port ${base + 1}`)
  ));
  assert.equal((await fetch(first.url)).status, 200);

  // This workspace's own previous session is killed and restarted on its port.
  const third = await runtime.start('session-workspace-a', rootA);
  assert.equal(third.port, base);
  const devCalls = calls.filter(({ invocation }) => invocation.includes(' run dev '));
  assert.equal(devCalls.length, 3);
  assert.ok(!/--port/.test(devCalls[2].invocation), devCalls[2].invocation);
  assert.equal(await runtime.stop('session-workspace-a'), true);
  assert.equal((await fetch(second.url)).status, 200);
});

test('recognizes an already-running Next server only for the same project root', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-next-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => response.end('existing project'));
    context.after(() => new Promise((close) => server.close(close)));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const output =
    `Another next dev server is already running. - Local: http://127.0.0.1:${port} ` +
    `- PID: 1234 - Dir: ${root} - Log: .next\\dev\\logs\\next-development.log`;
  const otherRoot = path.join(root, 'another-project');

  assert.equal(await findExistingNextDevServer(output, root), `http://127.0.0.1:${port}`);
  assert.equal(await findExistingNextDevServer(output, otherRoot), null);
});

test('reuses a live Next server for the same project without stopping it', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-next-reuse-'));
  const server = http.createServer((_request, response) => response.end('existing project'));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: `next dev -p ${port}` } })
  );
  const lockDirectory = path.join(root, '.next', 'dev');
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(path.join(lockDirectory, 'lock'), JSON.stringify({
    pid: process.pid,
    port,
    hostname: '127.0.0.1',
    appUrl: `http://127.0.0.1:${port}`,
    startedAt: Date.now()
  }));
  let spawnCount = 0;
  const output = [];
  const runtime = createPreviewRuntime({
    readyTimeout: 2000,
    onOutput: (entry) => output.push(entry),
    spawnProcess: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.pid = 1234;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stderr.write(
          `You can access the existing server at http://127.0.0.1:${port}, ` +
          `or run taskkill /PID 1234 /F to stop it and start a new one.`
        );
        child.exitCode = 1;
        child.emit('close', 1);
      });
      return child;
    }
  });

  const result = await runtime.start('next-reuse-workspace', root);
  assert.equal(result.url, `http://127.0.0.1:${port}`);
  assert.equal(spawnCount, 1);
  assert.ok(output.some((entry) => entry.type === 'ready' && entry.message.includes('Reusing the existing project server')));
  assert.equal(await runtime.stop('next-reuse-workspace'), false);
  assert.equal(await (await fetch(result.url)).text(), 'existing project');
});

test('does not mistake a fallback-port response for a Next server that then exits on its lock', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-next-fallback-'));
  const existingServer = http.createServer((_request, response) => response.end('existing project'));
  let transientServer;
  context.after(async () => {
    await Promise.all([existingServer, transientServer].filter(Boolean).map(
      (server) => new Promise((resolve) => server.close(resolve))
    ));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    existingServer.once('error', reject);
    existingServer.listen(0, '127.0.0.1', resolve);
  });
  const port = existingServer.address().port;
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: `next dev -p ${port}` } })
  );
  const lockDirectory = path.join(root, '.next', 'dev');
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(path.join(lockDirectory, 'lock'), JSON.stringify({
    pid: process.pid,
    port,
    hostname: '127.0.0.1',
    appUrl: `http://127.0.0.1:${port}`,
    startedAt: Date.now()
  }));
  const output = [];
  const runtime = createPreviewRuntime({
    readyTimeout: 2000,
    onOutput: (entry) => output.push(entry),
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      child.pid = 1234;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const portArgs = [...args.join(' ').matchAll(/(?:^|\s)-p\s+(\d+)/g)];
      const fallbackPort = Number(portArgs.at(-1)?.[1]);
      transientServer = http.createServer((_request, response) => response.end('transient fallback'));
      transientServer.listen(fallbackPort, '127.0.0.1', () => {
        child.stdout.write(`Local: http://127.0.0.1:${fallbackPort}/\nReady in 2.2s\n`);
        setTimeout(() => {
          child.stderr.write(
            `Another next dev server is already running. - Local: http://127.0.0.1:${port} ` +
            `- PID: 1234 - Dir: ${root} - Log: .next\\dev\\logs\\next-development.log`
          );
          child.exitCode = 1;
          child.emit('close', 1);
        }, 75);
      });
      return child;
    }
  });

  const result = await runtime.start('next-fallback-workspace', root);
  assert.equal(result.url, `http://127.0.0.1:${port}`);
  assert.deepEqual(
    output.filter((entry) => entry.type === 'ready').map((entry) => entry.message),
    [`Reusing the existing project server at http://127.0.0.1:${port}`]
  );
  assert.equal(await (await fetch(result.url)).text(), 'existing project');
  assert.equal(await runtime.stop('next-fallback-workspace'), false);
});

test('finds a single runnable nested project and refuses ambiguous roots', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-root-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  await fs.writeFile(path.join(root, 'project', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const project = await findPreviewProject(root);
  assert.equal(project.root, await fs.realpath(path.join(root, 'project')));

  await fs.mkdir(path.join(root, 'other'), { recursive: true });
  await fs.writeFile(path.join(root, 'other', 'package.json'), JSON.stringify({ scripts: { start: 'next dev' } }));
  await assert.rejects(findPreviewProject(root), /More than one runnable package\.json/);
});

test('finds nested static projects and skips dependency folders', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-static-projects-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'apps', 'site'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  await fs.writeFile(path.join(root, 'apps', 'site', 'index.html'), '<h1>nested</h1>');
  await fs.writeFile(path.join(root, 'node_modules', 'fixture', 'index.html'), '<h1>dependency</h1>');

  const projects = await findStaticPreviewProjects(root);
  assert.deepEqual(projects.map(({ relativePath, kind }) => ({ relativePath, kind })), [
    { relativePath: 'apps/site', kind: 'static' }
  ]);
});

test('rejects a project manifest changed after the user approved it', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { scripts: { dev: 'node server.js' } };
  const filePath = path.join(root, 'package.json');
  await fs.writeFile(filePath, JSON.stringify(manifest));
  const approved = await findPreviewProject(root);
  await fs.writeFile(filePath, JSON.stringify({ scripts: { dev: 'node changed-script.js' } }));
  const runtime = createPreviewRuntime({ spawnProcess: () => assert.fail('Changed package.json must not start a process.') });
  await assert.rejects(
    runtime.start('approval-workspace', root, approved.manifestHash),
    /package\.json changed after approval/
  );
});

test('does not pass ShadRox process secrets into the approved project process', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-env-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const previousSecret = process.env.SHADROX_RUNTIME_TEST_TOKEN;
  process.env.SHADROX_RUNTIME_TEST_TOKEN = 'must-not-leak';
  let capturedEnvironment;
  let server;
  context.after(() => server && new Promise((resolve) => server.close(resolve)));
  const spawnProcess = (command, _args, options) => {
    const child = new EventEmitter();
    child.pid = 200;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      server?.close();
      return true;
    };
    if (command === 'taskkill.exe') {
      setImmediate(() => child.emit('close', 0));
      return child;
    }
    capturedEnvironment = options.env;
    server = http.createServer((_request, response) => response.end('ready'));
    server.listen(0, '127.0.0.1', () => {
      child.stdout.write(`Local: http://127.0.0.1:${server.address().port}/`);
    });
    return child;
  };
  try {
    const runtime = createPreviewRuntime({ spawnProcess, readyTimeout: 1000 });
    await runtime.start('env-workspace', root);
    assert.equal(capturedEnvironment.SHADROX_RUNTIME_TEST_TOKEN, undefined);
    await runtime.stop('env-workspace');
  } finally {
    if (previousSecret === undefined) delete process.env.SHADROX_RUNTIME_TEST_TOKEN;
    else process.env.SHADROX_RUNTIME_TEST_TOKEN = previousSecret;
  }
});

test('installs missing npm dependencies, starts the approved script, and stops the child process', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-start-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { vite: '^6.0.0' },
    scripts: { dev: 'vite --port 5173' }
  }));

  const calls = [];
  const children = [];
  const servers = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = children.length + 100;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      for (const server of servers) server.close();
      setImmediate(() => child.emit('close', 1));
      return true;
    };
    calls.push({ command, args, options });
    children.push(child);
    setImmediate(() => {
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation.includes(' /pid ')) {
        child.emit('close', 0);
        return;
      }
      if (invocation.includes(' install ')) {
        child.stdout.write('installed dependencies\n');
        child.emit('close', 0);
      } else {
        const server = http.createServer((_request, response) => response.end('ready'));
        servers.push(server);
        server.listen(0, '127.0.0.1', () => {
          child.stdout.write(`Local: http://127.0.0.1:${server.address().port}/\n`);
        });
      }
    });
    return child;
  };
  const output = [];
  context.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));
  const runtime = createPreviewRuntime({
    spawnProcess,
    onOutput: (entry) => output.push(entry),
    readyTimeout: 2000
  });

  const result = await runtime.start('workspace-1', root);
  assert.equal(result.script, 'dev');
  assert.equal(result.hmr, true);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await fetch(result.url)).status, 200);
  assert.equal(calls.length, 2);
  const invocations = calls.map(({ command, args }) => `${command} ${args.join(' ')}`).join('\n');
  assert.match(invocations, /npm(?:\.cmd)? install/);
  assert.match(invocations, /npm(?:\.cmd)? run dev -- --host 127\.0\.0\.1/);
  assert.ok(output.some((entry) => entry.type === 'ready'));
  assert.equal(await runtime.stop('workspace-1'), true);
  assert.equal(await runtime.stop('workspace-1'), false);
  assert.ok(output.some((entry) => entry.type === 'stopped'));
});

test('handles an HTTPS URL over a non-TLS local endpoint without hanging', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-https-probe-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  let server;
  context.after(() => server && new Promise((resolve) => server.close(resolve)));
  const spawnProcess = (command) => {
    const child = new EventEmitter();
    child.pid = 300;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    if (command === 'taskkill.exe') {
      setImmediate(() => child.emit('close', 0));
      return child;
    }
    server = http.createServer((_request, response) => response.end('plain HTTP'));
    server.listen(0, '127.0.0.1', () => {
      child.stdout.write(`Local: https://127.0.0.1:${server.address().port}/`);
    });
    return child;
  };
  const runtime = createPreviewRuntime({ spawnProcess, readyTimeout: 900 });
  context.after(() => runtime.stop('https-probe-workspace'));
  await assert.rejects(
    runtime.start('https-probe-workspace', root),
    /Detected URL: https:\/\/127\.0\.0\.1:\d+\//
  );
});

test('serves a local static workspace securely inside the desktop app', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-static-preview-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Local desktop preview</h1>');
  await fs.writeFile(path.join(root, 'assets', 'app.js'), 'console.log("local");');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=not-for-preview');

  const runtime = createPreviewRuntime();
  const { url } = await runtime.startStatic('static-workspace', root);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Local desktop preview/);

  const script = await fetch(new URL('assets/app.js', url));
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await script.text(), 'console.log("local");');
  assert.equal((await fetch(new URL('.env', url))).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal(await runtime.stop('static-workspace'), true);
  await assert.rejects(fetch(url));
});

test('requires an index.html before starting static local preview', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-static-no-entry-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createPreviewRuntime();
  await assert.rejects(
    runtime.startStatic('missing-static-entry', root),
    /requires an index\.html/
  );
});

test('runs a real local Node web project and serves it through the preview URL', async (context) => {
  const npm = spawnSync(
    process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd --version'] : ['--version'],
    {
    encoding: 'utf8',
    shell: false,
    windowsHide: true
    }
  );
  if (npm.error || npm.status !== 0) {
    context.skip('A local npm executable is unavailable in this environment.');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-live-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js' }
  }));
  await fs.writeFile(path.join(root, 'server.js'), [
    "const http = require('node:http');",
    "const server = http.createServer((_request, response) => response.end('local runtime works'));",
    "server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port + '/'));"
  ].join('\n'));

  const runtime = createPreviewRuntime({ readyTimeout: 10_000 });
  context.after(() => runtime.stop('live-workspace'));
  const { url, hmr } = await runtime.start('live-workspace', root);
  assert.equal(hmr, false);
  assert.equal(runtime.getWorkspaceIdForUrl(url), 'live-workspace');
  assert.equal(runtime.getWorkspaceIdForUrl('http://127.0.0.1:1/'), null);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'local runtime works');
  await runtime.stop('live-workspace');
  const stopDeadline = Date.now() + 5000;
  while (Date.now() < stopDeadline) {
    try {
      await fetch(url);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  assert.fail("Stopping the preview did not shut down the project's server.");
});

test('removes a stale Next.js dev lock whose recorded PID is dead', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-nextlock-'));
  const lockDir = path.join(root, '.next', 'dev');
  await fs.mkdir(lockDir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const lockPath = path.join(lockDir, 'lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: dead, port: 3000, appUrl: 'http://localhost:3000' }));

  assert.equal(await removeStaleNextDevLock(root, true), true);
  await assert.rejects(fs.access(lockPath));

  // A live PID keeps its lock; unrelated commands never touch the lock.
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await fs.writeFile(lockPath, JSON.stringify({ pid: live.pid, port: 3000, appUrl: 'http://localhost:3000' }));
  assert.equal(await removeStaleNextDevLock(root, true), false);
  assert.equal(await removeStaleNextDevLock(root, false), false);
  assert.equal(await fs.readFile(lockPath, 'utf8').then(() => true), true);
  try { live.kill(); } catch {}
});

test('reaps only orphaned preview servers recorded for the same project', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-orphan-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-orphan-other-'));
  const registry = path.join(root, 'orphans.json');
  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  recordOrphanChild(registry, stray.pid, root);
  recordOrphanChild(registry, stray.pid, other);
  try {
    // Attach before the kill: taskkill can finish first, and a once('exit')
    // listener added after an already-fired event never resolves.
    const exited = new Promise((resolve) => stray.once('exit', resolve));
    const killed = await reapOrphanedPreviews(registry, root);
    assert.equal(killed, 1);
    await exited;
    assert.equal(stray.exitCode !== null, true);
    const entries = JSON.parse(await fs.readFile(registry, 'utf8')).entries;
    assert.equal(entries.filter((entry) => entry.root === other).length, 1);
    assert.equal(entries.filter((entry) => entry.root === root).length, 0);
  } finally {
    try { stray.kill(); } catch {}
  }
});
