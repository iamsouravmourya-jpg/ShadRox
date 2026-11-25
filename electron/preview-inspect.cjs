'use strict';

/**
 * preview-inspect: bounded, loopback-only inspection of the EXISTING preview
 * iframe. The agent can screenshot the pane, read console/network rings, query
 * the DOM, click and type — but it can never navigate the preview away from its
 * origin, reach a non-loopback URL, or pull unbounded payloads into context.
 *
 * Registration is self-contained (main.cjs is owned elsewhere): preview-runtime
 * calls registerPreviewInspect with the electron module when ipcMain exists.
 * Under plain `node --test`, require('electron') yields a string path, so the
 * registration is skipped and only the pure helpers below are exercised.
 */

const { unwrapErrorMessage } = require('./error-utils.cjs');

const MAX_SELECTOR_LENGTH = 200;
const MAX_TYPE_TEXT_LENGTH = 2000;
const MAX_DOM_HTML_CHARS = 20000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 100;
const MAX_LOG_TEXT_CHARS = 2000;
const MAX_URL_CHARS = 2000;
const MAX_SCREENSHOT_WIDTH = 1024;
const MAX_SCREENSHOT_DATAURL_CHARS = 1_500_000;
const FRAME_SCRIPT_TIMEOUT_MS = 8000;
const PREVIEW_SCHEME = 'shadrox-preview';

/**
 * A selector is interpolated into frame scripts via JSON.stringify, so quotes
 * cannot break out; we still reject control characters and oversize input so a
 * hostile tool call cannot smuggle a payload or blow the context budget.
 */
function sanitizeInspectSelector(value) {
  if (typeof value !== 'string') return null;
  const selector = value.trim().slice(0, MAX_SELECTOR_LENGTH);
  if (!selector) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(selector)) return null;
  return selector;
}

function clipText(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function extractRouteFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl);
    return (parsed.pathname || '/') + (parsed.search || '');
  } catch {
    return null;
  }
}

/** DOM read: outerHTML of the first match, hard-capped. Never mutates. */
function buildDomScript(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
    try {
      const el = document.querySelector(${sel});
      if (!el) return { found: false };
      return {
        found: true,
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        html: (el.outerHTML || '').slice(0, ${MAX_DOM_HTML_CHARS})
      };
    } catch (error) {
      return { found: false, error: String(error && error.message || error) };
    }
  })()`;
}

/** Click: scroll into view + native click. No navigation is ever issued. */
function buildClickScript(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
    try {
      const el = document.querySelector(${sel});
      if (!el) return { found: false };
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      el.click();
      return { found: true, clicked: true, tag: el.tagName ? el.tagName.toLowerCase() : '' };
    } catch (error) {
      return { found: false, error: String(error && error.message || error) };
    }
  })()`;
}

/**
 * Type: native value setter (React-compatible) + input/change events for
 * form controls, textContent + input event for contenteditable. The text is
 * JSON-stringified so it can never terminate the script.
 */
function buildTypeScript(selector, text) {
  const sel = JSON.stringify(selector);
  const value = JSON.stringify(clipText(text, MAX_TYPE_TEXT_LENGTH));
  return `(() => {
    try {
      const el = document.querySelector(${sel});
      if (!el) return { found: false };
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${value}); else el.value = ${value};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, typed: true, tag };
      }
      if (el.isContentEditable) {
        el.textContent = ${value};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { found: true, typed: true, tag };
      }
      return { found: true, typed: false, error: 'Element is not an input, textarea or contenteditable.' };
    } catch (error) {
      return { found: false, error: String(error && error.message || error) };
    }
  })()`;
}

/**
 * Runs in the TOP frame: enumerate preview iframes with their bounding rects
 * so main can capturePage() exactly the preview pane. Reading geometry only —
 * no src writes, no navigation.
 */
function buildPreviewRectsScript() {
  return `(() => {
    try {
      const out = [];
      for (const frame of document.querySelectorAll('iframe')) {
        const rect = frame.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        out.push({
          src: String(frame.getAttribute('src') || ''),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
        if (out.length >= 12) break;
      }
      return out;
    } catch (error) {
      return [];
    }
  })()`;
}

