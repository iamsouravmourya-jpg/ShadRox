/**
 * Console model for the preview drawer.
 *
 * Two real sources feed it: the injected bridge inside a preview document
 * (`postMessage`, see PREVIEW_ERROR_BRIDGE and electron/preview-source.cjs) and
 * the dev server's own stdout/stderr lines relayed over IPC. Both are folded
 * into one record shape here so filtering, counting and clipboard text stay
 * deterministic and testable instead of being ad-hoc JSX.
 */

import { parseRevealMessage, type RevealSourceTarget } from '../previewSource';

export type ConsoleLevel = 'log' | 'warn' | 'error';

export interface ConsoleRecord {
  id: number;
  level: ConsoleLevel;
  message: string;
  /** Epoch milliseconds; kept raw so the drawer can render its own timezone. */
  at: number;
  origin: 'page' | 'server';
  stack?: string;
}

export interface LevelFilter {
  log: boolean;
  warn: boolean;
  error: boolean;
}

export const CONSOLE_LIMIT = 400;
export const MAX_MESSAGE_LENGTH = 4000;

export const ALL_LEVELS: LevelFilter = { log: true, warn: true, error: true };

export function createRecord(
  id: number,
  level: ConsoleLevel,
  message: string,
  at: number,
  origin: ConsoleRecord['origin'],
  stack?: string
): ConsoleRecord {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const record: ConsoleRecord = {
    id,
    level,
    message: text.slice(0, MAX_MESSAGE_LENGTH),
    at,
    origin
  };
  const stackText = typeof stack === 'string' && stack.trim() ? stack.slice(0, MAX_MESSAGE_LENGTH * 2) : '';
  if (stackText) record.stack = stackText;
  return record;
}

/** Immutable append with a bounded tail, oldest records dropped first. */
export function appendRecord(records: ConsoleRecord[], record: ConsoleRecord, limit = CONSOLE_LIMIT): ConsoleRecord[] {
  const next = [...records, record];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function appendMany(records: ConsoleRecord[], incoming: ConsoleRecord[], limit = CONSOLE_LIMIT): ConsoleRecord[] {
  if (incoming.length === 0) return records;
  const next = [...records, ...incoming];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function filterRecords(records: ConsoleRecord[], filter: LevelFilter, query = ''): ConsoleRecord[] {
  const needle = query.trim().toLowerCase();
  return records.filter((record) => {
    if (!filter[record.level]) return false;
    if (!needle) return true;
    return record.message.toLowerCase().includes(needle) || (record.stack ?? '').toLowerCase().includes(needle);
  });
}

export function countByLevel(records: ConsoleRecord[]): Record<ConsoleLevel, number> {
  const counts: Record<ConsoleLevel, number> = { log: 0, warn: 0, error: 0 };
  for (const record of records) counts[record.level] += 1;
  return counts;
}

export function latestError(records: ConsoleRecord[]): ConsoleRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].level === 'error') return records[index];
  }
  return null;
}

/** Consecutive identical errors collapse: a render loop must not flood the drawer. */
export function isDuplicateOfLast(records: ConsoleRecord[], candidate: ConsoleRecord): boolean {
  const last = records[records.length - 1];
  return !!last && last.level === candidate.level && last.message === candidate.message;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function recordsToText(records: ConsoleRecord[]): string {
  return records
    .map((record) => {
      const head = `${formatClock(record.at)}  ${record.level.toUpperCase().padEnd(5)}  ${record.message}`;
      return record.stack ? `${head}\n${record.stack}` : head;
    })
    .join('\n');
}

export type BridgeMessage =
  | { kind: 'record'; level: ConsoleLevel; message: string; stack?: string }
  | { kind: 'reveal'; target: RevealSourceTarget }
  | { kind: 'ignored' };

/**
 * Parses one `message` event from a preview frame. Everything must be tagged
 * `source: 'shadrox-preview'` and the caller still checks `event.source`, so a
 * random window message cannot inject console lines.
 */
export function parseBridgeMessage(data: unknown): BridgeMessage {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ignored' };
  const record = data as Record<string, unknown>;
  if (record.source !== 'shadrox-preview' || typeof record.type !== 'string') return { kind: 'ignored' };

  if (record.type === 'reveal-source') {
    const target = parseRevealMessage(record);
    return target ? { kind: 'reveal', target } : { kind: 'ignored' };
  }

  const message = typeof record.message === 'string' ? record.message : '';
  switch (record.type) {
    case 'console-error':
      return { kind: 'record', level: 'error', message: message || 'Runtime error', stack: textOf(record.stack) };
    case 'error':
      return {
        kind: 'record',
        level: 'error',
        message: message || 'Runtime error',
        stack: textOf(record.stack)
      };
    case 'console-warn':
    case 'warn':
      return { kind: 'record', level: 'warn', message };
    case 'console-log':
    case 'console-info':
    case 'log':
      return { kind: 'record', level: 'log', message };
    default:
      return { kind: 'ignored' };
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface ServerOutputLike {
  type: string;
  message: string;
  timestamp?: number;
  level?: ConsoleLevel;
}

/** Dev server / static server log lines, which are real output, never decoration. */
export function recordsFromServerOutput(outputs: ServerOutputLike[], startId: number, at = Date.now()): ConsoleRecord[] {
  let id = startId;
  return outputs.map((output) => {
    const level: ConsoleLevel =
      output.level ?? (output.type === 'stderr' || output.type === 'error' ? 'error' : output.type === 'status' || output.type === 'install' ? 'warn' : 'log');
    const record = createRecord(id, level, output.message, output.timestamp ?? at, 'server');
    id += 1;
    return record;
  });
}
