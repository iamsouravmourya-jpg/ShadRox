const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { createServer: createNetServer } = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PACKAGE_MANAGERS = {
  npm: { command: 'npm', installArgs: ['install', '--no-audit', '--no-fund'] },
  pnpm: { command: 'pnpm', installArgs: ['install'] },
  yarn: { command: 'yarn', installArgs: ['install'] },
  bun: { command: 'bun', installArgs: ['install'] }
};

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/**
 * A lockfile only records what the project was installed with; it says nothing
 * about whether that manager exists on this machine. Preview used to trust the
 * lockfile and then die with `'bun.cmd' is not recognized`, so every candidate
 * is now checked against PATH and falls back to the next one.
 */
function isCommandAvailable(command) {
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return entries.some((directory) =>
    extensions.some((extension) => require('node:fs').existsSync(path.join(directory, command + extension)))
  );
}

/**
 * Resolve a runtime command to an absolute executable from PATH only, never
 * from the workspace or the process cwd. Windows' CreateProcess searches the
 * current directory first, so spawning bare "python" inside an opened folder
 * could run a workspace-planted python.exe before the real interpreter. PATH
 * entries that point inside the workspace are skipped for the same reason.
 * The one intentional exception is a Maven wrapper (mvnw), which is project
 * code by design and only resolves inside the selected project directory.
 */
function resolveExecutable(command, { root = null, cwd = null } = {}) {
  const fsSync = require('node:fs');
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    const resolvedDirectory = path.resolve(directory);
    if (root && isInsideDirectory(root, resolvedDirectory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(resolvedDirectory, command + extension);
      try {
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present in this PATH entry.
      }
    }
  }

  if (/^mvnw(?:\.cmd)?$/i.test(command) && cwd) {
    const names = process.platform === 'win32' ? ['mvnw.cmd', 'mvnw.bat'] : ['mvnw'];
    for (const name of names) {
      const candidate = path.join(cwd, name);
      if (root && !isInsideDirectory(root, candidate)) continue;
      try {
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {
        // No wrapper in the selected project.
      }
    }
  }

  return null;
}

function getPackageManager(manifest, root, isAvailable = isCommandAvailable) {
  const declared = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.split('@')[0]
    : '';
  if (PACKAGE_MANAGERS[declared] && isAvailable(declared)) return declared;
  if (require('node:fs').existsSync(path.join(root, 'pnpm-lock.yaml')) && isAvailable('pnpm')) return 'pnpm';
  if (require('node:fs').existsSync(path.join(root, 'yarn.lock')) && isAvailable('yarn')) return 'yarn';
  if ((require('node:fs').existsSync(path.join(root, 'bun.lockb')) ||
      require('node:fs').existsSync(path.join(root, 'bun.lock'))) && isAvailable('bun')) return 'bun';
  return 'npm';
}

function getPreviewScript(manifest) {
  const scripts = manifest && typeof manifest.scripts === 'object' && manifest.scripts;
  if (!scripts) return null;
  for (const name of ['dev', 'start', 'preview', 'serve']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) {
      return { name, command: scripts[name] };
    }
  }
  return null;
}

async function findMissingDependencies(manifest, root) {
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies
  });
  const missing = [];
  for (const dependency of dependencies) {
    const packagePath = path.join(root, 'node_modules', ...dependency.split('/'));
    if (!await fs.access(packagePath).then(() => true, () => false)) missing.push(dependency);
  }
  return missing;
}

