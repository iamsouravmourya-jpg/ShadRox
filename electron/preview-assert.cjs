'use strict';

/**
 * Structured preview sanity assertions (PLAN-BIGTASK 3B, preview half).
 *
 * The preview runs inside an iframe in the app window. Main process locates
 * that iframe's WebFrameMain, executes a BOUNDED structural script inside it
 * (element presence + bounding boxes only — never a DOM dump), merges the
 * result with the console-error buffer collected from `console-message`
 * events, and returns a small verdict DTO across IPC. All content stays in
 * main; only the verdict crosses.
 *
 * TODO(vision): a screenshot diff against a vision model may complement this
 * later; the structured assertion below remains the gate, not the pixels.
 */

const MAX_SELECTORS = 8;
const MAX_SELECTOR_LENGTH = 64;
const MAX_CONSOLE_ERRORS = 5;
const MAX_CONSOLE_ERROR_LENGTH = 200;
const DEFAULT_SETTLE_MS = 1200;
const MAX_SETTLE_MS = 2500;
const SCRIPT_TIMEOUT_MS = 4000;
const MAX_HTML_SCAN_CHARS = 200_000;
// Only trivial id/class selectors may cross into the frame script. Anything
// else could inject arbitrary JS into the executed snippet.
const SELECTOR_PATTERN = /^(?:body|main|[.#][A-Za-z][A-Za-z0-9_-]{0,63})$/;

function clamp(value, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

/** Strict-whitelist selector sanitisation; rejects anything not `#id` / `.class`. */
function sanitizeSelectors(input, limit = MAX_SELECTORS) {
  if (!Array.isArray(input)) return [];
  const safe = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const selector = item.trim().slice(0, MAX_SELECTOR_LENGTH);
    if (!SELECTOR_PATTERN.test(selector)) continue;
    if (!safe.includes(selector)) safe.push(selector);
    if (safe.length >= limit) break;
  }
  return safe;
}

/**
 * Cheap, honest fact derivation from the previewed source: the mount
 * containers the entry HTML declares (`<div id="root">` and friends). If
 * nothing can be derived the caller must report `observed`, never `ok`.
 */
function deriveContainerSelectors(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const text = html.slice(0, MAX_HTML_SCAN_CHARS);
  const ids = [];
  const tagPattern = /<(?:div|main|section|body)\b[^>]*>/gi;
  let match;
  while ((match = tagPattern.exec(text)) !== null && ids.length < 3) {
    const idMatch = /\bid="([A-Za-z][A-Za-z0-9_-]{0,63})"/i.exec(match[0]);
    if (idMatch && !ids.includes(`#${idMatch[1]}`)) ids.push(`#${idMatch[1]}`);
  }
  return ids;
}

/**
 * Bounded in-frame assertion script. Polls until selectors appear (or the
 * settle budget runs out), then reports per-selector presence and first
 * visible bounding box. Returns primitives only.
 */
function buildFrameAssertionScript(selectors, pollMs = 600) {
  const safe = sanitizeSelectors(selectors);
  const budget = clamp(pollMs, 0, MAX_SETTLE_MS);
  return `(async () => {
  const selectors = ${JSON.stringify(safe)};
  const deadline = Date.now() + ${budget};
  const missing = () => selectors.some((s) => {
    try { return document.querySelectorAll(s).length === 0; } catch (err) { return false; }
  });
  while (Date.now() < deadline && missing()) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const results = selectors.map((selector) => {
    let count = 0;
    let visibleCount = 0;
    let width = 0;
    let height = 0;
    let error = null;
    try {
      const nodes = document.querySelectorAll(selector);
      count = nodes.length;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visibleCount += 1;
          if (width === 0) {
            width = Math.round(rect.width);
            height = Math.round(rect.height);
          }
        }
      }
    } catch (err) {
      error = String((err && err.message) || err).slice(0, 120);
    }
    return { selector, count, visibleCount, width, height, error };
  });
  return {
    evaluated: true,
    readyState: String(document.readyState),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    results
  };
})()`;
}

/** Fold the raw frame result into present / missing / zero-box buckets. */
function summarizeFrameResult(scriptResult) {
  if (!scriptResult || scriptResult.evaluated !== true || !Array.isArray(scriptResult.results)) {
    return { evaluated: false, failedSelectors: [], warningSelectors: [] };
  }
  const failedSelectors = [];
  const warningSelectors = [];
  for (const entry of scriptResult.results.slice(0, MAX_SELECTORS)) {
    if (!entry || typeof entry.selector !== 'string') continue;
    const count = typeof entry.count === 'number' ? entry.count : 0;
    const visible = typeof entry.visibleCount === 'number' ? entry.visibleCount : 0;
    if (count <= 0) failedSelectors.push(entry.selector);
    else if (visible <= 0) warningSelectors.push(entry.selector);
  }
  return { evaluated: true, failedSelectors, warningSelectors };
}

/**
 * Per-workspace console-error buffer with hard bounds: at most
 * `maxKeptPerWorkspace` sanitized messages retained until drained. Fed from
 * the window-level `console-message` listener, so load-time errors made
 * before the assertion call are still counted.
 */
function createConsoleErrorSink({
  maxKeptPerWorkspace = MAX_CONSOLE_ERRORS * 2,
  maxMessageLength = MAX_CONSOLE_ERROR_LENGTH
} = {}) {
  const buffers = new Map();
  return {
    record(workspaceId, message) {
      if (typeof workspaceId !== 'string' || !workspaceId) return;
      if (typeof message !== 'string' || message.length === 0) return;
      const sanitized = message.replace(/\s+/g, ' ').trim().slice(0, maxMessageLength);
      if (!sanitized) return;
      const list = buffers.get(workspaceId) ?? [];
      list.push(sanitized);
      if (list.length > maxKeptPerWorkspace) list.splice(0, list.length - maxKeptPerWorkspace);
      buffers.set(workspaceId, list);
    },
    drain(workspaceId) {
      const list = buffers.get(workspaceId);
      if (!list) return [];
      buffers.delete(workspaceId);
      return list;
    },
    clear(workspaceId) {
      buffers.delete(workspaceId);
    },
    size(workspaceId) {
      return buffers.get(workspaceId)?.length ?? 0;
    }
  };
}

/**
 * The verdict DTO is the ONLY thing that crosses IPC. Honest ladder:
 * fatal > warn > ok, and anything unverifiable lands on `observed` — a false
 * 'layout ok' is worse than a neutral 'observed'.
 */
function mergePreviewVerdict(input = {}) {
  const consoleErrors = (Array.isArray(input.consoleErrors) ? input.consoleErrors : [])
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .slice(0, MAX_CONSOLE_ERRORS);
  const errorCount = consoleErrors.length;
  const failedSelectors = (Array.isArray(input.failedSelectors) ? input.failedSelectors : [])
    .slice(0, MAX_SELECTORS);
  const warningSelectors = (Array.isArray(input.warningSelectors) ? input.warningSelectors : [])
    .slice(0, MAX_SELECTORS);
  // Which checks actually ran, so an acceptance re-run can pin the same list.
  const assertedSelectors = sanitizeSelectors(input.assertedSelectors);

  let status = 'observed';
  let detail = typeof input.detail === 'string' ? input.detail.slice(0, 160) : null;

  if (errorCount > 0) {
    status = 'fatal';
  } else if (!input.frameFound) {
    detail = detail ?? 'preview-frame-not-found';
  } else if (!input.evaluated) {
    detail = detail ?? 'assertion-script-did-not-evaluate';
  } else if (failedSelectors.length > 0) {
    // Missing key selectors means the app never painted its root: fatal.
    status = 'fatal';
  } else if (!input.containerDerived) {
    // Only generic body checks ran — not enough evidence to claim 'ok'.
    detail = detail ?? 'no-source-derived-assertion';
  } else if (warningSelectors.length > 0) {
    status = 'warn';
  } else {
    status = 'ok';
  }

  return { ok: status === 'ok', status, failedSelectors, warningSelectors, errorCount, consoleErrors, assertedSelectors, detail };
}

module.exports = {
  DEFAULT_SETTLE_MS,
  MAX_CONSOLE_ERRORS,
  MAX_CONSOLE_ERROR_LENGTH,
  MAX_SELECTORS,
  MAX_SETTLE_MS,
  SCRIPT_TIMEOUT_MS,
  buildFrameAssertionScript,
  clamp,
  createConsoleErrorSink,
  deriveContainerSelectors,
  mergePreviewVerdict,
  sanitizeSelectors,
  summarizeFrameResult
};
