const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_LOG_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 2000;
const MAX_META_DEPTH = 4;

const KEY_PATTERNS = [
  [/AIza[\w-]{20,}/g, '[REDACTED_KEY]'],
  [/sk-ant-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]'],
  [/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/gsk_[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED_KEY]'],
  [/github_pat_[A-Za-z0-9_]{16,}/g, '[REDACTED_KEY]'],
  [/xox[bpa]-[A-Za-z0-9-]{10,}/g, '[REDACTED_KEY]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED_TOKEN]'],
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"';,}]{8,}/gi,
    '$1[REDACTED]'
  ]
];

const HOME_PATTERNS = [
  [/([A-Za-z]:\\Users\\)([^\\/\s"']+)/g, '$1<user>'],
  [/(\/Users\/)([^/\s"']+)/g, '$1<user>'],
  [/(\/home\/)([^/\s"']+)/g, '$1<user>']
];

function redactString(input) {
  if (typeof input !== 'string') return '';
  let value = input.slice(0, MAX_MESSAGE_CHARS);
  for (const [pattern, replacement] of KEY_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of HOME_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_META_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value).slice(0, 30);
    for (const [key, val] of entries) {
      if (/^(?:apiKey|api_key|token|secret|password|authorization)$/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactValue(val, depth + 1);
      }
    }
    return out;
  }
  return redactString(String(value));
}

function redactDiagnostics(entry) {
  if (typeof entry === 'string') return redactString(entry);
  if (!entry || typeof entry !== 'object') return entry;
  return redactValue(entry, 0);
}

const VALID_LEVELS = new Set(['info', 'warn', 'error']);

function createBetaLogger(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_LOG_ENTRIES;
  const logDir = typeof options.logDir === 'string' && options.logDir.trim()
    ? options.logDir.trim()
    : null;
  const logFilePath = logDir ? path.join(logDir, 'shadrox-beta.log') : null;
  const entries = [];
  let writeChain = Promise.resolve();

  function appendFileAsync(record) {
    if (!logFilePath) return;
    writeChain = writeChain
      .then(async () => {
        await fs.mkdir(logDir, { recursive: true });
        await fs.appendFile(logFilePath, `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch(() => {
        /* logging must never interrupt app execution */
      });
  }

  function record(raw) {
    const level = VALID_LEVELS.has(raw?.level) ? raw.level : 'info';
    const source = redactString(String(raw?.source || 'system')).slice(0, 80) || 'system';
    const event = redactString(String(raw?.event || 'log')).slice(0, 100) || 'log';
    const message = redactString(String(raw?.message || ''));
    const meta = raw?.meta && typeof raw.meta === 'object' ? redactDiagnostics(raw.meta) : undefined;
    const entry = {
      id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 64) : randomUUID(),
      timestamp: typeof raw?.timestamp === 'number' && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : Date.now(),
      level,
      source,
      event,
      message,
      ...(meta !== undefined ? { meta } : {})
    };
    entries.push(entry);
    if (entries.length > maxEntries) {
      entries.splice(0, entries.length - maxEntries);
    }
    appendFileAsync(entry);
    return entry;
  }

  function getRecent(limit = maxEntries) {
    const count = Number.isFinite(limit) && limit > 0 ? Math.min(maxEntries, Math.floor(limit)) : maxEntries;
    return entries.slice(-count).reverse();
  }

  function clear() {
    entries.length = 0;
  }

  async function flush() {
    await writeChain;
  }

  return {
    record,
    getRecent,
    clear,
    flush,
    get logFilePath() {
      return logFilePath;
    }
  };
}

let defaultLogger = createBetaLogger();

function initDefaultBetaLogger(options = {}) {
  defaultLogger = createBetaLogger(options);
  return defaultLogger;
}

function getDefaultBetaLogger() {
  return defaultLogger;
}

module.exports = {
  DEFAULT_MAX_LOG_ENTRIES,
  createBetaLogger,
  initDefaultBetaLogger,
  getDefaultBetaLogger,
  redactDiagnostics,
  redactString
};