async function findPreviewProjects(root) {
  const realRoot = await fs.realpath(root);
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', 'coverage', '.cache', '.turbo', '.vercel', 'vendor']);
  const queue = [{ directory: realRoot, depth: 0 }];
  const candidates = [];
  let visited = 0;
  while (queue.length > 0 && visited < 5000) {
    const current = queue.shift();
    let contents;
    try {
      contents = await fs.readFile(path.join(current.directory, 'package.json'), 'utf8');
      const manifest = JSON.parse(contents);
      const script = getPreviewScript(manifest);
      if (script) {
        candidates.push({
          root: current.directory,
          relativePath: path.relative(realRoot, current.directory).split(path.sep).join('/') || '.',
          manifest,
          manifestHash: createHash('sha256').update(contents).digest('hex'),
          script,
          packageManager: getPackageManager(manifest, current.directory)
        });
      }
    } catch {
      // A malformed manifest is not a runnable candidate; keep scanning subfolders.
    }
    if (current.depth >= 10) continue;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      visited += 1;
      const directory = path.join(current.directory, entry.name);
      queue.push({ directory, depth: current.depth + 1 });
    }
  }
  if (queue.length > 0) throw new Error('Project detection reached its directory scan limit. Open the intended project subfolder directly.');
  return candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function findStaticPreviewProjects(root) {
  const realRoot = await fs.realpath(root);
  const ignored = new Set(['.git', 'node_modules', 'coverage', '.cache', '.turbo', '.vercel', 'vendor']);
  const queue = [{ directory: realRoot, depth: 0 }];
  const candidates = [];
  let visited = 0;
  while (queue.length > 0 && visited < 5000) {
    const current = queue.shift();
    try {
      const entries = await fs.readdir(current.directory, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'index.html')) {
        candidates.push({
          root: current.directory,
          relativePath: path.relative(realRoot, current.directory).split(path.sep).join('/') || '.',
          kind: 'static'
        });
      }
      if (current.depth >= 10) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        visited += 1;
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    } catch {
      // Unreadable folders do not prevent scanning the rest of the workspace.
    }
  }
  if (queue.length > 0) throw new Error('Static project detection reached its directory scan limit. Open the intended project subfolder directly.');
  return candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function findPreviewProject(root) {
  const candidates = await findPreviewProjects(root);
  const rootProject = candidates.find((candidate) => candidate.relativePath === '.');
  if (rootProject) return rootProject;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error('More than one runnable package.json was found. Select a project folder to choose its preview root.');
  }
  throw new Error('No runnable package.json found. Add a "dev", "start", "preview", or "serve" script to run this project locally.');
}

function getRunArgs(manager, script, scriptCommand, portOverride) {
  const args = manager === 'yarn' ? ['run', script.name] : ['run', script.name];
  const command = scriptCommand.toLowerCase();
  const isNext = /\bnext\b/.test(command);
  const extra = [];
  if (/\b(vite|astro|nuxt|angular|webpack-dev-server|webpack|parcel)\b/.test(command)) {
    extra.push('--host', '127.0.0.1');
  } else if (isNext) {
    extra.push('--hostname', '127.0.0.1');
  }
  // Appended last so it wins over the port the script pins for itself.
  if (portOverride) extra.push(isNext ? '-p' : '--port', String(portOverride));
  if (extra.length > 0) args.push('--', ...extra);
  return args;
}

/** The port a dev script pins for itself, or null when it picks its own. */
function getScriptPort(scriptCommand) {
  const text = String(scriptCommand ?? '');
  const env = text.match(/\bPORT=(\d{2,5})\b/i);
  if (env) return Number(env[1]);
  const flag = text.match(/(?:^|\s)(?:-p|--port)[= ]?(\d{2,5})(?=\s|$)/);
  return flag ? Number(flag[1]) : null;
}

/** Ask the OS for a port nothing is holding, used when every common port is busy. */
function findFreePort() {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(null));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : null));
    });
  });
}

/**
 * True when 127.0.0.1:<port> cannot be bound. A bind check rather than an HTTP
 * probe: a listener that answers nothing still blocks the port.
 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', (error) => resolve(error?.code === 'EADDRINUSE' || error?.code === 'EACCES'));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

function parsePreviewUrl(text) {
  const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):\d+(?:\/[^\s]*)?/gi);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1]
    .replace('localhost', '127.0.0.1')
    .replace('0.0.0.0', '127.0.0.1')
    .replace('[::1]', '127.0.0.1')
    .replace('[::]', '127.0.0.1')
    .replace(/[),.;]+$/, '');
}

const COMMON_DEV_PORTS = [3000, 3001, 3002, 4173, 4174, 4200, 4321, 5000, 5173, 5174, 8000, 8001, 8080, 8081, 9000];

async function findAvailableDevPort(excludedPorts = new Set(), isBusy = isPortBusy) {
  for (const port of COMMON_DEV_PORTS) {
    if (excludedPorts.has(port) || await isBusy(port)) continue;
    return port;
  }
  return findFreePort();
}

async function findExistingNextDevServer(output, root) {
  const cleanOutput = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const legacyLockNotice = /another next dev server is already running/i.test(cleanOutput);
  const modernLockNotice = /you can access (?:the )?existing server at/i.test(cleanOutput);
  if (!legacyLockNotice && !modernLockNotice) return null;

  const directory = cleanOutput.match(/\bDir:\s*(.+?)(?:\s+-\s+Log:|\r?\n|$)/i)?.[1]?.trim();
  const url = parsePreviewUrl(cleanOutput);
  if (!url) return null;

  if (directory) {
    const [serverRoot, projectRoot] = await Promise.all([
      fs.realpath(directory).catch(() => null),
      fs.realpath(root).catch(() => null)
    ]);
    if (!serverRoot || !projectRoot) return null;

    const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '');
    const sameRoot = process.platform === 'win32'
      ? normalize(serverRoot).toLowerCase() === normalize(projectRoot).toLowerCase()
      : normalize(serverRoot) === normalize(projectRoot);
    return sameRoot ? url : null;
  }

  if (!modernLockNotice) return null;

  try {
    const lock = JSON.parse(await fs.readFile(path.join(root, '.next', 'dev', 'lock'), 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 ||
      !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 ||
      !isProcessAlive(lock.pid)) {
      return null;
    }

    const lockUrl = new URL(lock.appUrl);
    const reportedUrl = new URL(url);
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
    if (
      !['http:', 'https:'].includes(lockUrl.protocol) ||
      !loopbackHosts.has(lockUrl.hostname) ||
      Number(lockUrl.port) !== lock.port ||
      Number(reportedUrl.port) !== lock.port
    ) {
      return null;
    }
    return lockUrl.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Dev servers that ship their own hot module replacement. */
