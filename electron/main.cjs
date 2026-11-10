const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell } = require('electron');
const { exec, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const chokidar = require('chokidar');
let pty = null;
try { pty = require('node-pty'); } catch { /* PTY support may be unavailable in an unbuilt development install. */ }
const { createWorkspaceAccess } = require('./workspace.cjs');
const { runWithCommandApproval } = require('./command-approval.cjs');
const {
  createWorkspaceConsent,
  resolveFileReopen,
  resolveFolderReopen
} = require('./workspace-consent.cjs');
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
  getPreviewScript,
  resolveExecutable
} = require('./preview-runtime.cjs');
const { createUpdater } = require('./updater.cjs');
const { createTypeScriptService } = require('./ts-service.cjs');
const { verifyChangeSet } = require('./change-verify.cjs');
const { injectSourceBridge, shouldInject } = require('./preview-source.cjs');
const { stripContentSecurityPolicyMeta, isHtmlDocument } = require('./csp-strip.cjs');
const { listUnmergedPaths } = require('./git-conflicts.cjs');
const {
  parseGitBranches,
  parseGitStatus,
  sanitizeCommitMessage,
  validateBranchName,
  validateGitPaths
} = require('./git-scm.cjs');
const { resolveTerminalPlan, systemEnvironment, clampTerminalSize, normalizeTerminalSessionKey, isSafeExternalUrl } = require('./terminal-modes.cjs');
const { applyShellIntegration } = require('./shell-integration.cjs');
const { createProofStore } = require('./proof-store.cjs');
const { createProofKeyring } = require('./proof-keyring.cjs');
const { createProofService, PROOF_APP_SCOPE } = require('./proof-service.cjs');
const { redactCommandForProof } = require('./proof-redact.cjs');
const {
  DEFAULT_SETTLE_MS,
  buildFrameAssertionScript,
  createConsoleErrorSink,
  deriveContainerSelectors,
  mergePreviewVerdict,
  summarizeFrameResult
} = require('./preview-assert.cjs');
const { createMcpClient, validateServerConfig, isSafeHttpUrl } = require('./mcp-client.cjs');
const { detectRuntime, planDualPreview } = require('./runtime-adapters.cjs');
const { createAutomationWebhook } = require('./automation-webhook.cjs');
const { createMachineDelta, LIMITS: MACHINE_LIMITS } = require('./machine-delta.cjs');
const { createMachineGit } = require('./machine-git.cjs');
const { createMachineReceipt } = require('./machine-receipt.cjs');
const { createDebugHost } = require('./debug-host.cjs');

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
const workspaceConsent = createWorkspaceConsent({
  storageFile: path.join(app.getPath('userData'), 'workspace-consent.json')
});
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
let automationWebhook = null;
let automationWebhookWorkspaceId = null;
const mcpClients = new Map();
const mcpConsentHashes = new Set();
const previewStartGenerations = new Map();
const previewRuntime = createPreviewRuntime({
  onOutput: (output) => mainWindow?.webContents.send('preview:output', output),
  onBackendOutput: (output) => mainWindow?.webContents.send('preview:backend-output', output),
  orphansFile: path.join(app.getPath('userData'), 'preview-orphans.json')
});
const typeScriptService = createTypeScriptService({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id)
});
const machineGit = createMachineGit({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id),
  context: gitSafetyContext,
  run: (root, args, safety, input) => runGit(root, buildGitArgv(args, { safeDirectories: [root], filterDrivers: safety.filterDrivers }), input)
});
const machineDelta = createMachineDelta({
  access: workspaceAccess,
  readSystem: async (id) => ({
    git: await machineGit.read(id),
    previews: previewRuntime.ownedPreviews(id),
    terminals: [...terminalSessions].filter(([, info]) => info.workspaceId === id)
      .map(([sessionId, info]) => ({ id: sessionId, mode: info.mode, launchCwd: info.launchCwd })),
    tools: { node: process.versions.node, electron: process.versions.electron, probes: 'External tool version commands were not run.' }
  }),
  prepareGitRestore: machineGit.prepare,
  stopOwnedPreview: (id, identity) => previewRuntime.stopOwnedPreview(id, identity)
});
const proofStore = createProofStore({
  root: path.join(app.getPath('userData'), 'proof-ledgers'),
  safeStorage
});
// The per-install Ed25519 identity that signs every proof record, and the one
// writer both this file and `npm run verify:proofs` agree on.
const proofKeyring = createProofKeyring({
  dir: path.join(app.getPath('userData'), 'proof-keys'),
  safeStorage
});
const proofService = createProofService({ store: proofStore, keyring: proofKeyring });
// The DAP host owns at most one adapter child; it is torn down on workspace
// switch and on window close so no debuggee outlives the session that owns it.
const debugHost = createDebugHost({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id),
  broadcast: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('debug:event', event);
    }
  }
});
const previewConsoleErrors = createConsoleErrorSink();
const machineReceipt = createMachineReceipt({
  access: workspaceAccess,
  receiptsDir: path.join(app.getPath('userData'), 'machine-receipts'),
  getReport: (id, checkpointId) => machineDelta.inspect(id, checkpointId),
  limits: MACHINE_LIMITS
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

function installRendererCsp() {
  const csp = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'",
    "frame-ancestors 'none'", "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
    "font-src 'self' data:", "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
    "worker-src 'self' blob:"
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (rendererOrigin && details.url.startsWith(rendererOrigin)) {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      return;
    }
    callback({});
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

function hashText(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex');
}

/**
 * Append-only command receipt, in the canonical signed chain format the offline
 * verifier reads (`npm run verify:proofs`). Hashes of the output go into the
 * payload; the output itself never does.
 */
async function recordCommandProof(workspaceId, command, run) {
  try {
    const redacted = redactCommandForProof(command);
    await proofService.append(workspaceId, {
      type: run.deniedReason ? 'command.denied' : 'command.run',
      actor: 'agent',
      data: {
        argv: clipProofText(redacted),
        commandHash: hashText(redacted),
        exitCode: run.exitCode ?? null,
        stdoutHash: hashText(run.stdout),
        stderrHash: hashText(run.stderr),
        ...(run.deniedReason ? { deniedReason: clipProofText(run.deniedReason) } : {})
      }
    });
  } catch (error) {
    // A ledger write must not change the command result the user already saw.
    console.error(`[desktop] proof ledger append failed for workspace ${workspaceId}:`, error?.message ?? error);
  }
}

function clipProofText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}

async function runPreviewAssertion(workspaceId) {
  const contents = mainWindow?.webContents;
  if (!contents) return mergePreviewVerdict({ frameFound: false, detail: 'no-window' });
  let frame = null;
  try {
    const frames = contents.mainFrame?.framesInSubtree || [];
    frame = frames.find((candidate) => getPreviewWorkspaceIdForUrl(candidate.url) === workspaceId) || null;
  } catch {
    frame = null;
  }
  const consoleErrors = previewConsoleErrors.drain(workspaceId);
  if (!frame) return mergePreviewVerdict({ frameFound: false, consoleErrors, detail: 'preview-frame-not-found' });
  let html = '';
  try {
    html = await frame.executeJavaScript('document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : ""', true);
  } catch {
    html = '';
  }
  const selectors = deriveContainerSelectors(typeof html === 'string' ? html : '');
  const containerDerived = selectors.length > 0;
  try {
    const scriptResult = await frame.executeJavaScript(
      buildFrameAssertionScript(containerDerived ? selectors : ['body'], DEFAULT_SETTLE_MS),
      true
    );
    const summary = summarizeFrameResult(scriptResult);
    return mergePreviewVerdict({
      frameFound: true,
      evaluated: summary.evaluated,
      containerDerived,
      failedSelectors: summary.failedSelectors,
      warningSelectors: summary.warningSelectors,
      consoleErrors
    });
  } catch {
    return mergePreviewVerdict({
      frameFound: true,
      evaluated: false,
      containerDerived,
      consoleErrors,
      detail: 'assertion-script-did-not-evaluate'
    });
  }
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

async function createPreviewFileResponse(request, url, file, root) {
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

  // Static HTML gets the click-to-source bridge. Ranged or oversized responses
  // keep streaming: rewriting a slice would corrupt the body.
  const relativePath = path.relative(root, file.filePath).split(path.sep).join('/');
  if (
    !range &&
    (request.method || 'GET').toUpperCase() === 'GET' &&
    file.stat.size <= 2 * 1024 * 1024 &&
    shouldInject(relativePath, headers['Content-Type'])
  ) {
    try {
      const html = await fs.promises.readFile(file.filePath, 'utf8');
      const served = isHtmlDocument(relativePath, headers['Content-Type'])
        ? stripContentSecurityPolicyMeta(html)
        : html;
      const body = injectSourceBridge(served, { fileName: relativePath });
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
      return new Response(body, { status, headers });
    } catch (error) {
      console.error(`[desktop] Preview source bridge failed for ${file.filePath}:`, error);
    }
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
    if (indexFile) return createPreviewFileResponse(request, url, indexFile, root);
  }

  const file = await resolvePreviewCandidate(root, segments);
  if (file) return createPreviewFileResponse(request, url, file, root);

  const acceptsHtml = (request.headers.get('accept') || '').includes('text/html');
  if (acceptsHtml) {
    const entry = await findStaticPreviewFile(root);
    if (entry) return createPreviewFileResponse(request, url, entry, root);
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

function terminalDescriptor(sessionId, sessionInfo, workspace) {
  return {
    sessionId,
    mode: sessionInfo.mode,
    label: sessionInfo.label,
    title: path.basename(workspace.root),
    cwd: workspace.root
  };
}

function stopWorkspaceServices(workspaceId) {
  debugHost.stopWorkspace(workspaceId);
  typeScriptService.closeWorkspace(workspaceId);
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
  require('bytenode');
  const { startServer } = require(path.join(app.getAppPath(), 'server.jsc'));
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

function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function executeCommand(command, cwd) {
  return new Promise((resolve) => {
    if (/[;&|<>`$()\\\r\n]/.test(command)) {
      resolve({ stdout: '', stderr: 'Shell metacharacters are not allowed.', exitCode: 1 });
      return;
    }
    const argv = tokenizeCommand(command);
    if (argv.length === 0) {
      resolve({ stdout: '', stderr: 'Command is empty.', exitCode: 1 });
      return;
    }
    const env = resolveTerminalPlan({ mode: 'agent' }).env;
    const child = execFile(argv[0], argv.slice(1), {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env
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
function runGit(cwd, args, input) {
  return new Promise((resolve) => {
    if (!gitExecutable || !gitEnvironment) {
      resolve({ ok: false, stdout: '', stderr: 'git is unavailable on a trusted path.' });
      return;
    }
    const child = execFile(gitExecutable, args, {
      cwd,
      env: gitEnvironment,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
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
  let gitDirInsideWorkspace = false;
  if (gitDir && path.isAbsolute(gitDir)) {
    try {
      const realRoot = fs.realpathSync.native(workspaceRoot);
      const realGitDir = fs.realpathSync.native(gitDir);
      gitDirInsideWorkspace = isPathInsideDirectory(realRoot, realGitDir);
    } catch {
      gitDirInsideWorkspace = false;
    }
  }

  let drivers = [];
  let complete = false;
  if (gitDirInsideWorkspace) {
    const collected = await collectRepoFilterDrivers(gitDir);
    drivers = collected.drivers;
    complete = collected.complete;
  }

  const context = {
    complete: complete && gitDirInsideWorkspace,
    gitDirInsideWorkspace,
    filterDrivers: drivers,
    probeArgs: buildGitArgv(['rev-parse', '--is-inside-work-tree'], options),
    statusArgs: buildGitArgv(['status', '--porcelain=v1', '--branch'], { ...options, filterDrivers: drivers }),
    diffArgs: buildGitArgv(['diff', '--no-color', '--unified=2', 'HEAD'], { ...options, filterDrivers: drivers }),
    logArgs: buildGitArgv(['log', '-n', '8', '--pretty=%s'], { ...options, filterDrivers: drivers })
  };
  gitSafetyCache = { root: workspaceRoot, context };
  return context;
}

async function requireGitWorkspace(workspaceId) {
  const workspace = workspaceAccess.getWorkspace(workspaceId);
  if (!workspace || workspace.mode !== 'folder') {
    throw new Error('Source control is available only for an opened folder workspace.');
  }
  if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) {
    throw new Error('A trusted Git executable is unavailable.');
  }
  const context = await gitSafetyContext(workspace.root);
  if (!context.gitDirInsideWorkspace) throw new Error('The Git directory resolves outside the opened workspace.');
  const probe = await runGit(workspace.root, context.probeArgs);
  if (!probe.ok || probe.stdout.trim() !== 'true') throw new Error('The opened folder is not a Git repository.');
  return { workspace, context };
}

async function runGitOrThrow(cwd, args) {
  const result = await runGit(cwd, args);
  if (!result.ok) throw new Error(result.stderr.trim().slice(0, 2000) || 'Git operation failed.');
  return result.stdout;
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

/**
 * Proof-ledger IPC: the renderer's `src/lib/proofLedger.ts` is the only writer
 * of self-healing receipts, and every receipt it records is appended to the
 * signed chain here before the call resolves. Reads return the folded chain, so
 * a receipt recorded in a previous session is back in the renderer's memory on
 * the next app start.
 */
function registerProofHandlers() {
  ipcMain.handle('proof:append-receipt', async (event, receipt, kind) => {
    assertTrustedRenderer(event);
    const isUpdate = kind === 'update';
    const { record, receiptHash } = await proofService.appendReceipt(receipt, isUpdate ? 'receipt.update' : 'receipt.failure');
    return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId, receiptHash };
  });

  ipcMain.handle('proof:append-milestone', async (event, proof) => {
    assertTrustedRenderer(event);
    const record = await proofService.appendMilestone(proof);
    return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId };
  });

  ipcMain.handle('proof:receipts', (event) => {
    assertTrustedRenderer(event);
    return proofService.readReceipts(PROOF_APP_SCOPE);
  });

  ipcMain.handle('proof:records', (event, workspaceId) => {
    assertTrustedRenderer(event);
    const target = typeof workspaceId === 'string' && workspaceId ? workspaceId : PROOF_APP_SCOPE;
    return proofService.readRecords(target);
  });

  ipcMain.handle('proof:verify', (event, workspaceId) => {
    assertTrustedRenderer(event);
    const target =
      typeof workspaceId === 'string' && workspaceId
        ? workspaceId
        : activeWorkspaceId && workspaceAccess.getWorkspace(activeWorkspaceId)
          ? activeWorkspaceId
          : PROOF_APP_SCOPE;
    return proofService.verify(target);
  });
}

/**
 * Debugger IPC. Every handler pins the caller to the main frame of the app's
 * own origin, exactly like the proof and terminal handlers. The host validates
 * `shadrox.debug.json` itself; this layer only moves values.
 */
function registerDebugHandlers() {
  ipcMain.handle('debug:config', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.configs(workspaceId);
  });

  ipcMain.handle('debug:start', async (event, workspaceId, configName) => {
    assertTrustedRenderer(event);
    return debugHost.start(
      workspaceId,
      typeof configName === 'string' ? configName : undefined,
      async ({ command, args, cwd }) => {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Cancel', 'Start debugger'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Approve external debug adapter',
          message: 'This workspace wants to start an external debug adapter.',
          detail: `Command: ${command}\nArguments: ${args.join(' ') || '(none)'}\nDirectory: ${cwd}`
        });
        return choice.response === 1;
      },
      [app.getAppPath()]
    );
  });

  ipcMain.handle('debug:stop', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    await debugHost.stop(workspaceId);
  });

  ipcMain.handle('debug:breakpoints', async (event, workspaceId, file, lines) => {
    assertTrustedRenderer(event);
    return debugHost.setBreakpoints(workspaceId, file, lines);
  });

  ipcMain.handle('debug:threads', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.threads(workspaceId);
  });

  ipcMain.handle('debug:stack', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.stack(workspaceId);
  });

  ipcMain.handle('debug:scopes', (event, workspaceId, frameId) => {
    assertTrustedRenderer(event);
    return debugHost.scopes(workspaceId, frameId);
  });

  ipcMain.handle('debug:variables', (event, workspaceId, variablesReference) => {
    assertTrustedRenderer(event);
    return debugHost.variables(workspaceId, variablesReference);
  });

  ipcMain.handle('debug:evaluate', (event, workspaceId, frameId, expression) => {
    assertTrustedRenderer(event);
    return debugHost.evaluate(workspaceId, frameId, expression);
  });

  ipcMain.handle('debug:continue', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.continue(workspaceId, threadId);
  });

  ipcMain.handle('debug:next', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.next(workspaceId, threadId);
  });

  ipcMain.handle('debug:step-in', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.stepIn(workspaceId, threadId);
  });

  ipcMain.handle('debug:step-out', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.stepOut(workspaceId, threadId);
  });

  ipcMain.handle('debug:pause', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.pause(workspaceId, threadId);
  });

  ipcMain.handle('debug:state', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.state(workspaceId);
  });
}

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

const MCP_MAX_SERVERS = 20;
const MCP_NAME_MAX = 120;
const MCP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_ARGS_PREVIEW_MAX = 1500;

function mcpServersPath() {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

function readMcpServerRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpServersPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((record) => record && typeof record === 'object' && !Array.isArray(record) && typeof record.id === 'string')
      .slice(0, MCP_MAX_SERVERS);
  } catch {
    return [];
  }
}

function writeMcpServerRecords(records) {
  const file = mcpServersPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records.slice(0, MCP_MAX_SERVERS)), { encoding: 'utf8', mode: 0o600 });
}

/** Secret values are only ever decrypted to hand back to the trusted renderer. */
function decryptMcpValue(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || typeof entry.cipher !== 'string') return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
  } catch {
    // A value encrypted under another OS profile cannot be recovered.
    return '';
  }
}

function decryptMcpMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) result[key] = decryptMcpValue(entry);
  return result;
}

/**
 * Env/header values are the only secret material in an MCP config. When OS
 * encryption is unavailable callers have already refused non-empty values, so
 * empty strings can be stored as-is without weakening anything.
 */
function encryptMcpMap(value) {
  const result = {};
  const available = safeStorage.isEncryptionAvailable();
  for (const [key, entry] of Object.entries(value || {})) {
    result[key] = available && entry
      ? { cipher: safeStorage.encryptString(entry).toString('base64') }
      : '';
  }
  return result;
}

/**
 * The renderer only needs key names to edit a server; secret values never
 * leave the main process. `includeSecrets` is reserved for the client factory.
 */
function mcpRecordToConfig(record, index, includeSecrets = false) {
  const transport = record.transport === 'http' ? 'http' : 'stdio';
  const config = {
    id: typeof record.id === 'string' ? record.id : `server-${index}`,
    name: typeof record.name === 'string' ? record.name.slice(0, MCP_NAME_MAX) : '',
    transport,
    enabled: record.enabled !== false
  };
  if (transport === 'stdio') {
    config.command = typeof record.command === 'string' ? record.command : '';
    config.args = Array.isArray(record.args) ? record.args.filter((arg) => typeof arg === 'string') : [];
    const env = includeSecrets ? decryptMcpMap(record.env) : {};
    if (!includeSecrets) {
      for (const key of Object.keys(record.env || {})) env[key] = '';
    }
    config.env = env;
  } else {
    config.url = typeof record.url === 'string' ? record.url : '';
    const headers = includeSecrets ? decryptMcpMap(record.headers) : {};
    if (!includeSecrets) {
      for (const key of Object.keys(record.headers || {})) headers[key] = '';
    }
    config.headers = headers;
  }
  return config;
}

function listMcpServerConfigs() {
  return readMcpServerRecords().map((record, index) => mcpRecordToConfig(record, index));
}

function findMcpServerConfig(id) {
  if (typeof id !== 'string') return null;
  const records = readMcpServerRecords();
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) return null;
  return mcpRecordToConfig(records[index], index, true);
}

function saveMcpServerConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('An MCP server configuration is required.');
  }
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!MCP_ID_PATTERN.test(id)) {
    throw new Error('MCP server ids must be 1-64 characters of letters, digits, dots, dashes, or underscores, starting with a letter or digit.');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MCP_NAME_MAX) {
    throw new Error(`MCP server names must be between 1 and ${MCP_NAME_MAX} characters.`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('MCP server enabled must be a boolean.');
  }
  if (input.transport !== 'stdio' && input.transport !== 'http') {
    throw new Error('MCP server transport must be "stdio" or "http".');
  }
  if (input.transport === 'http' && !isSafeHttpUrl(input.url)) {
    throw new Error('MCP HTTP servers need an absolute http(s) URL without embedded credentials.');
  }

  const records = readMcpServerRecords();
  const existingIndex = records.findIndex((record) => record.id === id);
  const previous = existingIndex >= 0 ? records[existingIndex] : null;

  // The renderer never receives stored secret values, so a blank field means
  // "keep what is already saved"; removing the key is how a secret is deleted.
  const mergeSecrets = (values, encrypted) => {
    const merged = { ...(values || {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === '' && encrypted && encrypted[key]) {
        const stored = decryptMcpValue(encrypted[key]);
        if (stored) merged[key] = stored;
      }
    }
    return merged;
  };

  const normalized = validateServerConfig({
    name,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: mergeSecrets(input.env, previous?.env),
    url: input.url,
    headers: mergeSecrets(input.headers, previous?.headers)
  });
  const secretValues = normalized.transport === 'stdio'
    ? Object.values(normalized.env).filter(Boolean)
    : Object.values(normalized.headers).filter(Boolean);
  if (secretValues.length > 0 && !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is unavailable on this system, so ShadRox cannot save MCP environment variables or header ' +
      'values. Remove them and save the server again once OS encryption is available.'
    );
  }

  if (existingIndex === -1 && records.length >= MCP_MAX_SERVERS) {
    throw new Error(`ShadRox supports at most ${MCP_MAX_SERVERS} MCP servers. Delete one before adding another.`);
  }

  const record = { id, name: normalized.name || name, transport: normalized.transport, enabled: input.enabled !== false };
  if (normalized.transport === 'stdio') {
    record.command = normalized.command;
    record.args = normalized.args;
    record.env = encryptMcpMap(normalized.env);
  } else {
    record.url = normalized.url;
    record.headers = encryptMcpMap(normalized.headers);
  }
  if (existingIndex === -1) records.push(record);
  else records[existingIndex] = record;
  writeMcpServerRecords(records);

  // A changed configuration must not keep the previous session alive.
  void closeMcpClient(id);
  return listMcpServerConfigs();
}

function closeMcpClient(id) {
  const client = mcpClients.get(id);
  if (!client) return Promise.resolve(false);
  mcpClients.delete(id);
  return client.close().then(() => true, () => false);
}

function stringifyToolArguments(toolArguments) {
  let text;
  try {
    text = JSON.stringify(toolArguments ?? {}, null, 2);
  } catch {
    text = String(toolArguments);
  }
  return truncateText(text || '{}', MCP_ARGS_PREVIEW_MAX);
}

async function approveMcpToolCall(server, toolName, toolArguments) {
  // Main owns this approval: the renderer can request a call but cannot answer
  // the prompt on the user's behalf.
  const detail = truncateText([
    `Server: ${server.name} (${server.id})`,
    `Tool: ${toolName}`,
    `Arguments: ${stringifyToolArguments(toolArguments)}`,
    'MCP tools run with the permissions of the configured server and can read workspace data or perform actions.'
  ].join('\n\n'), 2200);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Allow MCP tool call?',
    message: `Allow "${toolName}" on ${server.name}?`,
    detail,
    buttons: ['Cancel', 'Allow tool call'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return confirmation.response === 1;
}

function getMcpClient(server) {
  const existing = mcpClients.get(server.id);
  if (existing) return existing;
  const client = createMcpClient({
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    onApproveTool: ({ name, arguments: toolArguments }) => approveMcpToolCall(server, name, toolArguments),
    // Server stderr can contain tokens; it is never logged or forwarded.
    onStderr: () => {}
  });
  mcpClients.set(server.id, client);
  return client;
}

async function listMcpToolsFor(serverId) {
  const server = findMcpServerConfig(serverId);
  if (!server) throw new Error('That MCP server is not configured.');
  if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
  const client = getMcpClient(server);
  try {
    const tools = await client.listTools();
    return tools.map((tool) => ({
      serverId: server.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  } catch (error) {
    // A failed handshake should not leave a half-open client in the map.
    await closeMcpClient(server.id);
    throw error;
  }
}

function mcpToolResultText(result, toolName) {
  const items = Array.isArray(result.content) ? result.content : [];
  const texts = items
    .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  if (texts.length > 0) return texts.join('\n');
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return '';
    }
  }
  return result.isError ? `The MCP tool "${toolName}" reported an error without text.` : '';
}

const PLUGIN_SCAN_MAX_FILES = 50;
const PLUGIN_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Reads only `<root>/.shadrox/plugins/<folder>/plugin.json`. The folder list is
 * never walked recursively and every resolved manifest must stay inside both
 * the workspace and the plugins directory, so a symlinked folder or file
 * cannot leak content from outside the project.
 */
async function scanWorkspacePlugins(workspace) {
  const files = [];
  const errors = [];
  if (!workspace?.root) {
    errors.push('Plugins require an opened workspace.');
    return { files, errors };
  }
  const root = workspace.root;
  const pluginsRoot = path.join(root, '.shadrox', 'plugins');

  let realPluginsRoot;
  try {
    realPluginsRoot = await fs.promises.realpath(pluginsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { files, errors };
    errors.push(`The plugins folder could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { files, errors };
  }
  if (!isPathInsideDirectory(root, realPluginsRoot)) {
    errors.push('The plugins folder resolves outside the opened workspace.');
    return { files, errors };
  }

  let entries;
  try {
    entries = await fs.promises.readdir(realPluginsRoot, { withFileTypes: true });
  } catch (error) {
    errors.push(`The plugins folder could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { files, errors };
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (directories.length > PLUGIN_SCAN_MAX_FILES) {
    errors.push(`Only the first ${PLUGIN_SCAN_MAX_FILES} plugin folders were scanned.`);
  }

  for (const entry of directories.slice(0, PLUGIN_SCAN_MAX_FILES)) {
    const manifestPath = path.join(realPluginsRoot, entry.name, 'plugin.json');
    const relative = path.relative(root, manifestPath).split(path.sep).join('/');
    try {
      const realManifest = await fs.promises.realpath(manifestPath);
      if (!isPathInsideDirectory(root, realManifest) || !isPathInsideDirectory(realPluginsRoot, realManifest)) {
        errors.push(`${relative}: resolves outside the workspace plugins folder.`);
        continue;
      }
      const stat = await fs.promises.stat(realManifest);
      if (!stat.isFile()) {
        errors.push(`${relative}: plugin.json is not a file.`);
        continue;
      }
      if (stat.size > PLUGIN_MANIFEST_MAX_BYTES) {
        errors.push(`${relative}: plugin.json exceeds the 256 KB limit.`);
        continue;
      }
      files.push({ path: relative, content: await fs.promises.readFile(realManifest, 'utf8') });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      errors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { files, errors };
}

const RUNTIME_MANIFEST_NAMES = new Set([
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'composer.json'
]);
const RUNTIME_WALK_IGNORES = new Set([
  '.git', 'node_modules', 'dist', 'dist_staging', 'dist_desktop', 'build', 'out', '.next', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__', '.shadrox'
]);
const RUNTIME_MAX_FILES = 5000;
const RUNTIME_MAX_DIRECTORIES = 2000;
const RUNTIME_MAX_DEPTH = 4;
const RUNTIME_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Bounded workspace walk used only to feed the pure runtime adapters. Manifests
 * are read here (in main) so the adapters never touch the disk, and the result
 * is capped at depth 4 / 5000 files.
 */
async function collectRuntimeWorkspace(root) {
  const files = [];
  const manifests = new Map();
  const errors = [];
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch (error) {
    errors.push(`Workspace root could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { files, manifests, errors };
  }

  const queue = [{ directory: realRoot, depth: 0 }];
  let fileCount = 0;
  let directoryCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
    } catch {
      errors.push(`Could not scan ${path.relative(realRoot, current.directory).split(path.sep).join('/') || '.'}.`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (RUNTIME_WALK_IGNORES.has(entry.name.toLowerCase())) continue;
        if (current.depth >= RUNTIME_MAX_DEPTH) continue;
        if (directoryCount >= RUNTIME_MAX_DIRECTORIES) continue;
        directoryCount += 1;
        queue.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileCount >= RUNTIME_MAX_FILES) break;
      fileCount += 1;
      const relative = path.relative(realRoot, absolute).split(path.sep).join('/');
      files.push(relative);
      if (!RUNTIME_MANIFEST_NAMES.has(entry.name.toLowerCase())) continue;
      try {
        const stat = await fs.promises.stat(absolute);
        if (stat.size > RUNTIME_MANIFEST_MAX_BYTES) {
          errors.push(`${relative} exceeds the 256 KB manifest limit and was skipped.`);
          continue;
        }
        manifests.set(relative, await fs.promises.readFile(absolute, 'utf8'));
      } catch (error) {
        errors.push(`${relative} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fileCount >= RUNTIME_MAX_FILES) break;
  }
  if (fileCount >= RUNTIME_MAX_FILES) {
    errors.push(`Runtime detection stopped after scanning ${RUNTIME_MAX_FILES} files. Open the intended project subfolder directly.`);
  }

  return { files, manifests, errors };
}

async function detectWorkspaceRuntimes(workspace) {
  const collected = await collectRuntimeWorkspace(workspace.root);
  const planned = planDualPreview({
    rootFiles: collected.files,
    manifests: collected.manifests
  });
  return {
    plans: planned.previews,
    errors: [...collected.errors, ...planned.errors]
  };
}

function getAutomationWebhook() {
  if (!automationWebhook) {
    automationWebhook = createAutomationWebhook({
      getRoot: () => {
        const workspace = automationWebhookWorkspaceId
          ? workspaceAccess.getWorkspace(automationWebhookWorkspaceId)
          : null;
        return workspace?.root ?? null;
      },
      onTrigger: (trigger) => {
        // Main never runs the action; the renderer applies its normal gates.
        mainWindow?.webContents.send('automation:trigger', trigger);
      }
    });
  }
  return automationWebhook;
}

const AUTH_CALLBACK_PATH = '/auth/callback';const AUTH_TIMEOUT_MS = 180_000;
let pendingAuthSignIn = null;

function authCallbackPage(heading, detail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShadRox</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0b0b0f; color: #ececf1;
         font-family: "Segoe UI", system-ui, sans-serif; }
  main { text-align: center; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #a1a1aa; font-size: 14px; }
</style></head><body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`;
}

/** The browser owns the foreground after OAuth, so pull ShadRox back in front. */
function bringMainWindowForward() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  app.focus({ steal: true });
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
  } else {
    mainWindow.focus();
  }
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
        response.end(
          authCallbackPage(
            failed ? 'Sign-in was not completed' : 'Signed in',
            failed ? 'Return to ShadRox and try again.' : 'ShadRox is opening now. You can close this tab.'
          )
        );
        bringMainWindowForward();
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
  const opened = await workspaceAccess.openFolder(rootPath);
  try {
    await workspaceConsent.grantFolder(opened.rootPath);
    await previewRuntime.stopAll();
  } catch (error) {
    workspaceAccess.closeWorkspace(opened.workspaceId);
    throw error;
  }
  const previousWorkspaceId = activeWorkspaceId;
  if (previousWorkspaceId) {
    stopWorkspaceServices(previousWorkspaceId);
    workspaceAccess.closeWorkspace(previousWorkspaceId);
  }
  activeWorkspaceId = opened.workspaceId;
  watchWorkspace(opened.workspaceId, workspaceAccess.getWorkspace(opened.workspaceId).root);
  return opened;
}

let machineSensitiveOperations = 0;
function handleMachineSensitive(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    machineDelta.assertWritable();
    machineSensitiveOperations++;
    try { return await handler(...args); }
    finally { machineSensitiveOperations--; }
  });
}

function registerIpcHandlers() {
  handleMachineSensitive('workspace:open-folder', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open workspace folder',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openFolderWorkspace(result.filePaths[0]);
  });

  handleMachineSensitive('workspace:open-files', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open code files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Code and text files', extensions: ['*'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const previousWorkspaceId = activeWorkspaceId;
    const opened = await workspaceAccess.openFiles(result.filePaths);
    if (!opened) return null;
    try {
      await workspaceConsent.grantFiles(opened.filePaths);
      await previewRuntime.stopAll();
    } catch (error) {
      workspaceAccess.closeWorkspace(opened.workspaceId);
      throw error;
    }
    if (previousWorkspaceId) {
      stopWorkspaceServices(previousWorkspaceId);
      workspaceAccess.closeWorkspace(previousWorkspaceId);
    }
    activeWorkspaceId = opened.workspaceId;
    return opened;
  });

  handleMachineSensitive('workspace:reopen', async (event, target) => {
    assertTrustedRenderer(event);
    if (!target || typeof target !== 'object') throw new Error('Invalid recent workspace.');

    if (target.kind === 'folder') {
      if (typeof target.path !== 'string' || target.path.length === 0) {
        throw new Error('This recent folder has no stored location.');
      }
      const selectedPath = await resolveFolderReopen(target.path, workspaceConsent, () =>
        dialog.showOpenDialog(mainWindow, {
          title: 'Select a workspace folder to reopen',
          properties: ['openDirectory']
        })
      );
      if (!selectedPath) return null;
      return openFolderWorkspace(selectedPath);
    }

    if (target.kind === 'file') {
      const filePaths = Array.isArray(target.filePaths)
        ? target.filePaths.filter((entry) => typeof entry === 'string' && entry.length > 0)
        : [];
      if (filePaths.length === 0) throw new Error('This recent entry has no stored file paths.');
      const selectedPaths = await resolveFileReopen(filePaths, workspaceConsent, () =>
        dialog.showOpenDialog(mainWindow, {
          title: 'Select code files to reopen',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Code and text files', extensions: ['*'] }]
        })
      );
      if (!selectedPaths) return null;
      for (const filePath of selectedPaths) {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`${path.basename(filePath)} no longer exists.`);
      }
      const previousWorkspaceId = activeWorkspaceId;
      const opened = await workspaceAccess.openFiles(selectedPaths);
      if (!opened) throw new Error('Those files could not be reopened.');
      try {
        await workspaceConsent.grantFiles(opened.filePaths);
        await previewRuntime.stopAll();
      } catch (error) {
        workspaceAccess.closeWorkspace(opened.workspaceId);
        throw error;
      }
      if (previousWorkspaceId) {
        stopWorkspaceServices(previousWorkspaceId);
        workspaceAccess.closeWorkspace(previousWorkspaceId);
      }
      activeWorkspaceId = opened.workspaceId;
      return opened;
    }

    throw new Error('Unknown recent workspace type.');
  });

  handleMachineSensitive('workspace:close', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (workspaceAccess.getWorkspace(workspaceId)) {
      await previewRuntime.stop(workspaceId);
      stopWorkspaceServices(workspaceId);
      workspaceAccess.closeWorkspace(workspaceId);
    }
    if (activeWorkspaceId === workspaceId) activeWorkspaceId = null;
  });

  ipcMain.handle('machine:begin', async (event, workspaceId, checkpointId) => {
    assertTrustedRenderer(event);
    return machineDelta.begin(workspaceId, checkpointId);
  });
  ipcMain.handle('machine:finish', async (event, workspaceId, checkpointId) => {
    assertTrustedRenderer(event);
    return machineDelta.finish(workspaceId, checkpointId);
  });
  ipcMain.handle('machine:inspect', (event, workspaceId, checkpointId) => {
    assertTrustedRenderer(event);
    return machineDelta.inspect(workspaceId, checkpointId);
  });
  handleMachineSensitive('machine:export-receipt', async (event, workspaceId, checkpointId) => {
    assertTrustedRenderer(event);
    return machineReceipt.exportReceipt(workspaceId, checkpointId);
  });
  handleMachineSensitive('machine:verify-receipt', async (event, workspaceId, receiptId) => {
    assertTrustedRenderer(event);
    return machineReceipt.verifyReceipt(workspaceId, receiptId);
  });
  ipcMain.handle('machine:restore', async (event, workspaceId, checkpointId) => {
    assertTrustedRenderer(event);
    if (rendererDirty) throw new Error('Save or discard unsaved editor changes before machine rewind.');
    if (machineSensitiveOperations) throw new Error('Wait for workspace commands and operations to finish before rewind.');
    return machineDelta.restore(workspaceId, checkpointId, async (report) => {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Rewind captured machine changes?',
        message: `Restore ${report.files.length} captured files${report.git.positionChanged ? ', rewind the local Git ref/index' : ''} and stop ${report.previews.started.length} ShadRox-owned previews?`,
        detail: 'This is not a full-machine restore. Installed packages, running terminals, stopped processes and remote effects are not undone. Stop other commands that may write to these files before continuing.',
        buttons: ['Cancel', 'Rewind captured changes'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (rendererDirty) throw new Error('Unsaved editor changes appeared; nothing was restored.');
      return answer.response === 1;
    });
  });

  ipcMain.handle('app:set-dirty', (event, dirty) => {
    assertTrustedRenderer(event);
    rendererDirty = Boolean(dirty);
  });

  handleMachineSensitive('workspace:list-directory', async (event, workspaceId, relativePath, cursor) => {
    assertTrustedRenderer(event);
    return workspaceAccess.listDirectory(workspaceId, relativePath, cursor);
  });

  handleMachineSensitive('workspace:read-file', async (event, workspaceId, relativePath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.readFile(workspaceId, relativePath);
  });

  handleMachineSensitive('workspace:load-files', async (event, workspaceId, relativePaths, options) => {
    assertTrustedRenderer(event);
    return workspaceAccess.loadFiles(workspaceId, relativePaths, options);
  });

  handleMachineSensitive('workspace:project-docs', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return workspaceAccess.projectDocs(workspaceId);
  });

  handleMachineSensitive('workspace:rename-file', async (event, workspaceId, fromPath, toPath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.renameFile(workspaceId, fromPath, toPath);
  });

  handleMachineSensitive('workspace:create-directory', async (event, workspaceId, relativePath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.createDirectory(workspaceId, relativePath);
  });

  handleMachineSensitive('workspace:delete-path', async (event, workspaceId, relativePath) => {
    assertTrustedRenderer(event);
    return workspaceAccess.deletePath(workspaceId, relativePath);
  });

  handleMachineSensitive('workspace:search-files', async (event, workspaceId, query, limit) => {
    assertTrustedRenderer(event);
    return workspaceAccess.searchFiles(workspaceId, query, limit);
  });

  handleMachineSensitive('workspace:search-content', async (event, workspaceId, options) => {
    assertTrustedRenderer(event);
    return workspaceAccess.searchContent(workspaceId, options);
  });

  handleMachineSensitive('workspace:save-files', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    return workspaceAccess.saveFiles(workspaceId, files);
  });

  handleMachineSensitive('workspace:stage-files', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    return workspaceAccess.stageFiles(workspaceId, files);
  });

  handleMachineSensitive('workspace:commit', async (event, workspaceId, transactionId) => {
    assertTrustedRenderer(event);
    return workspaceAccess.commitTransaction(workspaceId, transactionId);
  });

  handleMachineSensitive('workspace:discard', async (event, workspaceId, transactionId) => {
    assertTrustedRenderer(event);
    workspaceAccess.discardTransaction(workspaceId, transactionId);
  });

  handleMachineSensitive('workspace:verify-change-set', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    // A file-only workspace is rooted at its containing directory and saveFiles
    // already refuses paths outside it, so the same root is a valid boundary here.
    if (!workspace?.root) {
      throw new Error('Change verification requires an opened workspace.');
    }
    return verifyChangeSet({ root: workspace.root, files });
  });

  // The dock can hold several tabs per workspace, so main no longer decides how
  // many shells exist; the renderer's tab key is the map key. The cap is only a
  // process-count guard against a runaway renderer.
  const maxTerminalSessionsPerWorkspace = 12;

  handleMachineSensitive('terminal:create', async (event, workspaceId, cols = 100, rows = 30, mode = 'system', sessionKey) => {
    assertTrustedRenderer(event);
    if (!pty) throw new Error('Interactive terminal support is unavailable. Reinstall the desktop dependencies and restart ShadRox.');
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace) throw new Error('The terminal needs an opened workspace.');
    const requestedMode = mode === 'agent' ? 'agent' : 'system';

    const requestedKey = normalizeTerminalSessionKey(sessionKey);
    if (requestedKey) {
      const owned = terminalSessions.get(requestedKey);
      // Re-mounting a tab reattaches to its shell instead of spawning a second one.
      if (owned) {
        if (owned.workspaceId !== workspaceId) throw new Error('That terminal session belongs to another workspace.');
        if (owned.mode !== requestedMode) throw new Error('That terminal session already runs in another mode.');
        return terminalDescriptor(requestedKey, owned, workspace);
      }
    } else {
      const existing = [...terminalSessions].find(([, info]) => info.workspaceId === workspaceId && info.mode === requestedMode);
      if (existing) return terminalDescriptor(existing[0], existing[1], workspace);
    }

    const ownedCount = [...terminalSessions.values()].filter((info) => info.workspaceId === workspaceId).length;
    if (ownedCount >= maxTerminalSessionsPerWorkspace) {
      throw new Error(`A workspace can hold ${maxTerminalSessionsPerWorkspace} terminal sessions. Close a tab first.`);
    }

    const plan = resolveTerminalPlan({ env: process.env, mode: requestedMode });
    const sessionId = requestedKey ?? randomUUID();
    const size = clampTerminalSize(cols, rows);
    const terminalEnv = requestedMode === 'agent' ? plan.env : systemEnvironment(plan.env);
    const integrated = applyShellIntegration({ ...plan, env: terminalEnv });
    const terminal = pty.spawn(integrated.shellPath, integrated.shellArgs, {
      name: 'xterm-256color', cols: size.cols, rows: size.rows,
      cwd: workspace.root, env: { ...integrated.env, TERM: 'xterm-256color' }, useConpty: process.platform === 'win32',
      windowsHide: true
    });
    const sessionInfo = { workspaceId, mode: plan.mode, label: plan.label, launchCwd: workspace.root, terminal };
    terminalSessions.set(sessionId, sessionInfo);
    terminal.onData((data) => mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'data', data }));
    terminal.onExit(({ exitCode }) => {
      terminalSessions.delete(sessionId);
      mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'exit', exitCode });
    });
    return terminalDescriptor(sessionId, sessionInfo, workspace);
  });

  handleMachineSensitive('terminal:write', async (event, workspaceId, sessionId, data) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId || typeof data !== 'string' || data.length > 64_000) throw new Error('Invalid terminal session or input.');
    sessionInfo.terminal.write(data);
  });

  handleMachineSensitive('terminal:resize', async (event, workspaceId, sessionId, cols, rows) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) throw new Error('Invalid terminal session.');
    const size = clampTerminalSize(cols, rows);
    sessionInfo.terminal.resize(size.cols, size.rows);
  });

  handleMachineSensitive('terminal:close', async (event, workspaceId, sessionId) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) return;
    terminalSessions.delete(sessionId);
    sessionInfo.terminal.kill();
  });

  handleMachineSensitive('terminal:list-sessions', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    const sessions = [];
    for (const [sessionId, sessionInfo] of terminalSessions) {
      if (sessionInfo.workspaceId !== workspaceId) continue;
      sessions.push(
        workspace
          ? terminalDescriptor(sessionId, sessionInfo, workspace)
          : { sessionId, mode: sessionInfo.mode, label: sessionInfo.label }
      );
    }
    return sessions;
  });

  // A terminal log line is the one place a URL is clicked, and it comes from
  // whatever a command printed, so this is the only path to shell.openExternal
  // from the terminal and it accepts a bare http(s) URL.
  handleMachineSensitive('terminal:open-link', async (event, url) => {
    assertTrustedRenderer(event);
    if (!isSafeExternalUrl(url)) throw new Error('Only an http or https link can be opened externally.');
    await shell.openExternal(url);
    return true;
  });

  handleMachineSensitive('preview:start', async (event, workspaceId, approval = {}) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Local project preview requires an opened folder workspace.');
    }
    const generation = (previewStartGenerations.get(workspaceId) ?? 0) + 1;
    previewStartGenerations.set(workspaceId, generation);
    const assertCurrentStart = () => {
      if (previewStartGenerations.get(workspaceId) !== generation) {
        throw new Error('Local preview startup was cancelled.');
      }
    };

    const reportStatus = (message) => {
      mainWindow?.webContents.send('preview:output', { workspaceId, type: 'status', message });
    };
    reportStatus(`Checking ${path.basename(workspace.root)} for a runnable web project...`);

    const projects = await findPreviewProjects(workspace.root);
    assertCurrentStart();
    if (projects.length === 0) {
      const staticProjects = await findStaticPreviewProjects(workspace.root);
      assertCurrentStart();
      if (approval.projectKind === 'static' && approval.projectPath) {
        const selected = staticProjects.find((candidate) => candidate.relativePath === approval.projectPath);
        if (!selected) throw new Error('The selected static folder no longer contains an index.html file. Scan the workspace again.');
        const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus, selected.root);
        assertCurrentStart();
        return result;
      }
      if (approval.projectPath || approval.approved) throw new Error('The selected project no longer has a supported preview entry. Scan the workspace again before previewing.');
      if (staticProjects.length > 1) {
        reportStatus(`No runnable package script found. Found ${staticProjects.length} static site folders; choose which one to preview.`);
        return { status: 'selection-required', projects: staticProjects.map(({ relativePath }) => ({ kind: 'static', projectPath: relativePath })) };
      }
      if (staticProjects.length === 1) {
        reportStatus('No runnable package script found. Streaming the detected static website through shadrox-preview...');
        const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus, staticProjects[0].root);
        assertCurrentStart();
        return result;
      }
      reportStatus('No runnable package script or nested index.html found. Checking supported static entry folders...');
      const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus);
      assertCurrentStart();
      return result;
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
      assertCurrentStart();
      reportStatus(`Found ${choices.length} runnable web project folders. Choose which one to preview.`);
      return { status: 'selection-required', projects: choices };
    }
    const { manifest } = project;
    const script = getPreviewScript(manifest);

    const manager = getPackageManager(manifest, project.root);
    const missingDependencies = await findMissingDependencies(manifest, project.root);
    assertCurrentStart();
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
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Run preview'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Approve project preview',
        message: 'This project preview may install dependencies and run its dev script.',
        detail: `${installNotice}\n\nCommand:\n${script.command}\n\nProject:\n${relativeProjectPath}`
      });
      if (choice.response !== 1) return { status: 'approval-required', approval: request };
      reportStatus(
        `Detected ${relativeProjectPath}: "${manager} run ${script.name}" (${script.command}). ` +
        `${installNotice} Starting after approval.`
      );
      approval = { ...request, approved: true };
    }
    if (approval.manifestHash !== project.manifestHash) {
      throw new Error('The project package.json changed while awaiting approval. Review the detected command and try again.');
    }
    reportStatus(
      `Detected a runnable project in ${path.relative(workspace.root, project.root) || '.'}. ` +
      `Starting "${manager} run ${script.name}". ${installNotice}`
    );
    return previewRuntime.start(workspaceId, project.root, project.manifestHash);
  });

  handleMachineSensitive('preview:stop', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    previewStartGenerations.set(workspaceId, (previewStartGenerations.get(workspaceId) ?? 0) + 1);
    return previewRuntime.stop(workspaceId);
  });

  handleMachineSensitive('preview:assert', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return mergePreviewVerdict({ frameFound: false, detail: 'missing-workspace' });
    }
    return runPreviewAssertion(workspaceId);
  });

  // The preview is an iframe in this window, so a screenshot is a pixel grab of
  // the region the renderer measured. An omitted rect means "the whole frame as
  // it is visible", which is what the toolbar button asks for.
  handleMachineSensitive('preview:capture-page', async (event, rect) => {
    assertTrustedRenderer(event);
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win) return { ok: false, error: 'No ShadRox window is open.' };
    let bounds = null;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
      bounds = {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.min(8192, Math.max(1, Math.round(rect.width))),
        height: Math.min(8192, Math.max(1, Math.round(rect.height)))
      };
    }
    try {
      const image = bounds ? await win.capturePage(bounds) : await win.capturePage();
      if (image.isEmpty()) return { ok: false, error: 'Nothing is painting in that area yet.' };
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handleMachineSensitive('preview:save-screenshot', async (event, dataUrl) => {
    assertTrustedRenderer(event);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('Only a PNG data URL can be saved.');
    }
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (buffer.length === 0 || buffer.length > 32 * 1024 * 1024) throw new Error('That screenshot is not savable.');
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const choice = await dialog.showSaveDialog({
      window: win ?? undefined,
      title: 'Save preview screenshot',
      defaultPath: `shadrox-preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(choice.filePath, buffer);
    return { ok: true, path: choice.filePath };
  });

  handleMachineSensitive('terminal:run-command', async (event, workspaceId, command) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Terminal commands are available only for an opened folder workspace.');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > 5000) {
      throw new Error('Enter a command between 1 and 5000 characters.');
    }

    const started = Date.now();
    const approval = await runWithCommandApproval({
      workspaceId,
      command,
      workspace,
      showApproval: async ({ command: approvedCommand, cwd }) => {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Block command', 'Run once'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Approve command execution',
          message: 'An agent or workspace action is requesting a shell command.',
          detail: `Review the exact command and working directory. Commands can read, modify, or execute files in this workspace.\n\n${approvedCommand}\n\nWorking directory:\n${cwd}`
        });
        return choice.response === 1;
      },
      getWorkspace: (id) => workspaceAccess.getWorkspace(id),
      runCommand: executeCommand,
      allowVerifyAllowlist: false
    });
    const run = approval.approved
      ? approval.result
      : { stdout: '', stderr: approval.reason, exitCode: 1, deniedReason: approval.reason };
    mainWindow?.webContents.send('terminal:run', {
      workspaceId,
      command,
      ...run,
      exitCode: run.exitCode,
      durationMs: Date.now() - started
    });
    await recordCommandProof(workspaceId, command, run);
    return run;
  });

  handleMachineSensitive('git:read', async (event, workspaceId) => {
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

  handleMachineSensitive('git:conflicts', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') return { isRepo: false, paths: [] };
    if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) return { isRepo: false, paths: [] };

    const context = await gitSafetyContext(workspace.root);
    const probe = await runGit(workspace.root, context.probeArgs);
    if (!probe.ok || probe.stdout.trim() !== 'true') return { isRepo: false, paths: [] };

    // Index-only reads: no working-tree conversion, so no filter drivers apply.
    const runIndex = (argv) =>
      runGit(workspace.root, buildGitArgv(argv, { safeDirectories: [workspace.root] }));
    try {
      return { isRepo: true, paths: await listUnmergedPaths(runIndex) };
    } catch {
      return { isRepo: true, paths: [] };
    }
  });

  handleMachineSensitive('git:scm-read', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const { workspace, context } = await requireGitWorkspace(workspaceId);
    if (!context.complete) {
      throw new Error('Git filter configuration could not be verified, so working-tree status is unavailable.');
    }
    const options = { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] };
    const [status, branches] = await Promise.all([
      runGitOrThrow(workspace.root, buildGitArgv(
        ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
        { filterDrivers: options.filterDrivers, safeDirectories: options.safeDirectories }
      )),
      runGitOrThrow(workspace.root, buildGitArgv(
        ['branch', '-v', '--no-abbrev', '--no-color'],
        { safeDirectories: options.safeDirectories }
      ))
    ]);
    return {
      ...parseGitStatus(status),
      branches: parseGitBranches(branches)
    };
  });

  handleMachineSensitive('git:stage', async (event, workspaceId, rawPaths) => {
    assertTrustedRenderer(event);
    const { workspace, context } = await requireGitWorkspace(workspaceId);
    if (!context.complete) throw new Error('Git filter configuration could not be verified; staging is disabled.');
    const paths = validateGitPaths(rawPaths);
    await runGitOrThrow(workspace.root, buildGitArgv(
      ['add', '--', ...paths],
      { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] }
    ));
    return true;
  });

  handleMachineSensitive('git:unstage', async (event, workspaceId, rawPaths) => {
    assertTrustedRenderer(event);
    const { workspace } = await requireGitWorkspace(workspaceId);
    const paths = validateGitPaths(rawPaths);
    const safeDirectories = [workspace.root];
    const head = await runGit(workspace.root, buildGitArgv(['rev-parse', '--verify', 'HEAD'], { safeDirectories }));
    const args = head.ok
      ? ['reset', 'HEAD', '--', ...paths]
      : ['rm', '--cached', '--ignore-unmatch', '--', ...paths];
    await runGitOrThrow(workspace.root, buildGitArgv(args, { safeDirectories }));
    return true;
  });

  handleMachineSensitive('git:commit', async (event, workspaceId, rawMessage) => {
    assertTrustedRenderer(event);
    const { workspace } = await requireGitWorkspace(workspaceId);
    const message = sanitizeCommitMessage(rawMessage);
    const args = buildGitArgv(['commit', '-m', message], { safeDirectories: [workspace.root] });
    const commandIndex = args.indexOf('commit');
    args.splice(commandIndex, 0, '-c', 'commit.gpgsign=false', '-c', 'gpg.program=');
    await runGitOrThrow(workspace.root, args);
    return true;
  });

  handleMachineSensitive('git:branches', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const { workspace } = await requireGitWorkspace(workspaceId);
    const stdout = await runGitOrThrow(workspace.root, buildGitArgv(
      ['branch', '-v', '--no-abbrev', '--no-color'],
      { safeDirectories: [workspace.root] }
    ));
    return parseGitBranches(stdout);
  });

  handleMachineSensitive('git:checkout', async (event, workspaceId, rawBranch) => {
    assertTrustedRenderer(event);
    const { workspace, context } = await requireGitWorkspace(workspaceId);
    if (!context.complete) throw new Error('Git filter configuration could not be verified; branch switching is disabled.');
    const branch = validateBranchName(rawBranch);
    const safeDirectories = [workspace.root];
    await runGitOrThrow(workspace.root, buildGitArgv(['check-ref-format', '--branch', branch], { safeDirectories }));
    await runGitOrThrow(workspace.root, buildGitArgv(
      ['switch', '--no-guess', branch],
      { filterDrivers: context.filterDrivers, safeDirectories }
    ));
    return true;
  });

  handleMachineSensitive('git:file-diff', async (event, workspaceId, rawPath, staged) => {
    assertTrustedRenderer(event);
    const { workspace, context } = await requireGitWorkspace(workspaceId);
    if (!context.complete) throw new Error('Git filter configuration could not be verified; file diffs are unavailable.');
    if (typeof staged !== 'boolean') throw new Error('The diff kind must be specified.');
    const [file] = validateGitPaths([rawPath]);
    const args = ['diff', '--no-color', '--unified=3'];
    if (staged) args.push('--cached');
    args.push('--', file);
    const stdout = await runGitOrThrow(workspace.root, buildGitArgv(
      args,
      { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] }
    ));
    return truncateText(stdout, 80_000);
  });

  ipcMain.handle('ts:diagnostics', async (event, workspaceId, overrides, files) => {
    assertTrustedRenderer(event);
    return typeScriptService.diagnostics(workspaceId, overrides, files);
  });

  ipcMain.handle('ts:definition', async (event, workspaceId, relativePath, line, character, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.definition(workspaceId, relativePath, line, character, overrides);
  });

  ipcMain.handle('ts:references', async (event, workspaceId, relativePath, line, character, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.references(workspaceId, relativePath, line, character, overrides);
  });

  ipcMain.handle('ts:exported-contracts', async (event, workspaceId, relativePaths, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.exportedContracts(workspaceId, relativePaths, overrides);
  });

  ipcMain.handle('ts:rename', async (event, workspaceId, relativePath, line, character, newName, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.rename(workspaceId, relativePath, line, character, newName, overrides);
  });

  ipcMain.handle(
    'ts:code-actions',
    async (event, workspaceId, relativePath, startLine, startCharacter, endLine, endCharacter, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.codeActions(
        workspaceId,
        relativePath,
        startLine,
        startCharacter,
        endLine,
        endCharacter,
        overrides
      );
    }
  );

  ipcMain.handle('ts:semantic-tokens', async (event, workspaceId, relativePath, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.semanticTokens(workspaceId, relativePath, overrides);
  });

  ipcMain.handle('ts:outline', async (event, workspaceId, relativePath, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.outline(workspaceId, relativePath, overrides);
  });

  ipcMain.handle('ts:workspace-symbols', async (event, workspaceId, query, overrides) => {
    assertTrustedRenderer(event);
    return typeScriptService.symbols(workspaceId, query, overrides);
  });

  ipcMain.handle('updater:check', async (event) => {
    assertTrustedRenderer(event);
    if (!updater?.available) return { available: false };
    await updater.check(true);
    return { available: true };
  });
}

function registerIntegrationHandlers() {
  async function requireMcpConsent(server) {
    const consentKey = createHash('sha256')
      .update(JSON.stringify({
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        url: server.url,
        headers: server.headers,
        env: server.env
      }))
      .digest('hex');
    if (mcpConsentHashes.has(consentKey)) return;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Approve MCP server',
      message: 'Allow ShadRox to start this MCP process?',
      detail: `Command: ${server.command}\nArguments: ${(server.args || []).join(' ') || '(none)'}\nDirectory: ${server.cwd || '(default)'}`
    });
    if (choice.response !== 1) throw new Error('MCP connection cancelled.');
    mcpConsentHashes.add(consentKey);
  }

  ipcMain.handle('mcp:list-servers', (event) => {
    assertTrustedRenderer(event);
    return listMcpServerConfigs();
  });

  ipcMain.handle('mcp:save-server', (event, server) => {
    assertTrustedRenderer(event);
    return saveMcpServerConfig(server);
  });

  ipcMain.handle('mcp:delete-server', async (event, id) => {
    assertTrustedRenderer(event);
    if (typeof id !== 'string') throw new Error('An MCP server id is required.');
    writeMcpServerRecords(readMcpServerRecords().filter((record) => record.id !== id));
    await closeMcpClient(id);
    return listMcpServerConfigs();
  });

  ipcMain.handle('mcp:connect', async (event, id) => {
    assertTrustedRenderer(event);
    const server = findMcpServerConfig(id);
    if (!server) throw new Error('That MCP server is not configured.');
    await requireMcpConsent(server);
    return listMcpToolsFor(id);
  });

  ipcMain.handle('mcp:list-tools', async (event, serverId) => {
    assertTrustedRenderer(event);
    const server = findMcpServerConfig(serverId);
    if (!server) throw new Error('That MCP server is not configured.');
    if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
    await requireMcpConsent(server);
    return listMcpToolsFor(serverId);
  });

  ipcMain.handle('mcp:call-tool', async (event, serverId, name, args) => {
    assertTrustedRenderer(event);
    if (typeof serverId !== 'string' || typeof name !== 'string' || !name) {
      throw new Error('An MCP server id and tool name are required.');
    }
    const toolArguments = args === undefined || args === null ? {} : args;
    if (typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
      throw new Error('MCP tool arguments must be a JSON object.');
    }
    const server = findMcpServerConfig(serverId);
    if (!server) throw new Error('That MCP server is not configured.');
    if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
    await requireMcpConsent(server);
    const result = await getMcpClient(server).callTool(name, toolArguments);
    return {
      isError: result.isError === true,
      text: mcpToolResultText(result, name),
      content: result.content
    };
  });

  ipcMain.handle('mcp:disconnect', async (event, id) => {
    assertTrustedRenderer(event);
    if (typeof id !== 'string') return false;
    return closeMcpClient(id);
  });

  ipcMain.handle('plugins:scan', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return scanWorkspacePlugins(workspaceAccess.getWorkspace(workspaceId));
  });

  ipcMain.handle('runtime:detect', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace?.root) {
      return { plans: [], errors: ['Runtime detection requires an opened workspace.'] };
    }
    return detectWorkspaceRuntimes(workspace);
  });

  handleMachineSensitive('preview:start-backend', async (event, workspaceId, requestedPort) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Backend preview requires an opened folder workspace.');
    }

    // Detection always runs here; a renderer never supplies the plan itself.
    const detected = await detectWorkspaceRuntimes(workspace);
    const plan = detected.plans.find((candidate) => candidate.kind === 'backend');
    if (!plan) {
      throw new Error(detected.errors.join(' ') || 'No backend runtime was detected for this workspace.');
    }

    const chosenPort = requestedPort === undefined || requestedPort === null ? plan.port : requestedPort;
    if (!Number.isInteger(chosenPort) || chosenPort < 1 || chosenPort > 65535) {
      throw new Error('Backend preview port must be an integer between 1 and 65535.');
    }
    const args = chosenPort === plan.port
      ? plan.args
      : plan.args.map((argument) => argument.split(String(plan.port)).join(String(chosenPort)));

    const absoluteCwd = path.resolve(workspace.root, plan.cwd === '.' ? '' : String(plan.cwd || ''));
    if (!isPathInsideDirectory(workspace.root, absoluteCwd)) {
      throw new Error('The detected backend project is outside the opened workspace.');
    }
    const cwdStat = await fs.promises.stat(absoluteCwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error('The detected backend project folder no longer exists. Rescan runtimes and try again.');
    }

    const resolvedCommand = resolveExecutable(plan.command, { root: workspace.root, cwd: absoluteCwd });
    if (!resolvedCommand) {
      throw new Error(
        `"${plan.command}" was not found on PATH outside this workspace. Install the runtime, then rescan.`
      );
    }

    const approval = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Start backend preview?',
      message: `Allow ShadRox to start the detected ${plan.adapter} backend?`,
      detail: truncateText([
        `Command: ${resolvedCommand}`,
        `Arguments: ${args.join(' ') || '(none)'}`,
        `Directory: ${absoluteCwd}`,
        `Port: ${chosenPort}`,
        `Health check: http://127.0.0.1:${chosenPort}${plan.healthPath || '/'}`,
        '',
        'This starts a local server process that can read and modify files in its directory.'
      ].join('\n'), 4000),
      buttons: ['Cancel', 'Start backend'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (approval.response !== 1) throw new Error('Backend preview cancelled.');

    const started = await previewRuntime.startPlan(
      workspaceId,
      { ...plan, args, cwd: absoluteCwd, port: chosenPort },
      { root: workspace.root }
    );
    return { status: 'ready', url: started.url, script: plan.adapter, hmr: false };
  });

  handleMachineSensitive('preview:stop-backend', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return previewRuntime.stopBackend(workspaceId);
  });

  ipcMain.handle('automation:webhook-status', (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Error('A workspace id is required to read the automation webhook status.');
    }
    return getAutomationWebhook().status();
  });

  ipcMain.handle('automation:webhook-start', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace?.root) {
      throw new Error('The automation webhook requires an opened workspace.');
    }
    automationWebhookWorkspaceId = workspaceId;
    return getAutomationWebhook().start();
  });

  ipcMain.handle('automation:webhook-stop', async (event) => {
    assertTrustedRenderer(event);
    automationWebhookWorkspaceId = null;
    if (automationWebhook) await automationWebhook.stop();
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
    // Copy controls in the renderer (reply copy, code-block copy) need the
    // async clipboard write grant; without it every copy silently failed.
    const allowed = permission === 'media' || permission === 'clipboard-sanitized-write';
    callback(webContents === mainWindow?.webContents && details.isMainFrame && allowed);
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
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.error('[renderer] failed to load', { errorCode, errorDescription, validatedURL });
    }
  });
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error('[renderer] console error', details.message);
    }
    const workspaceId = getPreviewWorkspaceIdForUrl(details.frame?.url || '');
    if (!workspaceId || typeof details.message !== 'string') return;
    const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : 'log';
    if (level === 'error') previewConsoleErrors.record(workspaceId, details.message);
    mainWindow?.webContents.send('preview:output', {
      workspaceId,
      type: 'console',
      message: `[preview ${level}] ${details.message}`
    });
  });
  mainWindow.on('closed', () => {
    debugHost.disposeAll();
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
  installRendererCsp();
  protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
  locateGitExecutable();
  registerIpcHandlers();
  registerSecureStoreHandlers();
  registerProofHandlers();
  registerDebugHandlers();
  registerAuthHandlers();
  registerIntegrationHandlers();
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
  debugHost.disposeAll();
  void previewRuntime.stopAll();
  if (automationWebhook) {
    void automationWebhook.stop();
    automationWebhook = null;
  }
  automationWebhookWorkspaceId = null;
  for (const client of mcpClients.values()) void client.close();
  mcpClients.clear();
  for (const workspaceId of [...workspaceWatchers.keys()]) stopWorkspaceServices(workspaceId);
  if (backend) {
    void backend.close().catch((error) => console.error('[desktop] backend shutdown failed', error));
    backend = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
