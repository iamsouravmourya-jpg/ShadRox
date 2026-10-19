const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require('electron');
const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const chokidar = require('chokidar');
let pty = null;
try { pty = require('node-pty'); } catch { /* PTY support may be unavailable in an unbuilt development install. */ }
const { createWorkspaceAccess } = require('./workspace.cjs');
const {
  createPreviewRuntime,
  findMissingDependencies,
  findPreviewProjects,
  findStaticPreviewProjects,
  getPackageManager,
  getPreviewScript
} = require('./preview-runtime.cjs');

const PREVIEW_SCHEME = 'shadrox-preview';

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
let backend = null;
let rendererOrigin = null;
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

function assertTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
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

async function startPackagedBackend() {
  configurePackagedEsbuild();
  const { register } = await import('tsx/esm/api');
  register();
  const serverUrl = pathToFileURL(path.join(app.getAppPath(), 'server.ts')).href;
  const { startServer } = await import(serverUrl);
  return startServer({
    mode: 'production',
    host: '127.0.0.1',
    port: 0,
    staticDirectory: path.join(app.getAppPath(), 'dist')
  });
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

function registerIpcHandlers() {
  ipcMain.handle('workspace:open-folder', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open workspace folder',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    await previewRuntime.stopAll();
    const previousWorkspaceId = activeWorkspaceId;
    const opened = await workspaceAccess.openFolder(result.filePaths[0]);
    if (previousWorkspaceId) {
      stopWorkspaceServices(previousWorkspaceId);
      workspaceAccess.closeWorkspace(previousWorkspaceId);
    }
    activeWorkspaceId = opened.workspaceId;
    watchWorkspace(opened.workspaceId, workspaceAccess.getWorkspace(opened.workspaceId).root);
    return opened;
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

  ipcMain.handle('workspace:close', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (workspaceAccess.getWorkspace(workspaceId)) {
      await previewRuntime.stop(workspaceId);
      stopWorkspaceServices(workspaceId);
      workspaceAccess.closeWorkspace(workspaceId);
    }
    if (activeWorkspaceId === workspaceId) activeWorkspaceId = null;
  });

  ipcMain.handle('workspace:list-directory', async (event, workspaceId, relativePath, cursor) => {
    assertTrustedRenderer(event);
    return workspaceAccess.listDirectory(workspaceId, relativePath, cursor);
  });

  ipcMain.handle('workspace:read-file', async (event, workspaceId, relativePath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.readFile(workspaceId, relativePath);
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

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#000000',
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' };
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(rendererOrigin).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
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

app.whenReady().then(async () => {
  allowLoopbackPreviewCertificates();
  installPreviewRequestGuard();
  protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
  registerIpcHandlers();
  await createWindow();
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