function hasHmrSupport(command) {
  return /\b(vite|next|nuxt|astro|angular|webpack-dev-server|webpack|parcel|remix|svelte-kit)\b/i.test(command);
}

function probeHttp(url, timeoutMs = 700) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve(false); return; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') { resolve(false); return; }
    if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) { resolve(false); return; }
    const transport = target.protocol === 'https:' ? https : http;
    const options = target.protocol === 'https:' ? { rejectUnauthorized: false } : undefined;
    const request = transport.get(target, options, (response) => {
      response.resume();
      // A development server may keep a response stream open (for example, an
      // event stream). Receiving headers is enough to establish readiness.
      resolve(response.statusCode < 500);
      response.once('error', () => resolve(false));
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

function isInsideDirectory(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Runtime adapter plans are data produced in the main process, but startPlan
 * still re-validates every field: an absolute command name, bounded string
 * args, a cwd inside the workspace, and a real port. Nothing from a renderer
 * ever reaches `spawn` unchecked.
 */
function normalizeRuntimePlan(plan, root) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('A runtime preview plan object is required.');
  }
  if (plan.kind !== undefined && plan.kind !== 'backend' && plan.kind !== 'frontend') {
    throw new Error('The runtime preview plan kind must be "frontend" or "backend".');
  }

  const command = typeof plan.command === 'string' ? plan.command.trim() : '';
  if (!command) throw new Error('The runtime preview plan needs a command to spawn.');
  if (command.length > 1024 || command.includes('\0') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) {
    throw new Error('The runtime preview plan command must be a plain executable name.');
  }

  const args = plan.args === undefined ? [] : plan.args;
  if (!Array.isArray(args) || args.length > 128) {
    throw new Error('Runtime preview args must be an array of at most 128 strings.');
  }
  const normalizedArgs = args.map((argument) => {
    if (typeof argument !== 'string' || argument.length > 8192 || argument.includes('\0')) {
      throw new Error('Runtime preview args must be strings without NUL bytes.');
    }
    return argument;
  });

  let cwd = plan.cwd;
  if (cwd === undefined || cwd === null || cwd === '') cwd = root;
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('The runtime preview plan needs a working directory.');
  }
  if (!path.isAbsolute(cwd)) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error('A relative runtime plan working directory needs an absolute workspace root.');
    }
    cwd = path.resolve(root, cwd);
  }
  if (typeof root === 'string' && path.isAbsolute(root) && !isInsideDirectory(root, cwd)) {
    throw new Error('The runtime preview plan working directory is outside the opened workspace.');
  }

  const port = plan.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The runtime preview plan needs a port between 1 and 65535.');
  }

  const healthPath = typeof plan.healthPath === 'string' ? plan.healthPath : '/';
  if (!healthPath.startsWith('/') || healthPath.length > 512 || /[\0\r\n]/.test(healthPath)) {
    throw new Error('The runtime preview plan healthPath must be a local path starting with "/".');
  }

  return { command, args: normalizedArgs, cwd, port, healthPath };
}

