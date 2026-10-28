const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell } = require('electron');
const { exec, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const chokidar = require('chokidar');
let pty = null;
try { pty = require('node-pty'); } catch { /* PTY support may be unavailable in an unbuilt development install. */ }
const { createWorkspaceAccess } = require('./workspace.cjs');
const {
  buildGitArgv,
  buildIsolatedGitEnv,
  collectRepoFilterDrivers,
  extractFolderArgument,
  isPathInsideDirectory,
  isSameOriginAsRenderer,
  isTrustedRendererEvent,
  resolveGitExecutable
} = require('./desktop-security.cjs');
const {
  createPreviewRuntime,
  findMissingDependencies,
  findPreviewProjects,
  findStaticPreviewProjects,
  getPackageManager,
  getPreviewScript
} = require('./preview-runtime.cjs');
const { createUpdater } = require('./updater.cjs');

const PREVIEW_SCHEME = 'shadrox-preview';
const APP_BACKGROUND = '#090a0d';
const TITLE_BAR_HEIGHT = 48;

app.setAppUserModelId('com.shadrox.desktop');
nativeTheme.themeSource = 'dark';

// AMD drivers on Windows can terminate Electron's GPU process with E_INVALIDARG
// (0x80070057). Software compositing keeps the preview surface stable.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

protocol.registerSchemesAsPrivileged([{
  scheme: PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}]);

const workspaceAccess = createWorkspaceAccess();
const workspaceWatchers = new Map();
const terminalSessions = new Map();
let activeWorkspaceId = null;
let mainWindow = null;
let updater = null;
let rendererDirty = false;
let allowClose = false;
let backend = null;
let rendererOrigin = null;
let gitExecutable = null;
let gitEnvironment = null;
let gitSafetyCache = { root: null, context: null };
const previewRuntime = createPreviewRuntime({
  onOutput: (output) => mainWindow?.webContents.send('preview:output', output)
});

const PREVIEW_ENTRY_CANDIDATES = [
  'index.html',
  'public/index.html',
  'dist/index.html',
  'build/index.html',
  'out/index.html',
  'src/index.html'
];
const PREVIEW_ASSET_FALLBACK_DIRECTORIES = ['dist', 'build', 'out', 'public'];
const PREVIEW_MIME_TYPES = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8'
};

class PreviewRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PreviewRequestError';
    this.status = status;
  }
}

function isWithinPreviewRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function getPreviewMimeType(filePath) {
  return PREVIEW_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function previewErrorResponse(status, message, extraHeaders = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

function resolvePreviewWorkspace(hostname) {
  const workspace = workspaceAccess.getWorkspace(hostname);
  return workspace?.mode === 'folder' ? workspace : null;
}

function isTrustedPreviewRequest(details) {
  let target;
  try {
    target = new URL(details.url);
  } catch {
    return false;
  }
  if (target.protocol !== `${PREVIEW_SCHEME}:`) return true;

  const workspace = workspaceAccess.getWorkspace(target.hostname);
  if (!workspace || workspace.mode !== 'folder') return false;

  const frame = details.frame;
  if (!frame) return false;
  if (frame.origin === `${PREVIEW_SCHEME}://${target.hostname}`) return true;
  if (!rendererOrigin) return false;
  return frame.origin === rendererOrigin || frame.parent === rendererOrigin;
}

function installPreviewRequestGuard() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith(`${PREVIEW_SCHEME}://`)) {
      callback({});
      return;
    }
    callback({ cancel: !isTrustedPreviewRequest(details) });
  });
}