/** Bounded ring buffers, one set per workspace. Oldest entries fall off. */
function createInspectBuffers({ consoleLimit = MAX_CONSOLE_ENTRIES, networkLimit = MAX_NETWORK_ENTRIES } = {}) {
  const consoleEntries = [];
  const networkEntries = [];

  function pushRing(ring, entry, limit) {
    ring.push(entry);
    while (ring.length > limit) ring.shift();
  }

  return {
    pushConsole(entry) {
      const url = entry.url ? clipText(entry.url, MAX_URL_CHARS) : null;
      const route = typeof entry.route === 'string' && entry.route.trim()
        ? entry.route.trim().slice(0, 300)
        : (url ? extractRouteFromUrl(url) : null);
      pushRing(consoleEntries, {
        level: entry.level === 'error' || entry.level === 'warn' ? entry.level : 'log',
        text: clipText(entry.text, MAX_LOG_TEXT_CHARS),
        timestamp: Number(entry.timestamp) || Date.now(),
        ...(url ? { url } : {}),
        ...(route ? { route } : {})
      }, consoleLimit);
    },
    pushNetwork(entry) {
      pushRing(networkEntries, {
        url: clipText(entry.url, MAX_URL_CHARS),
        method: typeof entry.method === 'string' ? entry.method.slice(0, 12) : 'GET',
        status: Number.isFinite(entry.status) ? entry.status : 0,
        error: entry.error ? clipText(entry.error, 300) : null,
        timestamp: Number(entry.timestamp) || Date.now()
      }, networkLimit);
    },
    consoleLogs() {
      return consoleEntries.slice();
    },
    networkErrors() {
      return networkEntries.filter((entry) => entry.error || entry.status >= 400);
    },
    clear() {
      consoleEntries.length = 0;
      networkEntries.length = 0;
    }
  };
}

/** Only loopback dev servers and the internal static-preview scheme qualify. */
function isLoopbackPreviewUrl(value) {
  let target;
  try {
    target = new URL(String(value));
  } catch {
    return false;
  }
  if (target.protocol === `${PREVIEW_SCHEME}:`) return true;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const host = target.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Map a frame/request URL to a workspace: runtime origins first, scheme second. */
function matchPreviewFrameUrl(url, workspaceId, getWorkspaceIdForUrl) {
  if (typeof url !== 'string' || !url) return false;
  try {
    if (getWorkspaceIdForUrl && getWorkspaceIdForUrl(url) === workspaceId) return true;
  } catch {
    // fall through to the scheme check
  }
  try {
    const target = new URL(url);
    return target.protocol === `${PREVIEW_SCHEME}:` && target.hostname === workspaceId;
  } catch {
    return false;
  }
}

function clampRect(rect) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const width = Math.min(8192, Math.max(1, Math.round(rect.width)));
  const height = Math.min(8192, Math.max(1, Math.round(rect.height)));
  if (width < 2 || height < 2) return null;
  return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width, height };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function normalizeConsoleLevel(level) {
  if (level === 'error' || level === 3) return 'error';
  if (level === 'warning' || level === 'warn' || level === 2) return 'warn';
  return 'log';
}

/**
 * Wire the single 'preview-inspect:run' channel. Called from preview-runtime
 * with the real electron module; a no-op when ipcMain is unavailable (tests).
 */