function createPreviewRuntime({
  spawnProcess = spawn,
  onOutput = () => {},
  onBackendOutput = () => {},
  readyTimeout = 60_000
} = {}) {
  const processes = new Map();
  // Backend plans run beside a frontend preview, so they get their own map and
  // their own output channel instead of colliding in `processes`.
  const backendProcesses = new Map();

  // Dev servers emit thousands of tiny stdout chunks. Forwarding each one over
  // IPC made the renderer and the main process spend their time on messages
  // instead of the preview. Streams are coalesced per workspace and flushed
  // every 100ms; state changes flush immediately so ordering is preserved.
  const pendingOutput = new Map();
  let outputTimer = null;

  function flushOutput() {
    if (outputTimer !== null) {
      clearTimeout(outputTimer);
      outputTimer = null;
    }
    for (const entry of pendingOutput.values()) entry.emit(entry.payload);
    pendingOutput.clear();
  }

  function queueOutput(key, emitFn, payload) {
    const existing = pendingOutput.get(key);
    if (existing) existing.payload.message += payload.message;
    else pendingOutput.set(key, { emit: emitFn, payload: { ...payload } });
    if (outputTimer !== null) return;
    outputTimer = setTimeout(flushOutput, 100);
    outputTimer.unref?.();
  }

  function emit(workspaceId, type, message) {
    const text = String(message);
    if (type === 'stdout' || type === 'stderr') {
      queueOutput(`${workspaceId}:out:${type}`, onOutput, { workspaceId, type, message: text });
      return;
    }
    flushOutput();
    onOutput({ workspaceId, type, message: text });
  }

  function emitBackend(workspaceId, type, message) {
    const text = String(message);
    if (type === 'stdout' || type === 'stderr') {
      queueOutput(`${workspaceId}:backend:${type}`, onBackendOutput, { workspaceId, type, message: text });
      return;
    }
    flushOutput();
    onBackendOutput({ workspaceId, type, message: text });
  }

  function spawnCommand(manager, args, root, env, { cmdShim = true } = {}) {
    const windows = process.platform === 'win32';
    const useShim = windows && cmdShim;
    const executable = useShim ? (process.env.ComSpec || 'cmd.exe') : manager;
    const shimName = /\.(cmd|bat)$/i.test(manager) ? manager : `${manager}.cmd`;
    const commandText = `${shimName} ${args.join(' ')}`;
    // cmd /s strips the first and last quote of a wrapped command, so an
    // absolute shim path with spaces needs the whole command wrapped once.
    const commandArgs = useShim
      ? ['/d', '/s', '/c', /[\s"]/.test(shimName) ? `"${commandText}"` : commandText]
      : args;
    const inheritedVariables = new Set([
      'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
      'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NO_PROXY', 'OS', 'PATH', 'PATHEXT',
      'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
    ]);
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        inheritedVariables.has(key.toUpperCase()) ||
        /^(HTTP|HTTPS)_PROXY$/i.test(key)
      )
    );
    return spawnProcess(executable, commandArgs, {
      cwd: root,
      env: { ...safeEnv, BROWSER: 'none', HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', ...env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  function waitForExit(child, workspaceId, stage) {
    return new Promise((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk);
        output += text;
        emit(workspaceId, stage, text);
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        output += text;
        emit(workspaceId, stage, text);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`${stage === 'install' ? 'Dependency installation' : 'Preview command'} exited with code ${code ?? 'unknown'}.`));
      });
    });
  }

  function assertManagerAvailable(manager) {
    if (isCommandAvailable(manager)) return;
    throw new Error(
      `${manager} was not found on PATH, so the preview cannot install or start dependencies. ` +
      'Install Node.js (it includes npm), then retry. You can also open the System terminal tab and install a package manager there.'
    );
  }

  async function installDependencies(manager, root, workspaceId) {
    assertManagerAvailable(manager);
    const child = spawnCommand(manager, PACKAGE_MANAGERS[manager].installArgs, root);
    processes.set(workspaceId, { child, url: null, rejectReady: null });
    try {
      await waitForExit(child, workspaceId, 'install');
    } finally {
      if (processes.get(workspaceId)?.child === child) processes.delete(workspaceId);
    }
  }

  async function startStatic(workspaceId, root) {
    // Only the frontend preview being replaced is stopped here; a backend
    // preview belongs to its own lifecycle and to preview:stop.
    await stopFrontend(workspaceId);
    const realRoot = await fs.realpath(root);
    const entry = path.join(realRoot, 'index.html');
    const entryStat = await fs.stat(entry).catch(() => null);
    if (!entryStat?.isFile()) throw new Error('Static local preview requires an index.html file at the project root.');
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        const decodedPath = decodeURIComponent(requestUrl.pathname);
        const relativePath = decodedPath.replace(/^\/+/, '');
        if (relativePath.split('/').some((segment) => segment.startsWith('.'))) {
          response.writeHead(403).end('Forbidden');
          return;
        }
        let target = path.resolve(realRoot, relativePath);
        if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
          response.writeHead(403).end('Forbidden');
          return;
        }

        let stat;
        try {
          stat = await fs.stat(target);
          if (stat.isDirectory()) target = path.join(target, 'index.html');
          stat = await fs.stat(target);
        } catch {
          if (requestUrl.pathname !== '/') target = path.join(realRoot, 'index.html');
          stat = await fs.stat(target);
        }
        const realTarget = await fs.realpath(target);
        if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
          response.writeHead(403).end('Forbidden');
          return;
        }
        if (!stat.isFile()) {
          response.writeHead(404).end('Not found');
          return;
        }
        const body = request.method === 'HEAD' ? null : await fs.readFile(realTarget);
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(realTarget).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:; style-src 'self' 'unsafe-inline' http: https:; img-src 'self' data: blob: http: https:; font-src 'self' data: http: https:; connect-src 'self' http: https: ws: wss:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'"
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('Not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise((resolve) => server.close(resolve));
      throw new Error('Static preview server failed to bind a local port.');
    }
    const url = `http://127.0.0.1:${address.port}/`;
    processes.set(workspaceId, { server, url });
    emit(workspaceId, 'ready', `Static project served at ${url}`);
    return { url, script: 'static' };
  }

  function stopFrontend(workspaceId) {
    const record = processes.get(workspaceId);
    if (!record) return Promise.resolve(false);
    if (record.rejectReady) {
      const rejectReady = record.rejectReady;
      record.rejectReady = null;
      rejectReady(new Error('Preview stopped before the local server became ready.'));
    }
    processes.delete(workspaceId);
    if (record.server) {
      return new Promise((resolve, reject) => {
        record.server.close((error) => {
          if (error) reject(error);
          else {
            emit(workspaceId, 'stopped', 'Local preview stopped.');
            resolve(true);
          }
        });
      });
    }
    if (process.platform === 'win32' && Number.isInteger(record.child.pid)) {
      return new Promise((resolve) => {
        const killer = spawnProcess('taskkill.exe', ['/pid', String(record.child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          emit(workspaceId, 'stopped', 'Local preview stopped.');
          resolve(true);
        };
        killer.once('error', () => {
          record.child.kill();
          finish();
        });
        killer.once('close', (code) => {
          if (code !== 0) record.child.kill();
          finish();
        });
      });
    } else {
      record.child.kill();
    }
    emit(workspaceId, 'stopped', 'Local preview stopped.');
    return Promise.resolve(true);
  }

  async function start(workspaceId, root, approvedManifestHash, retryCount = 0) {
    if (typeof workspaceId !== 'string' || !workspaceId || typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error('A valid folder workspace is required to start local preview.');
    }
    await stopFrontend(workspaceId);

    const project = await findPreviewProject(root);
    if (approvedManifestHash && project.manifestHash !== approvedManifestHash) {
      throw new Error('The project package.json changed after approval. Review it and start the preview again.');
    }
    root = project.root;
    const manifest = project.manifest;
    const script = getPreviewScript(manifest);

    const manager = getPackageManager(manifest, root);
    assertManagerAvailable(manager);
    const missingDependencies = await findMissingDependencies(manifest, root);
    if (missingDependencies.length > 0) {
      emit(workspaceId, 'status', `Installing ${missingDependencies.length} missing project dependencies...`);
      await installDependencies(manager, root, workspaceId);
      emit(workspaceId, 'status', 'Dependencies installed. Starting local project...');
    }

    // A 180 ms budget used to miss an unrelated server already listening on a
    // common dev port under machine load. Preview would then adopt that server
    // as the project. The normal probe budget is cheap here: these run in
    // parallel and only slow the start by the one port that actually answers.
    const baselinePorts = new Set((await Promise.all(COMMON_DEV_PORTS.map(async (port) =>
      await probeHttp(`http://127.0.0.1:${port}/`, 700) ? port : null
    ))).filter(Number.isInteger));

    // A script that pins its own port (`next dev -p 3000`) dies outright when
    // an unrelated server already holds it, which left the preview showing
    // nothing but EADDRINUSE. Move it to a free port instead of giving up.
    const pinnedPort = getScriptPort(script.command);
    let portOverride = null;
    const pinnedPortIsBusy = pinnedPort &&
      (baselinePorts.has(pinnedPort) || await isPortBusy(pinnedPort));
    if (pinnedPortIsBusy) {
      baselinePorts.add(pinnedPort);
      portOverride = await findAvailableDevPort(new Set([...baselinePorts, pinnedPort]));
      if (portOverride) {
        emit(workspaceId, 'status',
          `Port ${pinnedPort} is already used by another local server. Starting on ${portOverride} instead.`);
      }
    }

    const child = spawnCommand(
      manager,
      getRunArgs(manager, script, script.command, portOverride),
      root,
      portOverride ? { PORT: String(portOverride) } : undefined
    );
    const record = { child, url: null, rejectReady: null };
    processes.set(workspaceId, record);
    emit(workspaceId, 'status', `Running "${manager} run ${script.name}"...`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let readinessTimer = null;
      let duplicateNextServerDetected = false;
      const hintedUrls = new Set();
      const probingUrls = new Set();
      let checking = false;
      const checkUrl = async (url) => {
        if (settled || probingUrls.has(url)) return;
        probingUrls.add(url);
        try {
          const port = Number(new URL(url).port);
          const exitCode = record.child.exitCode;
          if (baselinePorts.has(port) || (exitCode !== null && exitCode !== undefined)) return;
          if (await probeHttp(url)) {
            if (settled || duplicateNextServerDetected || readinessTimer !== null) return;
            readinessTimer = setTimeout(() => {
              readinessTimer = null;
              if (settled || duplicateNextServerDetected || record.child.exitCode != null) return;
              settled = true;
              clearTimeout(timeout);
              clearInterval(probeTimer);
              record.url = url;
              record.rejectReady = null;
              emit(workspaceId, 'ready', `Local preview is responding at ${url}`);
              resolve({ url, script: script.name, hmr: hasHmrSupport(script.command) });
            }, 350);
          }
        } finally {
          probingUrls.delete(url);
        }
      };
      const probeTimer = setInterval(async () => {
        if (settled || checking || duplicateNextServerDetected) return;
        checking = true;
        try {
          const urls = [...hintedUrls];
          for (const port of COMMON_DEV_PORTS) {
            if (!baselinePorts.has(port)) urls.push(`http://127.0.0.1:${port}/`);
          }
          await Promise.all([...new Set(urls)].map(checkUrl));
        } finally {
          checking = false;
        }
      }, 450);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(readinessTimer);
        clearInterval(probeTimer);
        record.rejectReady = null;
        void stop(workspaceId);
        const hints = [...hintedUrls];
        const hintDetail = hints.length ? ` Detected URL: ${hints.join(', ')}.` : ' No local URL was detected in server output.';
        reject(new Error(`Project server did not become HTTP-ready on a detected localhost address within ${Math.round(readyTimeout / 1000)} seconds.${hintDetail} Check the Console for startup errors or choose a supported run script.`));
      }, readyTimeout);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(readinessTimer);
        clearInterval(probeTimer);
        processes.delete(workspaceId);
        reject(error);
      };
      record.rejectReady = fail;

      const onData = (stream, chunk) => {
        const text = String(chunk);
        buffer = (buffer + text).slice(-16_384);
        emit(workspaceId, stream, text);
        const url = parsePreviewUrl(buffer);
        const reportsExistingNextServer = /another next dev server is already running/i.test(buffer);
        if (reportsExistingNextServer) {
          duplicateNextServerDetected = true;
          clearTimeout(readinessTimer);
          readinessTimer = null;
        }
        if (url && !settled && !reportsExistingNextServer) {
          hintedUrls.add(url);
          void checkUrl(url);
        }
        if (reportsExistingNextServer && url) hintedUrls.add(url);
      };

      child.stdout?.on('data', (chunk) => onData('stdout', chunk));
      child.stderr?.on('data', (chunk) => onData('stderr', chunk));
      child.once('error', fail);
      child.once('close', async (code) => {
        if (processes.get(workspaceId) !== record) return;
        clearTimeout(readinessTimer);
        const existingNextUrl = await findExistingNextDevServer(buffer, root);
        if (existingNextUrl && await probeHttp(existingNextUrl)) {
          const wasSettled = settled;
          settled = true;
          clearTimeout(timeout);
          clearInterval(probeTimer);
          record.url = existingNextUrl;
          record.rejectReady = null;
          processes.delete(workspaceId);
          emit(workspaceId, 'ready', `Reusing the existing project server at ${existingNextUrl}`);
          if (!wasSettled) resolve({ url: existingNextUrl, script: script.name, hmr: true });
          return;
        }
        // The server's own lines say why it died (EADDRINUSE, a syntax error,
        // a missing script); the exit code alone tells the user nothing.
        const lines = buffer
          .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/,?\s*(?:or\s+)?run\s+taskkill(?:\.exe)?\s+\/pid\s+\d+\s+\/f[^\r\n]*/gi, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const isReason = (line) =>
          /EADDR|ENOENT|EPERM|error|failed|cannot |Cannot |unknown option|not found|Missing/i.test(line);
        const reason = lines.filter(isReason).slice(-1)[0];
        const tail = (reason ? [reason] : lines.slice(-2))
          .join(' ')
          .slice(0, 400);
        const message = `Project process exited with code ${code ?? 'unknown'}.${tail ? ` ${tail}` : ''}`;
        emit(workspaceId, 'error', message);
        if (!settled) fail(new Error(message));
        processes.delete(workspaceId);
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (
        retryCount >= 2 ||
        !/(?:EADDRINUSE|address already in use|port \d+ is already in use)/i.test(message)
      ) {
        throw error;
      }
      emit(workspaceId, 'status', `A port conflict stopped the preview; retrying on another available port (${retryCount + 1}/2).`);
      return start(workspaceId, root, approvedManifestHash, retryCount + 1);
    });
  }

  /**
   * Start a data-only runtime adapter plan (for example a Python, Go, or PHP
   * backend) through the same hardened spawn path as the frontend preview.
   * Readiness probes the plan's own port and health path first and still falls
   * back to the common dev ports a framework may choose instead.
   */
  async function startPlan(workspaceId, plan, options = {}) {
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Error('A workspace id is required to start a runtime plan.');
    }
    const root = typeof options.root === 'string' && path.isAbsolute(options.root) ? options.root : null;
    const normalized = normalizeRuntimePlan(plan, root);
    await stopBackend(workspaceId);

    const commonPorts = [...new Set([normalized.port, ...COMMON_DEV_PORTS])];
    const baselinePorts = new Set((await Promise.all(commonPorts.map(async (port) =>
      await probeHttp(`http://127.0.0.1:${port}/`, 700) ? port : null
    ))).filter(Number.isInteger));
    if (baselinePorts.has(normalized.port)) {
      throw new Error(`Port ${normalized.port} is already serving another local process. Stop it or choose a different backend port.`);
    }

    const executable = resolveExecutable(normalized.command, { root, cwd: normalized.cwd });
    if (!executable) {
      throw new Error(
        `"${normalized.command}" was not found on PATH outside this workspace, so the backend preview cannot ` +
        'start it. Install the runtime or remove it from PATH entries inside the opened folder.'
      );
    }
    const windowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    const child = spawnCommand(executable, normalized.args, normalized.cwd, undefined, {
      cmdShim: windowsShim
    });
    const record = { child, url: null, rejectReady: null, kind: 'backend' };
    backendProcesses.set(workspaceId, record);
    emitBackend(workspaceId, 'status', `Running "${normalized.command} ${normalized.args.join(' ')}" in ${normalized.cwd}...`);

    const healthUrl = `http://127.0.0.1:${normalized.port}${normalized.healthPath}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const hintedUrls = new Set();
      const probingUrls = new Set();
      let checking = false;

      const checkUrl = async (url) => {
        if (settled || probingUrls.has(url)) return;
        probingUrls.add(url);
        try {
          let probedPort;
          try {
            probedPort = Number(new URL(url).port);
          } catch {
            return;
          }
          const exitCode = record.child.exitCode;
          if (baselinePorts.has(probedPort) || (exitCode !== null && exitCode !== undefined)) return;
          if (await probeHttp(url)) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(probeTimer);
            record.url = url;
            record.rejectReady = null;
            emitBackend(workspaceId, 'ready', `Backend preview is responding at ${url}`);
            resolve({ url, plan: { ...normalized, adapter: typeof plan.adapter === 'string' ? plan.adapter : 'runtime' } });
          }
        } finally {
          probingUrls.delete(url);
        }
      };

      const probeTimer = setInterval(async () => {
        if (settled || checking) return;
        checking = true;
        try {
          const urls = new Set(hintedUrls);
          urls.add(healthUrl);
          for (const port of COMMON_DEV_PORTS) {
            if (!baselinePorts.has(port)) urls.add(`http://127.0.0.1:${port}/`);
          }
          await Promise.all([...urls].map(checkUrl));
        } finally {
          checking = false;
        }
      }, 450);

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(probeTimer);
        record.rejectReady = null;
        void stopBackend(workspaceId);
        const hints = [...hintedUrls];
        reject(new Error(
          `Backend server did not become HTTP-ready at ${healthUrl} or a detected local URL within ` +
          `${Math.round(readyTimeout / 1000)} seconds.${hints.length ? ` Detected URL: ${hints.join(', ')}.` : ''} ` +
          'Check the backend output for startup errors.'
        ));
      }, readyTimeout);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(probeTimer);
        backendProcesses.delete(workspaceId);
        reject(error);
      };
      record.rejectReady = fail;

      const onData = (stream, chunk) => {
        const text = String(chunk);
        buffer = (buffer + text).slice(-16_384);
        emitBackend(workspaceId, stream, text);
        const url = parsePreviewUrl(buffer);
        if (url && !settled) {
          hintedUrls.add(url);
          void checkUrl(url);
        }
      };

      child.stdout?.on('data', (chunk) => onData('stdout', chunk));
      child.stderr?.on('data', (chunk) => onData('stderr', chunk));
      child.once('error', fail);
      child.once('close', (code) => {
        if (backendProcesses.get(workspaceId) !== record) return;
        const message = `Backend process exited with code ${code ?? 'unknown'}.`;
        emitBackend(workspaceId, 'error', message);
        if (!settled) fail(new Error(message));
        backendProcesses.delete(workspaceId);
      });
    });
  }

  function stopBackend(workspaceId) {
    const record = backendProcesses.get(workspaceId);
    if (!record) return Promise.resolve(false);
    if (record.rejectReady) {
      const rejectReady = record.rejectReady;
      record.rejectReady = null;
      rejectReady(new Error('Backend preview stopped before the local server became ready.'));
    }
    backendProcesses.delete(workspaceId);
    if (process.platform === 'win32' && Number.isInteger(record.child.pid)) {
      return new Promise((resolve) => {
        const killer = spawnProcess('taskkill.exe', ['/pid', String(record.child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          emitBackend(workspaceId, 'stopped', 'Backend preview stopped.');
          resolve(true);
        };
        killer.once('error', () => {
          record.child.kill();
          finish();
        });
        killer.once('close', (code) => {
          if (code !== 0) record.child.kill();
          finish();
        });
      });
    }
    record.child.kill();
    emitBackend(workspaceId, 'stopped', 'Backend preview stopped.');
    return Promise.resolve(true);
  }

  /** Stop the whole preview for a workspace: frontend/static and backend. */
  async function stop(workspaceId) {
    const frontendStopped = await stopFrontend(workspaceId);
    const backendStopped = await stopBackend(workspaceId);
    return frontendStopped || backendStopped;
  }

  function stopAll() {
    const workspaceIds = new Set([...processes.keys(), ...backendProcesses.keys()]);
    return Promise.all([...workspaceIds].map((workspaceId) => stop(workspaceId)));
  }

  function getWorkspaceIdForUrl(value) {
    let target;
    try {
      target = new URL(value);
    } catch {
      return null;
    }
    for (const records of [processes, backendProcesses]) {
      for (const [workspaceId, record] of records) {
        if (!record.url) continue;
        try {
          if (new URL(record.url).origin === target.origin) return workspaceId;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  return { start, startStatic, startPlan, stop, stopBackend, stopAll, getWorkspaceIdForUrl };
}

module.exports = {
  createPreviewRuntime,
  MIME_TYPES,
  findMissingDependencies,
  findPreviewProjects,
  findPreviewProject,
  findStaticPreviewProjects,
  getPackageManager,
  getPreviewScript,
  getRunArgs,
  getScriptPort,
  findAvailableDevPort,
  findExistingNextDevServer,
  findFreePort,
  isPortBusy,
  hasHmrSupport,
  parsePreviewUrl,
  resolveExecutable
};