function allowLoopbackPreviewCertificates() {
  session.defaultSession.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    let hostname = '';
    let protocolName = '';
    try {
      const target = new URL(url);
      hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      protocolName = target.protocol;
    } catch {
      callback(false);
      return;
    }
    if (protocolName === 'https:' && ['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

function getPreviewWorkspaceIdForUrl(value) {
  const runtimeWorkspaceId = previewRuntime.getWorkspaceIdForUrl(value);
  if (runtimeWorkspaceId) return runtimeWorkspaceId;

  let target;
  try {
    target = new URL(value);
  } catch {
    return null;
  }
  if (target.protocol !== `${PREVIEW_SCHEME}:`) return null;
  return workspaceAccess.getWorkspace(target.hostname)?.mode === 'folder' ? target.hostname : null;
}

function decodePreviewSegments(pathname) {
  if (pathname.length > 8192) {
    throw new PreviewRequestError(414, 'The requested preview path is too long.');
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new PreviewRequestError(400, 'The requested preview path is not valid URL encoding.');
  }
  if (decoded.includes('\0') || decoded.includes('\\') || (process.platform === 'win32' && decoded.includes(':'))) {
    throw new PreviewRequestError(403, 'The requested preview path contains forbidden characters.');
  }

  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    throw new PreviewRequestError(403, 'Hidden files and parent paths are not served by the preview protocol.');
  }
  return segments;
}

async function resolvePreviewFile(root, relativePath) {
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  if (!isWithinPreviewRoot(root, absolutePath)) {
    throw new PreviewRequestError(403, 'The requested file is outside the opened workspace.');
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new PreviewRequestError(403, 'The requested file cannot be read.');
  }
  if (!isWithinPreviewRoot(root, realPath)) {
    throw new PreviewRequestError(403, 'The requested file resolves outside the opened workspace.');
  }

  let stat;
  try {
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new PreviewRequestError(403, 'The requested file cannot be read.');
  }
  return stat.isFile() ? { filePath: realPath, stat } : null;
}

async function resolvePreviewCandidate(root, segments) {
  const relativePath = segments.join('/');
  const extension = path.extname(relativePath).toLowerCase();
  const isDocumentRequest = !extension || extension === '.html' || extension === '.htm';
  const candidates = new Set();

  if (relativePath) {
    candidates.add(relativePath);
    if (isDocumentRequest) candidates.add(path.posix.join(relativePath, 'index.html'));
  } else {
    candidates.add('index.html');
  }

  for (const directory of PREVIEW_ASSET_FALLBACK_DIRECTORIES) {
    candidates.add(path.posix.join(directory, relativePath || 'index.html'));
    if (isDocumentRequest && relativePath) {
      candidates.add(path.posix.join(directory, relativePath, 'index.html'));
    }
  }

  for (const candidate of candidates) {
    const file = await resolvePreviewFile(root, candidate);
    if (file) return file;
  }
  return null;
}

async function findStaticPreviewFile(root) {
  for (const candidate of PREVIEW_ENTRY_CANDIDATES) {
    try {
      const file = await resolvePreviewFile(root, candidate);
      if (file) return file;
    } catch (error) {
      if (!(error instanceof PreviewRequestError)) throw error;
    }
  }
  return null;
}

function getAllowedCorsOrigin(origin, hostname) {
  if (!origin) return null;
  if (origin === `${PREVIEW_SCHEME}://${hostname}`) return origin;
  if (rendererOrigin && origin === rendererOrigin) return origin;
  return null;
}

function parseByteRange(value, size) {
  if (!value || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { unsatisfiable: true };

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return { unsatisfiable: true };
  }
  return { start, end };
}

function createPreviewFileResponse(request, url, file) {
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(file.stat.size),
    'Content-Type': getPreviewMimeType(file.filePath),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
  const allowedOrigin = getAllowedCorsOrigin(request.headers.get('origin'), url.hostname);
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers.Vary = 'Origin';
  }

  const range = request.headers.get('range')
    ? parseByteRange(request.headers.get('range'), file.stat.size)
    : null;
  if (range?.unsatisfiable) {
    return previewErrorResponse(416, 'The requested byte range is not available.', {
      'Content-Range': `bytes */${file.stat.size}`
    });
  }

  let status = 200;
  if (range) {
    status = 206;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.stat.size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  }

  if ((request.method || 'GET').toUpperCase() === 'HEAD' || file.stat.size === 0) {
    return new Response(null, { status, headers });
  }

  const stream = fs.createReadStream(
    file.filePath,
    range ? { start: range.start, end: range.end } : undefined
  );
  const abortStream = () => stream.destroy();
  request.signal?.addEventListener('abort', abortStream, { once: true });
  stream.once('close', () => request.signal?.removeEventListener('abort', abortStream));
  stream.once('error', (error) => {
    console.error(`[desktop] Preview stream failed for ${file.filePath}:`, error);
  });

  return new Response(Readable.toWeb(stream), { status, headers });
}

async function servePreviewRequest(request) {
  const method = (request.method || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return previewErrorResponse(400, 'The preview URL is invalid.');
  }

  if (method === 'OPTIONS') {
    const allowedOrigin = getAllowedCorsOrigin(request.headers.get('origin'), url.hostname);
    if (!allowedOrigin) return previewErrorResponse(403, 'The preview request origin is not allowed.');
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Max-Age': '600',
        Vary: 'Origin'
      }
    });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return previewErrorResponse(405, 'The preview protocol supports GET, HEAD, and OPTIONS requests only.', {
      Allow: 'GET, HEAD, OPTIONS'
    });
  }

  const workspace = resolvePreviewWorkspace(url.hostname);
  if (!workspace) {
    return previewErrorResponse(404, 'No local folder is active for this preview URL.');
  }

  const segments = decodePreviewSegments(url.pathname);
  const root = workspace.root;
  const exactTarget = path.resolve(root, ...segments);
  if (!isWithinPreviewRoot(root, exactTarget)) {
    return previewErrorResponse(403, 'The requested path is outside the opened workspace.');
  }

  let exactStat;
  try {
    exactStat = await fs.promises.stat(exactTarget);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      return previewErrorResponse(403, 'The requested path cannot be read.');
    }
  }

  if (exactStat?.isDirectory()) {
    if (segments.length > 0 && !url.pathname.endsWith('/')) {
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = `${redirectUrl.pathname}/`;
      return new Response(null, {
        status: 308,
        headers: {
          'Cache-Control': 'no-store',
          Location: redirectUrl.href
        }
      });
    }
    const indexFile = await resolvePreviewFile(root, [...segments, 'index.html'].join('/'));
    if (indexFile) return createPreviewFileResponse(request, url, indexFile);
  }

  const file = await resolvePreviewCandidate(root, segments);
  if (file) return createPreviewFileResponse(request, url, file);

  const acceptsHtml = (request.headers.get('accept') || '').includes('text/html');
  if (acceptsHtml) {
    const entry = await findStaticPreviewFile(root);
    if (entry) return createPreviewFileResponse(request, url, entry);
  }

  if (path.posix.basename(url.pathname) === 'favicon.ico') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return previewErrorResponse(404, `Preview file not found: ${url.pathname}`);
}

