'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { stripContentSecurityPolicyMeta, isHtmlDocument } = require('../csp-strip.cjs');
const { injectSourceBridge, shouldInject } = require('../preview-source.cjs');
const {
  DEFAULT_SETTLE_MS,
  buildFrameAssertionScript,
  deriveContainerSelectors,
  mergePreviewVerdict,
  sanitizeSelectors,
  summarizeFrameResult
} = require('../preview-assert.cjs');

const PREVIEW_SCHEME = 'shadrox-preview';
const APP_SCHEME = 'shadrox-app';
const APP_ORIGIN = `${APP_SCHEME}://localhost`;
const RENDERER_CSP = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'",
  "frame-ancestors 'none'", "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: http: https:", "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "frame-src 'self' http://127.0.0.1:* http://localhost:* shadrox-preview:",
  "worker-src 'self' blob:"
].join('; ');
const DEV_RENDERER_CSP = RENDERER_CSP.replace(
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
);

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

function createPreviewProtocolService(deps) {
  const {
    app,
    electronNet,
    protocol,
    session,
    workspaceAccess,
    previewRuntime,
    previewConsoleErrors,
    getMainWindow,
    getRendererOrigin,
    getBackend
  } = deps;

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
    const rendererOrigin = getRendererOrigin();
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
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const rendererOrigin = getRendererOrigin();
      if (rendererOrigin && details.url.startsWith(rendererOrigin)) {
        const policy = rendererOrigin.startsWith('http://') ? DEV_RENDERER_CSP : RENDERER_CSP;
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [policy],
            'X-Content-Type-Options': ['nosniff'],
            'X-Frame-Options': ['DENY'],
            'Referrer-Policy': ['no-referrer']
          }
        });
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

  async function runPreviewAssertion(workspaceId, requestedSelectors) {
    const contents = getMainWindow()?.webContents;
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
    const derived = deriveContainerSelectors(typeof html === 'string' ? html : '');
    const pinned = sanitizeSelectors(requestedSelectors);
    const selectors = pinned.length > 0 ? pinned : derived;
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
        consoleErrors,
        assertedSelectors: selectors
      });
    } catch {
      return mergePreviewVerdict({
        frameFound: true,
        evaluated: false,
        containerDerived,
        consoleErrors,
        assertedSelectors: selectors,
        detail: 'assertion-script-did-not-evaluate'
      });
    }
  }

  function getAllowedCorsOrigin(origin, hostname) {
    if (!origin) return null;
    if (origin === `${PREVIEW_SCHEME}://${hostname}`) return origin;
    const rendererOrigin = getRendererOrigin();
    if (rendererOrigin && origin === rendererOrigin) return origin;
    return null;
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

  async function serveAppApiRequest(request, url) {
    const backend = getBackend();
    if (!backend?.origin) {
      return previewErrorResponse(503, 'The local backend is not ready yet.');
    }
    const target = new URL(`${url.pathname}${url.search}`, backend.origin);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }
    try {
      return await electronNet.fetch(target.toString(), init);
    } catch (error) {
      return previewErrorResponse(502, `The local backend is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function serveAppStaticRequest(request, url) {
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname);
    } catch {
      return previewErrorResponse(400, 'The requested path is not valid URL encoding.');
    }
    if (relativePath.includes('\0') || relativePath.includes('..') || relativePath.includes('\\')) {
      return previewErrorResponse(403, 'The requested path is not allowed.');
    }
    const distRoot = path.join(app.getAppPath(), 'dist');
    let filePath = path.resolve(distRoot, `.${relativePath}`);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
      return previewErrorResponse(403, 'The requested file is outside the app bundle.');
    }
    let stat = null;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) {
      if (path.extname(filePath) === '') filePath = path.join(distRoot, 'index.html');
      else return previewErrorResponse(404, 'Not found.');
    }
    const stream = fs.createReadStream(filePath);
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': getPreviewMimeType(filePath),
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    };
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.html' || extension === '.htm') {
      headers['Content-Security-Policy'] = RENDERER_CSP;
    }
    return new Response(Readable.toWeb(stream), { headers });
  }

  function installAppProtocol() {
    protocol.handle(APP_SCHEME, async (request) => {
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return previewErrorResponse(400, 'The app URL is invalid.');
      }
      try {
        if (url.pathname.startsWith('/api/')) return await serveAppApiRequest(request, url);
        return await serveAppStaticRequest(request, url);
      } catch (error) {
        console.error('[desktop] App protocol request failed:', error);
        return previewErrorResponse(500, 'The app file could not be served.');
      }
    });
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
    return { status: 'ready', url, script: 'static', hmr: false };
  }

  return {
    allowLoopbackPreviewCertificates,
    installPreviewRequestGuard,
    installRendererCsp,
    handlePreviewRequest,
    installAppProtocol,
    startProtocolPreview,
    runPreviewAssertion,
    getPreviewWorkspaceIdForUrl,
    hashText: (value) => createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex')
  };
}

module.exports = {
  PREVIEW_SCHEME,
  APP_SCHEME,
  APP_ORIGIN,
  RENDERER_CSP,
  PreviewRequestError,
  createPreviewProtocolService
};
