const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
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

function getPackageManager(manifest, root) {
  const declared = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.split('@')[0]
    : '';
  if (PACKAGE_MANAGERS[declared]) return declared;
  if (require('node:fs').existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (require('node:fs').existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (require('node:fs').existsSync(path.join(root, 'bun.lockb')) ||
      require('node:fs').existsSync(path.join(root, 'bun.lock'))) return 'bun';
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

function getRunArgs(manager, script, scriptCommand) {
  const args = manager === 'yarn' ? ['run', script.name] : ['run', script.name];
  const command = scriptCommand.toLowerCase();
  if (/\b(vite|astro|nuxt|angular|webpack-dev-server|webpack|parcel)\b/.test(command)) {
    args.push('--', '--host', '127.0.0.1');
  } else if (/\bnext\b/.test(command)) {
    args.push('--', '--hostname', '127.0.0.1');
  }
  return args;
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

function createPreviewRuntime({
  spawnProcess = spawn,
  onOutput = () => {},
  readyTimeout = 60_000
} = {}) {
  const processes = new Map();

  function emit(workspaceId, type, message) {
    onOutput({ workspaceId, type, message: String(message) });
  }

  function spawnCommand(manager, args, root, env) {
    const windows = process.platform === 'win32';
    const executable = windows ? (process.env.ComSpec || 'cmd.exe') : manager;
    const commandArgs = windows
      ? ['/d', '/s', '/c', `${manager}.cmd ${args.join(' ')}`]
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

  async function installDependencies(manager, root, workspaceId) {
    const child = spawnCommand(manager, PACKAGE_MANAGERS[manager].installArgs, root);
    processes.set(workspaceId, { child, url: null, rejectReady: null });
    try {
      await waitForExit(child, workspaceId, 'install');
    } finally {
      if (processes.get(workspaceId)?.child === child) processes.delete(workspaceId);
    }
  }

  async function startStatic(workspaceId, root) {
    await stop(workspaceId);
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

  function stop(workspaceId) {
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

  async function start(workspaceId, root, approvedManifestHash) {
    if (typeof workspaceId !== 'string' || !workspaceId || typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error('A valid folder workspace is required to start local preview.');
    }
    await stop(workspaceId);

    const project = await findPreviewProject(root);
    if (approvedManifestHash && project.manifestHash !== approvedManifestHash) {
      throw new Error('The project package.json changed after approval. Review it and start the preview again.');
    }
    root = project.root;
    const manifest = project.manifest;
    const script = getPreviewScript(manifest);

    const manager = getPackageManager(manifest, root);
    const missingDependencies = await findMissingDependencies(manifest, root);
    if (missingDependencies.length > 0) {
      emit(workspaceId, 'status', `Installing ${missingDependencies.length} missing project dependencies...`);
      await installDependencies(manager, root, workspaceId);
      emit(workspaceId, 'status', 'Dependencies installed. Starting local project...');
    }

    const baselinePorts = new Set((await Promise.all(COMMON_DEV_PORTS.map(async (port) =>
      await probeHttp(`http://127.0.0.1:${port}/`, 180) ? port : null
    ))).filter(Number.isInteger));
    const child = spawnCommand(manager, getRunArgs(manager, script, script.command), root);
    const record = { child, url: null, rejectReady: null };
    processes.set(workspaceId, record);
    emit(workspaceId, 'status', `Running "${manager} run ${script.name}"...`);

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
          const port = Number(new URL(url).port);
          const exitCode = record.child.exitCode;
          if (baselinePorts.has(port) || (exitCode !== null && exitCode !== undefined)) return;
          if (await probeHttp(url)) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(probeTimer);
            record.url = url;
            record.rejectReady = null;
            emit(workspaceId, 'ready', `Local preview is responding at ${url}`);
            resolve({ url, script: script.name, hmr: hasHmrSupport(script.command) });
          }
        } finally {
          probingUrls.delete(url);
        }
      };
      const probeTimer = setInterval(async () => {
        if (settled || checking) return;
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
        if (url && !settled) {
          hintedUrls.add(url);
          void checkUrl(url);
        }
      };

      child.stdout?.on('data', (chunk) => onData('stdout', chunk));
      child.stderr?.on('data', (chunk) => onData('stderr', chunk));
      child.once('error', fail);
      child.once('close', (code) => {
        if (processes.get(workspaceId) !== record) return;
        const message = `Project process exited with code ${code ?? 'unknown'}.`;
        emit(workspaceId, 'error', message);
        if (!settled) fail(new Error(message));
        processes.delete(workspaceId);
      });
    });
  }

  function stopAll() {
    return Promise.all([...processes.keys()].map((workspaceId) => stop(workspaceId)));
  }

  function getWorkspaceIdForUrl(value) {
    let target;
    try {
      target = new URL(value);
    } catch {
      return null;
    }
    for (const [workspaceId, record] of processes) {
      if (!record.url) continue;
      try {
        if (new URL(record.url).origin === target.origin) return workspaceId;
      } catch {
        continue;
      }
    }
    return null;
  }

  return { start, startStatic, stop, stopAll, getWorkspaceIdForUrl };
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
  hasHmrSupport,
  parsePreviewUrl
};