async function handlePreviewRequest(request) {
  try {
    return await servePreviewRequest(request);
  } catch (error) {
    if (error instanceof PreviewRequestError) {
      return previewErrorResponse(error.status, error.message);
    }
    console.error('[desktop] Preview protocol request failed:', error);
    return previewErrorResponse(500, 'The preview file could not be served.');
  }
}

async function startProtocolPreview(workspaceId, workspaceRoot, reportStatus, projectRoot = workspaceRoot) {
  await previewRuntime.stop(workspaceId);
  const entry = await findStaticPreviewFile(projectRoot);
  if (!entry) {
    throw new Error('Static local preview requires an index.html file in the workspace, public, dist, build, out, or src folder.');
  }

  const relativeEntry = path.relative(workspaceRoot, entry.filePath).split(path.sep).join('/');
  const url = `${PREVIEW_SCHEME}://${workspaceId}/${relativeEntry.split('/').map(encodeURIComponent).join('/')}`;
  reportStatus(`Serving ${relativeEntry} from ${path.basename(projectRoot)} through the local preview protocol.`);
  return { url, script: 'static' };
}

function configurePackagedEsbuild() {
  if (!app.isPackaged) return;
  const unpackedAppPath = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
  const executable = process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  process.env.ESBUILD_BINARY_PATH = path.join(
    unpackedAppPath,
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    executable
  );
}

/**
 * The bridge is for ShadRox's own document only. Electron injects preload.cjs
 * into every frame of a webContents and the preview iframes live inside this
 * document, so `event.sender` alone would let workspace-authored code reach the
 * terminal, the decrypted key store and the folder picker. `isTrustedRendererEvent`
 * additionally pins the frame to the main frame and to the app's own origin.
 */
function assertTrustedRenderer(event) {
  if (!isTrustedRendererEvent(event, mainWindow, rendererOrigin)) {
    throw new Error('Desktop operation rejected for an untrusted renderer.');
  }
}

function stopWorkspaceServices(workspaceId) {
  const watcher = workspaceWatchers.get(workspaceId);
  if (watcher) {
    workspaceWatchers.delete(workspaceId);
    void watcher.close();
  }
  for (const [sessionId, sessionInfo] of terminalSessions) {
    if (sessionInfo.workspaceId !== workspaceId) continue;
    terminalSessions.delete(sessionId);
    try { sessionInfo.terminal.kill(); } catch { /* process already exited */ }
  }
}

function watchWorkspace(workspaceId, root) {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (value) => {
      const relative = path.relative(root, value);
      return relative.split(path.sep).some((part) => part.startsWith('.') || ['node_modules', 'dist', 'build', '.next', 'out', 'coverage', 'vendor'].includes(part));
    },
    awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 }
  });
  const changes = new Map();
  let timer;
  const flush = () => {
    timer = null;
    if (!changes.size) return;
    mainWindow?.webContents.send('workspace:change', {
      workspaceId,
      changes: [...changes.values()]
    });
    changes.clear();
  };
  watcher.on('all', (event, absolutePath) => {
    if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
    const relative = path.relative(root, absolutePath).split(path.sep).join('/');
    if (!relative || relative.startsWith('../')) return;
    changes.set(relative, { path: relative, kind: event });
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  });
  watcher.on('error', (error) => console.warn('[workspace] watcher error', error));
  workspaceWatchers.set(workspaceId, watcher);
}

function runtimeConfigPath() {
  return path.join(app.getPath('userData'), 'runtime.json');
}

function readStoredPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath(), 'utf8'));
    const port = Number(parsed?.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function storePort(port) {
  try {
    fs.mkdirSync(path.dirname(runtimeConfigPath()), { recursive: true });
    fs.writeFileSync(runtimeConfigPath(), JSON.stringify({ port }), 'utf8');
  } catch (error) {
    console.warn('[runtime] could not persist local port', error);
  }
}

async function startPackagedBackend() {
  configurePackagedEsbuild();
  const { register } = await import('tsx/esm/api');
  register();
  const serverUrl = pathToFileURL(path.join(app.getAppPath(), 'server.ts')).href;
  const { startServer } = await import(serverUrl);
  const options = {
    mode: 'production',
    host: '127.0.0.1',
    staticDirectory: path.join(app.getAppPath(), 'dist')
  };

  // The renderer origin must stay stable between launches: localStorage and
  // IndexedDB are scoped to it, so a fresh random port would wipe saved keys,
  // recents, and plan state on every start.
  const storedPort = readStoredPort();
  const candidates = [...new Set([storedPort, 43121, 43122, 43123].filter((port) => Number.isInteger(port) && port > 0))];

  for (const port of candidates) {
    try {
      const backend = await startServer({ ...options, port });
      const actualPort = Number(new URL(backend.origin).port);
      if (actualPort !== storedPort) storePort(actualPort);
      return backend;
    } catch (error) {
      console.warn(`[runtime] local port ${port} unavailable, trying next`, error instanceof Error ? error.message : error);
    }
  }

  const backend = await startServer({ ...options, port: 0 });
  storePort(Number(new URL(backend.origin).port));
  return backend;
}

function executeCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0
      });
    });
  });
}

function secureStorePath() {
  return path.join(app.getPath('userData'), 'secure-store.json');
}

/**
 * Read-only git access for the renderer: one absolute executable, one isolated
 * environment, and a fixed argv per call built by `buildGitArgv`, so neither the
 * opened folder nor its `.git/config` can name a program to run.
 */
