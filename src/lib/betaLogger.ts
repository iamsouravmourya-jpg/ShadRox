import { getDesktopBridge } from './desktop';

export type BetaLogLevel = 'info' | 'warn' | 'error';

export type BetaLogSource =
  | 'autonomy'
  | 'tool'
  | 'checkpoint'
  | 'provider'
  | 'ipc'
  | 'ui'
  | 'system';

export interface BetaLogEntry {
  id: string;
  timestamp: number;
  level: BetaLogLevel;
  source: string;
  event: string;
  message: string;
  meta?: Record<string, unknown>;
}

export const MAX_BETA_LOG_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 2000;
const MAX_META_DEPTH = 4;

const KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
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

const HOME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/([A-Za-z]:\\Users\\)([^\\/\s"']+)/g, '$1<user>'],
  [/(\/Users\/)([^/\s"']+)/g, '$1<user>'],
  [/(\/home\/)([^/\s"']+)/g, '$1<user>']
];

export function redactString(input: string): string {
  let value = input.slice(0, MAX_MESSAGE_CHARS);
  for (const [pattern, replacement] of KEY_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of HOME_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_META_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactUnknown(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value).slice(0, 30)) {
      if (/^(?:apiKey|api_key|token|secret|password|authorization)$/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactUnknown(val, depth + 1);
      }
    }
    return out;
  }
  return redactString(String(value));
}

export function redactDiagnostics<T>(value: T): T {
  return redactUnknown(value, 0) as T;
}

function makeLogId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class BetaLoggerStore {
  private entries: BetaLogEntry[] = [];

  public record(input: {
    level: BetaLogLevel;
    source: BetaLogSource | string;
    event: string;
    message: string;
    meta?: Record<string, unknown>;
  }): BetaLogEntry {
    const entry: BetaLogEntry = {
      id: makeLogId(),
      timestamp: Date.now(),
      level: input.level,
      source: redactString(input.source).slice(0, 80) || 'system',
      event: redactString(input.event).slice(0, 100) || 'log',
      message: redactString(input.message),
      ...(input.meta ? { meta: redactDiagnostics(input.meta) } : {})
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_BETA_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_BETA_LOG_ENTRIES);
    }

    const desktop = getDesktopBridge();
    if (desktop?.logs && typeof desktop.logs.record === 'function') {
      void desktop.logs.record(entry).catch(() => {
        /* logging is fail-open */
      });
    }
    return entry;
  }

  public getLocalRecent(limit = MAX_BETA_LOG_ENTRIES): BetaLogEntry[] {
    const count = Math.max(1, Math.min(MAX_BETA_LOG_ENTRIES, Math.floor(limit)));
    return this.entries.slice(-count).reverse();
  }

  public async getMergedRecent(limit = MAX_BETA_LOG_ENTRIES): Promise<BetaLogEntry[]> {
    const local = this.getLocalRecent(limit);
    const desktop = getDesktopBridge();
    if (!desktop?.logs || typeof desktop.logs.getRecent !== 'function') {
      return local;
    }
    try {
      const mainEntries = await desktop.logs.getRecent(limit);
      if (!Array.isArray(mainEntries) || mainEntries.length === 0) return local;
      const byId = new Map<string, BetaLogEntry>();
      for (const entry of [...local, ...mainEntries]) {
        if (entry && typeof entry.id === 'string') {
          byId.set(entry.id, redactDiagnostics(entry));
        }
      }
      return [...byId.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    } catch {
      return local;
    }
  }

  public formatClipboardBundle(entries: readonly BetaLogEntry[]): string {
    const payload = {
      app: 'ShadRox IDE',
      version: '0.1.5-beta',
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries: redactDiagnostics([...entries])
    };
    return JSON.stringify(payload, null, 2);
  }

  public clearLocal(): void {
    this.entries = [];
  }
}

export const betaLogger = new BetaLoggerStore();
