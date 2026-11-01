'use strict';

/**
 * Click-to-source support for static HTML previews.
 *
 * The preview iframe executes workspace-authored code, so the bridge below is
 * deliberately dumb: it never touches the preload/desktop bridge, it never
 * evaluates page-authored strings, and it only forwards a handful of short
 * descriptive strings to `window.parent.postMessage`. The served file path is
 * baked in as a JSON literal by the protocol handler rather than read from the
 * page, so a page cannot redirect the editor to another file.
 */

/** Placeholder inside SOURCE_BRIDGE_SCRIPT that receives the JSON path literal. */
const SOURCE_FILE_TOKEN = '__SHADROX_SOURCE_FILE__';

/** Marker used for idempotent injection; also present in the script comment. */
const SOURCE_BRIDGE_MARKER = 'shadrox-source-bridge';

const MAX_FILE_NAME_LENGTH = 512;

/**
 * Self-contained IIFE installed in the preview document. Capture-phase click
 * listener: walk up to the nearest element with an id (else use the clicked
 * element), post one short `reveal-source` message, then stay out of the way.
 */
const SOURCE_BRIDGE_SCRIPT = `(function () {
  /* shadrox-source-bridge */
  var FILE_PATH = __SHADROX_SOURCE_FILE__;
  if (window.__shadroxSourceBridgeInstalled) return;
  window.__shadroxSourceBridgeInstalled = true;

  function isElement(node) {
    return !!node && node.nodeType === 1 && typeof node.tagName === 'string' && node.tagName.length > 0;
  }

  function collapse(value) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  }

  function reveal(event) {
    if (!event || event.__shadroxRevealSent === true) return;
    event.__shadroxRevealSent = true;
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    var node = event.target;
    if (!isElement(node)) node = node && node.parentElement;
    if (!isElement(node)) return;
    var nodeTag = node.tagName.toLowerCase();
    if (nodeTag === 'html' || nodeTag === 'body') return;

    var target = null;
    var cursor = node;
    var depth = 0;
    while (isElement(cursor) && depth < 25) {
      var cursorTag = cursor.tagName.toLowerCase();
      if (cursorTag === 'html' || cursorTag === 'body') break;
      if (typeof cursor.id === 'string' && cursor.id.length > 0) {
        target = cursor;
        break;
      }
      cursor = cursor.parentElement;
      depth += 1;
    }
    if (!target) target = node;

    var tag = target.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return;

    var className = typeof target.className === 'string' ? collapse(target.className) : '';
    if (className.length > 400) className = className.slice(0, 400);
    var text = collapse(target.textContent || '');
    if (text.length > 200) text = text.slice(0, 200);

    try {
      window.parent.postMessage({
        source: 'shadrox-preview',
        type: 'reveal-source',
        path: FILE_PATH,
        tag: tag,
        id: typeof target.id === 'string' ? target.id.slice(0, 256) : '',
        className: className,
        text: text
      }, '*');
    } catch (error) {}
  }

  document.addEventListener('click', function (event) {
    try {
      reveal(event);
    } catch (error) {}
  }, true);
})();`;

/**
 * Validates and normalizes the served file name for the injected literal.
 * Backslashes become forward slashes; absolute paths, drive letters, protocol
 * prefixes, parent segments and control characters are rejected outright.
 */
function normalizeSourceFileName(fileName) {
  if (typeof fileName !== 'string') {
    throw new TypeError('injectSourceBridge: fileName must be a string.');
  }
  const normalized = fileName.replace(/\\/g, '/');
  if (!normalized.length) {
    throw new Error('injectSourceBridge: fileName must be a non-empty relative path.');
  }
  if (normalized.length > MAX_FILE_NAME_LENGTH) {
    throw new Error('injectSourceBridge: fileName is too long.');
  }
  if (normalized !== normalized.trim()) {
    throw new Error('injectSourceBridge: fileName must not start or end with whitespace.');
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('injectSourceBridge: fileName contains control characters.');
  }
  if (normalized.startsWith('/')) {
    throw new Error('injectSourceBridge: fileName must be relative, not absolute.');
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error('injectSourceBridge: fileName must not contain a drive letter.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) {
    throw new Error('injectSourceBridge: fileName must not be a URL.');
  }
  if (normalized.includes('..')) {
    throw new Error('injectSourceBridge: fileName must not contain parent path segments.');
  }
  if (/[<>]/.test(normalized)) {
    throw new Error('injectSourceBridge: fileName contains forbidden characters.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.')) {
    throw new Error('injectSourceBridge: fileName must be a plain relative path.');
  }
  return normalized;
}

/** Escapes a validated name into a JSON literal that cannot break out of <script>. */
function toScriptLiteral(fileName) {
  return JSON.stringify(fileName)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Builds the bridge script for a specific served file. */
function buildSourceBridgeScript(fileName) {
  const normalized = normalizeSourceFileName(fileName);
  const literal = toScriptLiteral(normalized);
  return SOURCE_BRIDGE_SCRIPT.replace(SOURCE_FILE_TOKEN, () => literal);
}

/** Finds the last `</body>` of the document (case-insensitive, byte preserving). */
function findLastClosingBody(html) {
  const pattern = /<\/body\s*>/gi;
  let match;
  let last = null;
  while ((match = pattern.exec(html))) last = { index: match.index, length: match[0].length };
  return last;
}

/**
 * Injects the click-to-source bridge into an HTML document.
 * Idempotent: returns the input unchanged when the marker is already present.
 */
function injectSourceBridge(html, options) {
  if (typeof html !== 'string') {
    throw new TypeError('injectSourceBridge: html must be a string.');
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('injectSourceBridge: options with a fileName are required.');
  }
  const fileName = normalizeSourceFileName(options.fileName);
  if (html.includes(SOURCE_BRIDGE_MARKER)) return html;

  const script = `<script data-shadrox-source-bridge="1">${buildSourceBridgeScript(fileName)}</script>`;
  const closing = findLastClosingBody(html);
  if (closing) {
    return `${html.slice(0, closing.index)}${script}${html.slice(closing.index)}`;
  }
  return `${html}${html.endsWith('\n') ? '' : '\n'}${script}`;
}

/** True only for served HTML documents. */
function shouldInject(relativePath, contentType) {
  if (typeof relativePath !== 'string' || typeof contentType !== 'string') return false;
  const pathname = relativePath.split(/[?#]/)[0].trim().toLowerCase();
  if (!pathname.endsWith('.html') && !pathname.endsWith('.htm')) return false;
  return /text\/html/i.test(contentType);
}

module.exports = {
  MAX_FILE_NAME_LENGTH,
  SOURCE_BRIDGE_MARKER,
  SOURCE_BRIDGE_SCRIPT,
  SOURCE_FILE_TOKEN,
  buildSourceBridgeScript,
  injectSourceBridge,
  normalizeSourceFileName,
  shouldInject
};