function runGit(cwd, args) {
  return new Promise((resolve) => {
    if (!gitExecutable || !gitEnvironment) {
      resolve({ ok: false, stdout: '', stderr: 'git is unavailable on a trusted path.' });
      return;
    }
    execFile(gitExecutable, args, {
      cwd,
      env: gitEnvironment,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function locateGitExecutable() {
  gitExecutable = resolveGitExecutable({});
  gitEnvironment = gitExecutable ? buildIsolatedGitEnv({}) : null;
  gitSafetyCache = { root: null, context: null };
  if (!gitExecutable) {
    console.warn('[desktop] no absolute git executable found outside the workspace; commit context is disabled');
  }
}

/**
 * Per-workspace argv for the three read calls, plus whether the repository's own
 * config could be fully enumerated. `complete: false` means an unknown filter
 * driver may exist, so the two commands that convert working-tree files are
 * skipped rather than run blindly.
 */
async function gitSafetyContext(workspaceRoot) {
  if (gitSafetyCache.root === workspaceRoot && gitSafetyCache.context) return gitSafetyCache.context;

  const options = { safeDirectories: [workspaceRoot] };
  const probeArgs = buildGitArgv(['rev-parse', '--absolute-git-dir'], options);
  const probe = await runGit(workspaceRoot, probeArgs);
  const gitDir = probe.ok ? probe.stdout.trim() : '';

  let drivers = [];
  let complete = false;
  if (gitDir && path.isAbsolute(gitDir)) {
    const collected = await collectRepoFilterDrivers(gitDir);
    drivers = collected.drivers;
    complete = collected.complete;
  }

  const context = {
    complete,
    probeArgs: buildGitArgv(['rev-parse', '--is-inside-work-tree'], options),
    statusArgs: buildGitArgv(['status', '--porcelain=v1', '--branch'], { ...options, filterDrivers: drivers }),
    diffArgs: buildGitArgv(['diff', '--no-color', '--unified=2', 'HEAD'], { ...options, filterDrivers: drivers }),
    logArgs: buildGitArgv(['log', '-n', '8', '--pretty=%s'], { ...options, filterDrivers: drivers })
  };
  gitSafetyCache = { root: workspaceRoot, context };
  return context;
}

function truncateText(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}

function readSecureStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(secureStorePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSecureStore(store) {
  const file = secureStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
}

const SECURE_KEY_PATTERN = /^shadrox\.[a-z0-9._-]{1,80}$/i;

function registerSecureStoreHandlers() {
  ipcMain.handle('secure:get-all', (event) => {
    assertTrustedRenderer(event);
    if (!safeStorage.isEncryptionAvailable()) return {};
    const store = readSecureStore();
    const result = {};
    for (const [key, value] of Object.entries(store)) {
      if (typeof value !== 'string') continue;
      try {
        result[key] = safeStorage.decryptString(Buffer.from(value, 'base64'));
      } catch {
        // Values encrypted under a different OS profile are simply dropped.
      }
    }
    return result;
  });

  ipcMain.handle('secure:set', (event, key, value) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) throw new Error('Invalid settings key.');
    if (typeof value !== 'string' || value.length > 200_000) throw new Error('Invalid settings value.');
    if (!safeStorage.isEncryptionAvailable()) return false;
    const store = readSecureStore();
    store[key] = safeStorage.encryptString(value).toString('base64');
    writeSecureStore(store);
    return true;
  });

  ipcMain.handle('secure:delete', (event, key) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string' || !(key in readSecureStore())) return false;
    const store = readSecureStore();
    delete store[key];
    writeSecureStore(store);
    return true;
  });
}

const AUTH_CALLBACK_PATH = '/auth/callback';
const AUTH_TIMEOUT_MS = 180_000;
let pendingAuthSignIn = null;

function authCallbackPage(heading) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShadRox</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0b0b0f; color: #ececf1;
         font-family: "Segoe UI", system-ui, sans-serif; }
  main { text-align: center; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #a1a1aa; font-size: 14px; }
</style></head><body><main><h1>${heading}</h1><p>You can close this tab and return to ShadRox.</p></main></body></html>`;
}

/**
 * Google sign-in runs in the user's real browser, so the app needs a loopback
 * listener to receive the redirect (RFC 8252). The renderer owns PKCE and the
 * token exchange; this handler only opens the URL and hands back query params.
 */
function registerAuthHandlers() {
  ipcMain.handle('app:version', (event) => {
    assertTrustedRenderer(event);
    return app.getVersion();
  });

  ipcMain.handle('auth:start-loopback', async (event, authorizeUrl, redirectUri) => {
    assertTrustedRenderer(event);
    if (typeof authorizeUrl !== 'string' || typeof redirectUri !== 'string') {
      throw new Error('Invalid sign-in request.');
    }
    let authorize;
    let redirect;
    try {
      authorize = new URL(authorizeUrl);
      redirect = new URL(redirectUri);
    } catch {
      throw new Error('Invalid sign-in request.');
    }
    if (authorize.protocol !== 'https:') throw new Error('Sign-in must use an https URL.');
    const port = Number(redirect.port);
    if (
      redirect.protocol !== 'http:' ||
      redirect.hostname !== '127.0.0.1' ||
      redirect.pathname !== AUTH_CALLBACK_PATH ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    ) {
      throw new Error('Invalid sign-in redirect.');
    }
    if (pendingAuthSignIn) throw new Error('A sign-in is already in progress.');

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingAuthSignIn = null;
        server.close();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ error: 'Sign-in timed out. Please try again.' }), AUTH_TIMEOUT_MS);
      const server = http.createServer((request, response) => {
        let incoming = null;
        try {
          incoming = new URL(request.url || '/', `http://127.0.0.1:${port}`);
        } catch {
          incoming = null;
        }
        if (!incoming || incoming.pathname !== AUTH_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }
        const params = Object.fromEntries(incoming.searchParams.entries());
        const failed = params.error_description || params.error;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(authCallbackPage(failed ? 'Sign-in was not completed' : 'Signed in'));
        finish(failed ? { error: String(failed).replace(/\+/g, ' ') } : { params });
      });
      server.on('error', (error) => {
        finish({
          error: error && error.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Close the other sign-in window and try again.`
            : 'Could not start the local sign-in listener.'
        });
      });
      server.listen(port, '127.0.0.1', () => {
        pendingAuthSignIn = { port };
        shell.openExternal(authorizeUrl).catch(() => finish({ error: 'Could not open your browser for sign-in.' }));
      });
    });
  });
}

/**
 * Replaces the active folder workspace. One path backs the folder picker, the
 * 1-click recent reopen and a second launch's command-line folder.
 */
async function openFolderWorkspace(rootPath) {
  await previewRuntime.stopAll();
  const previousWorkspaceId = activeWorkspaceId;
  const opened = await workspaceAccess.openFolder(rootPath);
  if (previousWorkspaceId) {
    stopWorkspaceServices(previousWorkspaceId);
    workspaceAccess.closeWorkspace(previousWorkspaceId);
  }
  activeWorkspaceId = opened.workspaceId;
  watchWorkspace(opened.workspaceId, workspaceAccess.getWorkspace(opened.workspaceId).root);
  return opened;
}

function registerIpcHandlers() {
  ipcMain.handle('workspace:open-folder', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open workspace folder',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openFolderWorkspace(result.filePaths[0]);
  });

  ipcMain.handle('workspace:open-files', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open code files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Code and text files', extensions: ['*'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    await previewRuntime.stopAll();
    const previousWorkspaceId = activeWorkspaceId;
    const opened = await workspaceAccess.openFiles(result.filePaths);
    if (opened) {
      if (previousWorkspaceId) {
        stopWorkspaceServices(previousWorkspaceId);
        workspaceAccess.closeWorkspace(previousWorkspaceId);
      }
      activeWorkspaceId = opened.workspaceId;
    }
    return opened;
  });

  ipcMain.handle('workspace:reopen', async (event, target) => {
    assertTrustedRenderer(event);
    if (!target || typeof target !== 'object') throw new Error('Invalid recent workspace.');

    await previewRuntime.stopAll();
    const previousWorkspaceId = activeWorkspaceId;

    if (target.kind === 'folder') {
      if (typeof target.path !== 'string' || target.path.length === 0) {
        throw new Error('This recent folder has no stored location.');
      }
      const stat = await fs.promises.stat(target.path).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new Error('That folder no longer exists. It may have been moved, renamed, or deleted.');
      }
      return openFolderWorkspace(target.path);
    }

    if (target.kind === 'file') {
      const filePaths = Array.isArray(target.filePaths)
        ? target.filePaths.filter((entry) => typeof entry === 'string' && entry.length > 0)
        : [];
      if (filePaths.length === 0) throw new Error('This recent entry has no stored file paths.');
      for (const filePath of filePaths) {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`${path.basename(filePath)} no longer exists.`);
      }
      const opened = await workspaceAccess.openFiles(filePaths);
      if (!opened) throw new Error('Those files could not be reopened.');
      if (previousWorkspaceId) {
        stopWorkspaceServices(previousWorkspaceId);
        workspaceAccess.closeWorkspace(previousWorkspaceId);
      }
      activeWorkspaceId = opened.workspaceId;
      return opened;
    }

    throw new Error('Unknown recent workspace type.');
  });

  ipcMain.handle('workspace:close', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (workspaceAccess.getWorkspace(workspaceId)) {
      await previewRuntime.stop(workspaceId);
      stopWorkspaceServices(workspaceId);
      workspaceAccess.closeWorkspace(workspaceId);
    }
    if (activeWorkspaceId === workspaceId) activeWorkspaceId = null;
  });

  ipcMain.handle('app:set-dirty', (event, dirty) => {
    assertTrustedRenderer(event);
    rendererDirty = Boolean(dirty);
  });

  ipcMain.handle('workspace:list-directory', async (event, workspaceId, relativePath, cursor) => {
    assertTrustedRenderer(event);
    return workspaceAccess.listDirectory(workspaceId, relativePath, cursor);
  });

  ipcMain.handle('workspace:read-file', async (event, workspaceId, relativePath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.readFile(workspaceId, relativePath);
  });

  ipcMain.handle('workspace:rename-file', async (event, workspaceId, fromPath, toPath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.renameFile(workspaceId, fromPath, toPath);
  });

  ipcMain.handle('workspace:search-files', async (event, workspaceId, query, limit) => {
    assertTrustedRenderer(event);
    return workspaceAccess.searchFiles(workspaceId, query, limit);
  });

  ipcMain.handle('workspace:save-files', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    return workspaceAccess.saveFiles(workspaceId, files);
  });

  ipcMain.handle('workspace:stage-files', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    return workspaceAccess.stageFiles(workspaceId, files);
  });

  ipcMain.handle('workspace:commit', async (event, workspaceId, transactionId) => {
    assertTrustedRenderer(event);
    return workspaceAccess.commitTransaction(workspaceId, transactionId);
  });

  ipcMain.handle('workspace:discard', async (event, workspaceId, transactionId) => {
    assertTrustedRenderer(event);
    workspaceAccess.discardTransaction(workspaceId, transactionId);
  });

  ipcMain.handle('terminal:create', async (event, workspaceId, cols = 100, rows = 30) => {
    assertTrustedRenderer(event);
    if (!pty) throw new Error('Interactive terminal support is unavailable. Reinstall the desktop dependencies and restart ShadRox.');
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') throw new Error('Terminal sessions require an opened folder workspace.');
    const sessionId = randomUUID();
    const shellPath = process.platform === 'win32' ? (process.env.ComSpec || 'powershell.exe') : (process.env.SHELL || '/bin/zsh');
    const shellArgs = process.platform === 'win32' && /powershell/i.test(shellPath) ? ['-NoLogo'] : [];
    const terminal = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color', cols: Math.max(20, Math.min(400, Number(cols) || 100)), rows: Math.max(5, Math.min(200, Number(rows) || 30)),
      cwd: workspace.root, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: process.platform === 'win32',
      windowsHide: true
    });
    const sessionInfo = { workspaceId, terminal };
    terminalSessions.set(sessionId, sessionInfo);
    terminal.onData((data) => mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'data', data }));
    terminal.onExit(({ exitCode }) => {
      terminalSessions.delete(sessionId);
      mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'exit', exitCode });
    });
    return { sessionId, title: path.basename(workspace.root) };
  });

  ipcMain.handle('terminal:write', async (event, workspaceId, sessionId, data) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId || typeof data !== 'string' || data.length > 64_000) throw new Error('Invalid terminal session or input.');
    sessionInfo.terminal.write(data);
  });

  ipcMain.handle('terminal:resize', async (event, workspaceId, sessionId, cols, rows) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) throw new Error('Invalid terminal session.');
    sessionInfo.terminal.resize(Math.max(20, Math.min(400, Number(cols) || 100)), Math.max(5, Math.min(200, Number(rows) || 30)));
  });

  ipcMain.handle('terminal:close', async (event, workspaceId, sessionId) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) return;
    terminalSessions.delete(sessionId);
    sessionInfo.terminal.kill();
  });

  ipcMain.handle('preview:start', async (event, workspaceId, approval = {}) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Local project preview requires an opened folder workspace.');
    }

    const reportStatus = (message) => {
      mainWindow?.webContents.send('preview:output', { workspaceId, type: 'status', message });
    };
    reportStatus(`Checking ${path.basename(workspace.root)} for a runnable web project...`);

    const projects = await findPreviewProjects(workspace.root);
    if (projects.length === 0) {
      const staticProjects = await findStaticPreviewProjects(workspace.root);
      if (approval.projectKind === 'static' && approval.projectPath) {
        const selected = staticProjects.find((candidate) => candidate.relativePath === approval.projectPath);
        if (!selected) throw new Error('The selected static folder no longer contains an index.html file. Scan the workspace again.');
        return startProtocolPreview(workspaceId, workspace.root, reportStatus, selected.root);
      }
      if (approval.projectPath || approval.approved) throw new Error('The selected project no longer has a supported preview entry. Scan the workspace again before previewing.');
      if (staticProjects.length > 1) {
        reportStatus(`No runnable package script found. Found ${staticProjects.length} static site folders; choose which one to preview.`);
        return { status: 'selection-required', projects: staticProjects.map(({ relativePath }) => ({ kind: 'static', projectPath: relativePath })) };
      }
      if (staticProjects.length === 1) {
        reportStatus('No runnable package script found. Streaming the detected static website through shadrox-preview...');
        return startProtocolPreview(workspaceId, workspace.root, reportStatus, staticProjects[0].root);
      }
      reportStatus('No runnable package script or nested index.html found. Checking supported static entry folders...');
      return startProtocolPreview(workspaceId, workspace.root, reportStatus);
    }
    if (approval.projectKind === 'static') throw new Error('The selected static folder is no longer available. Scan the workspace again before previewing.');
    let project = null;
    if (approval.projectPath) {
      project = projects.find((candidate) => candidate.relativePath === approval.projectPath);
      if (!project) throw new Error('The selected project folder is no longer available. Scan the workspace again.');
    } else if (projects.length === 1) {
      project = projects[0];
    } else {
      const choices = await Promise.all(projects.map(async (candidate) => ({
        kind: 'node',
        projectPath: candidate.relativePath,
        manifestHash: candidate.manifestHash,
        packageManager: candidate.packageManager,
        scriptName: candidate.script.name,
        scriptCommand: candidate.script.command,
        missingDependencies: await findMissingDependencies(candidate.manifest, candidate.root)
      })));
      reportStatus(`Found ${choices.length} runnable web project folders. Choose which one to preview.`);
      return { status: 'selection-required', projects: choices };
    }
    const { manifest } = project;
    const script = getPreviewScript(manifest);

    const manager = getPackageManager(manifest, project.root);
    const missingDependencies = await findMissingDependencies(manifest, project.root);
    const installNotice = missingDependencies.length > 0
      ? `ShadRox will install ${missingDependencies.length} missing package(s) with "${manager} install" before starting the project: ${missingDependencies.slice(0, 12).join(', ')}${missingDependencies.length > 12 ? ', ...' : ''}.`
      : 'Existing project dependencies will be used.';
    const relativeProjectPath = path.relative(workspace.root, project.root) || '.';
    if (!approval?.approved) {
      const request = {
        workspaceId,
        manifestHash: project.manifestHash,
        projectPath: relativeProjectPath,
        packageManager: manager,
        scriptName: script.name,
        scriptCommand: script.command,
        missingDependencies
      };
      reportStatus(
        `Detected ${relativeProjectPath}: "${manager} run ${script.name}" (${script.command}). ` +
        `${installNotice} Waiting for your approval in chat.`
      );
      return { status: 'approval-required', approval: request };
    }
    if (approval.manifestHash !== project.manifestHash) {
      throw new Error('The project package.json changed while awaiting approval. Review the detected command and try again.');
    }
    reportStatus(
      `Detected a runnable project in ${path.relative(workspace.root, project.root) || '.'}. ` +
      `Approved: "${manager} run ${script.name}". ${installNotice}`
    );
    return previewRuntime.start(workspaceId, project.root, project.manifestHash);
  });

  ipcMain.handle('preview:stop', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return previewRuntime.stop(workspaceId);
  });

  ipcMain.handle('terminal:run-command', async (event, workspaceId, command) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Terminal commands are available only for an opened folder workspace.');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > 5000) {
      throw new Error('Enter a command between 1 and 5000 characters.');
    }

    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Confirm terminal command',
      message: 'Allow ShadRox to run this command?',
      detail: `${command}\n\nWorking directory: ${workspace.root}\n\nCommands can modify or delete files and access the network.`,
      buttons: ['Cancel', 'Run command'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) throw new Error('Terminal command cancelled.');
    return executeCommand(command, workspace.root);
  });

  ipcMain.handle('git:read', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Git info is available only for an opened folder workspace.');
    }

    const unavailable = { isRepo: false, status: '', diff: '', log: '', dirty: 0 };
    if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) return unavailable;

    const context = await gitSafetyContext(workspace.root);
    const probe = await runGit(workspace.root, context.probeArgs);
    if (!probe.ok || probe.stdout.trim() !== 'true') return unavailable;

    const empty = Promise.resolve({ ok: false, stdout: '', stderr: '' });
    const [status, diff, log] = await Promise.all([
      context.complete ? runGit(workspace.root, context.statusArgs) : empty,
      context.complete ? runGit(workspace.root, context.diffArgs) : empty,
      runGit(workspace.root, context.logArgs)
    ]);

    return {
      isRepo: true,
      status: truncateText(status.stdout, 4_000),
      diff: truncateText(diff.stdout, 60_000),
      log: truncateText(log.stdout, 2_000),
      dirty: status.stdout.split('\n').filter((line) => line && !line.startsWith('##')).length
    };
  });

  ipcMain.handle('updater:check', async (event) => {
    assertTrustedRenderer(event);
    if (!updater?.available) return { available: false };
    await updater.check(true);
    return { available: true };
  });
}

/**
 * A second launch is handled by the surviving instance: bring its window back and
 * take over the folder the new process was pointed at, using the same recent
 * workspace path the hub uses.
 */
async function handleSecondInstanceLaunch(argv, workingDirectory) {
  if (!mainWindow) {
    await createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }

  const folder = extractFolderArgument(argv, {
    workingDirectory,
    applicationDirectory: path.dirname(app.getPath('exe'))
  });
  if (!folder) return;
  if (activeWorkspaceId) {
    if (workspaceAccess.getWorkspace(activeWorkspaceId)?.root === folder) return;
    // The renderer owns the live workspace and is the only thing that can mount a
    // replacement, so closing its folder from here would desync the editor. Report
    // the request on the existing preview status channel instead.
    mainWindow?.webContents.send('preview:output', {
      workspaceId: activeWorkspaceId,
      type: 'status',
      message: `Another ShadRox asked to open ${folder}. Open it from Recents to switch workspaces.`
    });
    return;
  }
  try {
    await openFolderWorkspace(folder);
  } catch (error) {
    console.warn('[desktop] second-instance folder could not be opened', error);
  }
}

async function createWindow() {
  if (!rendererOrigin) {
    if (app.isPackaged) {
      backend = await startPackagedBackend();
      rendererOrigin = backend.origin;
    } else {
      rendererOrigin = process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000';
    }
  }

  const appIcon = path.join(__dirname, '..', 'assets', 'icon.png');
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'ShadRox',
    backgroundColor: APP_BACKGROUND,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(fs.existsSync(appIcon) ? { icon: appIcon } : {}),
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 15 } }
      : {
          titleBarOverlay: {
            color: APP_BACKGROUND,
            symbolColor: '#d4d4d8',
            height: TITLE_BAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === mainWindow?.webContents && details.isMainFrame && permission === 'media');
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (allowClose || !rendererDirty || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Unsaved changes',
      message: 'You have unsaved changes in ShadRox.',
      detail: 'Save your files before closing, or close and lose those edits.'
    });
    if (choice === 1) {
      allowClose = true;
      return;
    }
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' };
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameOriginAsRenderer(url, rendererOrigin)) event.preventDefault();
  });
  mainWindow.webContents.on('console-message', (details) => {
    const workspaceId = getPreviewWorkspaceIdForUrl(details.frame?.url || '');
    if (!workspaceId || typeof details.message !== 'string') return;
    const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : 'log';
    mainWindow?.webContents.send('preview:output', {
      workspaceId,
      type: 'console',
      message: `[preview ${level}] ${details.message}`
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(rendererOrigin);
}

// Two processes race the backend port fallback and both rewrite runtime.json,
// which changes the app origin and orphans the IndexedDB chat history and file
// snapshots saved under the previous one. Only the first launch may boot ShadRox.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void handleSecondInstanceLaunch(argv, workingDirectory).catch((error) => {
      console.warn('[desktop] second-instance request failed', error);
    });
  });
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  // A default File/Edit/View menu is what makes a packaged Electron app read as
  // a generic system utility. Windows/Linux get no menu bar; macOS keeps the
  // minimal role menu it needs for standard shortcuts.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  allowLoopbackPreviewCertificates();
  installPreviewRequestGuard();
  protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
  locateGitExecutable();
  registerIpcHandlers();
  registerSecureStoreHandlers();
  registerAuthHandlers();
  await createWindow();
  updater = createUpdater({
    app,
    dialog,
    broadcast: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status', payload);
      }
    },
    log: (message) => console.warn('[updater]', message)
  });
  updater.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  console.error('[desktop] failed to start', error);
  dialog.showErrorBox('ShadRox failed to start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', () => {
  void previewRuntime.stopAll();
  for (const workspaceId of [...workspaceWatchers.keys()]) stopWorkspaceServices(workspaceId);
  if (backend) {
    void backend.close().catch((error) => console.error('[desktop] backend shutdown failed', error));
    backend = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