function registerPreviewInspect({ ipcMain, app, BrowserWindow, nativeImage, getWorkspaceIdForUrl, getMainWindow } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return null;

  const buffersByWorkspace = new Map();
  const attachedContents = new WeakSet();
  let sessionAttached = false;

  function buffersFor(workspaceId) {
    let buffers = buffersByWorkspace.get(workspaceId);
    if (!buffers) {
      buffers = createInspectBuffers();
      buffers.previewRunId = 1;
      buffersByWorkspace.set(workspaceId, buffers);
      // Keep the map bounded even if workspaces churn.
      if (buffersByWorkspace.size > 24) {
        const oldest = buffersByWorkspace.keys().next().value;
        if (oldest !== workspaceId) buffersByWorkspace.delete(oldest);
      }
    }
    return buffers;
  }

  function resetWorkspaceBuffers(workspaceId, previewRunId) {
    if (typeof workspaceId !== 'string' || !workspaceId) return null;
    buffersByWorkspace.delete(workspaceId);
    const fresh = buffersFor(workspaceId);
    if (typeof previewRunId === 'number' && Number.isFinite(previewRunId)) {
      fresh.previewRunId = previewRunId;
    }
    return fresh;
  }

  function attachListeners(contents) {
    if (!contents || attachedContents.has(contents)) return;
    attachedContents.add(contents);

    contents.on('console-message', (detailsOrEvent, levelArg, messageArg) => {
      try {
        // New Electron passes a details object; legacy passes positional args.
        const details = detailsOrEvent && typeof detailsOrEvent === 'object' && 'message' in detailsOrEvent
          ? detailsOrEvent
          : { level: levelArg, message: messageArg, frame: null };
        const frameUrl = details.frame?.url || '';
        let workspaceId = null;
        for (const id of buffersByWorkspace.keys()) {
          if (matchPreviewFrameUrl(frameUrl, id, getWorkspaceIdForUrl)) { workspaceId = id; break; }
        }
        if (!workspaceId && getWorkspaceIdForUrl) workspaceId = getWorkspaceIdForUrl(frameUrl);
        if (!workspaceId) {
          try {
            const target = new URL(frameUrl);
            if (target.protocol === `${PREVIEW_SCHEME}:`) workspaceId = target.hostname;
          } catch { /* not a preview frame */ }
        }
        if (!workspaceId || typeof details.message !== 'string') return;
        buffersFor(workspaceId).pushConsole({
          level: normalizeConsoleLevel(details.level),
          text: details.message,
          url: frameUrl,
          route: extractRouteFromUrl(frameUrl),
          timestamp: Date.now()
        });
      } catch {
        // Inspection must never break the preview itself.
      }
    });

    if (!sessionAttached && contents.session?.webRequest) {
      sessionAttached = true;
      const webRequest = contents.session.webRequest;
      const recordNetwork = (details, error) => {
        try {
          const url = details.url || '';
          if (!isLoopbackPreviewUrl(url) && !url.startsWith(`${PREVIEW_SCHEME}:`)) return;
          let workspaceId = null;
          const frameUrl = details.frame?.url || '';
          for (const id of buffersByWorkspace.keys()) {
            if (matchPreviewFrameUrl(frameUrl, id, getWorkspaceIdForUrl) || matchPreviewFrameUrl(url, id, getWorkspaceIdForUrl)) {
              workspaceId = id;
              break;
            }
          }
          if (!workspaceId && getWorkspaceIdForUrl) workspaceId = getWorkspaceIdForUrl(url) || getWorkspaceIdForUrl(frameUrl);
          if (!workspaceId) {
            try {
              const target = new URL(frameUrl || url);
              if (target.protocol === `${PREVIEW_SCHEME}:`) workspaceId = target.hostname;
            } catch { /* ignore */ }
          }
          if (!workspaceId) return;
          buffersFor(workspaceId).pushNetwork({
            url,
            method: details.method,
            status: details.statusCode,
            error: error || null,
            timestamp: Date.now()
          });
        } catch { /* never break requests */ }
      };
      // onCompleted/onErrorOccurred are unused by main.cjs (it only registers
      // onBeforeRequest/onHeadersReceived), so these slots are free.
      webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => recordNetwork(details, null));
      webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => recordNetwork(details, details.error || 'net error'));
    }
  }

  function attachAllWindows() {
    try {
      for (const win of BrowserWindow.getAllWindows()) attachListeners(win.webContents);
    } catch { /* window list unavailable */ }
  }

  if (app && typeof app.on === 'function') {
    app.on('browser-window-created', (_event, win) => attachListeners(win?.webContents));
  }

  function trustedWindow(event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return null;
    // Only the app's own top frame may drive inspection — never a preview
    // iframe or a detached/destroyed frame (fail closed, like desktop-security).
    if (event.sender !== win.webContents) return null;
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return null;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return null;
    try {
      if (new URL(frame.url).protocol === `${PREVIEW_SCHEME}:`) return null;
    } catch {
      return null;
    }
    const main = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (main && main !== win) return null;
    return win;
  }

  function findPreviewFrame(win, workspaceId) {
    const frames = win.webContents.mainFrame?.framesInSubtree || [];
    for (const frame of frames) {
      let url = '';
      try { url = frame.url || ''; } catch { continue; }
      if (!matchPreviewFrameUrl(url, workspaceId, getWorkspaceIdForUrl)) continue;
      if (!isLoopbackPreviewUrl(url)) continue;
      try {
        if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) continue;
      } catch { continue; }
      return frame;
    }
    return null;
  }

  async function runFrameScript(frame, script, label) {
    return withTimeout(frame.executeJavaScript(script, true), FRAME_SCRIPT_TIMEOUT_MS, label);
  }

  async function captureScreenshot(win, workspaceId) {
    const rects = await withTimeout(
      win.webContents.mainFrame.executeJavaScript(buildPreviewRectsScript(), true),
      FRAME_SCRIPT_TIMEOUT_MS,
      'preview geometry read'
    );
    const candidates = Array.isArray(rects) ? rects : [];
    const match = candidates.find((entry) => entry && matchPreviewFrameUrl(entry.src, workspaceId, getWorkspaceIdForUrl));
    const bounds = clampRect(match?.rect);
    if (!bounds) {
      return { ok: false, error: 'The preview pane is not visible in the window, so there is nothing to capture.' };
    }
    const image = await win.capturePage(bounds);
    if (!image || image.isEmpty()) {
      return { ok: false, error: 'Nothing is painting in the preview pane yet.' };
    }
    const size = image.getSize();
    const scaled = size.width > MAX_SCREENSHOT_WIDTH ? image.resize({ width: MAX_SCREENSHOT_WIDTH }) : image;
    const dataUrl = scaled.toDataURL();
    if (dataUrl.length > MAX_SCREENSHOT_DATAURL_CHARS) {
      return { ok: false, error: 'The screenshot is too large to return inline. Ask for get_dom instead.' };
    }
    return { ok: true, dataUrl, width: scaled.getSize().width, height: scaled.getSize().height };
  }

  ipcMain.handle('preview-inspect:run', async (event, workspaceId, request) => {
    try {
      const win = trustedWindow(event);
      if (!win) return { ok: false, error: 'Inspection is only available from the ShadRox main window.' };
      if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 200) {
        return { ok: false, error: 'A valid workspace id is required.' };
      }
      if (!request || typeof request !== 'object' || typeof request.action !== 'string') {
        return { ok: false, error: 'An inspect request with an action is required.' };
      }
      attachAllWindows();
      // The renderer tool speaks short action names; keep the long forms as
      // aliases so direct IPC callers and tests can use either.
      const aliases = { console: 'get_console_logs', network: 'get_network_errors', dom: 'get_dom' };
      const action = Object.hasOwn(aliases, request.action) ? aliases[request.action] : request.action;

      if (action === 'get_console_logs') {
        const buffers = buffersFor(workspaceId);
        const previewRunId = buffers.previewRunId ?? 1;
        const logs = buffers.consoleLogs().map((entry) => ({
          level: entry.level,
          message: entry.text,
          timestamp: entry.timestamp,
          previewRunId,
          ...(entry.url ? { url: entry.url } : {}),
          ...(entry.route ? { route: entry.route } : {})
        }));
        return { ok: true, logs, previewRunId };
      }
      if (action === 'get_network_errors') {
        const buffers = buffersFor(workspaceId);
        return { ok: true, errors: buffers.networkErrors(), previewRunId: buffers.previewRunId ?? 1 };
      }

      const frame = findPreviewFrame(win, workspaceId);
      if (!frame) {
        return { ok: false, error: 'The preview pane for this workspace is not open. Start the preview first, then inspect it.' };
      }

      if (action === 'screenshot') {
        return await captureScreenshot(win, workspaceId);
      }

      const selector = sanitizeInspectSelector(request.selector ?? 'body');
      if (!selector) {
        return { ok: false, error: `Provide a CSS selector of 1-${MAX_SELECTOR_LENGTH} characters without control characters.` };
      }

      if (action === 'get_dom') {
        const result = await runFrameScript(frame, buildDomScript(selector), 'get_dom');
        if (!result || typeof result !== 'object') return { ok: false, error: 'The preview did not return a DOM result.' };
        if (result.error) return { ok: false, error: clipText(result.error, 500) };
        if (!result.found) return { ok: false, error: `No element matches "${selector}" in the preview.` };
        return { ok: true, found: true, count: 1, tag: result.tag || '', html: clipText(result.html, MAX_DOM_HTML_CHARS) };
      }
      if (action === 'click') {
        const result = await runFrameScript(frame, buildClickScript(selector), 'click');
        if (!result || typeof result !== 'object') return { ok: false, error: 'The preview did not return a click result.' };
        if (result.error) return { ok: false, error: clipText(result.error, 500) };
        if (!result.found) return { ok: false, error: `No element matches "${selector}" in the preview.` };
        return { ok: true, clicked: true, tag: result.tag || '' };
      }
      if (action === 'type') {
        if (typeof request.text !== 'string' || request.text.length > MAX_TYPE_TEXT_LENGTH) {
          return { ok: false, error: `type needs text of 0-${MAX_TYPE_TEXT_LENGTH} characters.` };
        }
        const result = await runFrameScript(frame, buildTypeScript(selector, request.text), 'type');
        if (!result || typeof result !== 'object') return { ok: false, error: 'The preview did not return a type result.' };
        if (result.error) return { ok: false, error: clipText(result.error, 500) };
        if (!result.found) return { ok: false, error: `No element matches "${selector}" in the preview.` };
        return { ok: true, typed: Boolean(result.typed), tag: result.tag || '' };
      }

      return { ok: false, error: `Unknown preview inspect action "${clipText(action, 60)}".` };
    } catch (error) {
      return { ok: false, error: clipText(unwrapErrorMessage(error), 500) };
    }
  });

  return { buffersFor, attachListeners, resetWorkspaceBuffers };
}

module.exports = {
  MAX_SELECTOR_LENGTH,
  MAX_TYPE_TEXT_LENGTH,
  MAX_DOM_HTML_CHARS,
  MAX_CONSOLE_ENTRIES,
  MAX_NETWORK_ENTRIES,
  sanitizeInspectSelector,
  buildDomScript,
  buildClickScript,
  buildTypeScript,
  buildPreviewRectsScript,
  createInspectBuffers,
  isLoopbackPreviewUrl,
  matchPreviewFrameUrl,
  clampRect,
  normalizeConsoleLevel,
  registerPreviewInspect
};