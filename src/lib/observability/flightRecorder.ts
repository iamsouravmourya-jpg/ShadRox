/**
 * The flight recorder: an append-only, local-only event log per run.
 *
 * When a turn fails, the trace must say WHY instead of leaving it to guesswork.
 * Every boundary of a run — model request, stream lifecycle, tool call, edit,
 * command decision, verification, stop — lands here as one bounded event, and
 * the failure taxonomy turns the event sequence into one primary code.
 *
 * Persistence follows the autonomy journal's pattern (src/lib/autonomy/journal.ts):
 * the renderer cannot write disk directly, so events are buffered in memory and
 * flushed as capped JSONL through a localStorage-compatible storage seam. TRUE
 * per-run files need a main-side IPC bridge (electron/** is owned elsewhere):
 * the hook is `RecorderStorage` below — pass a bridge-backed implementation
 * (getItem/setItem/removeItem over `window.shadroxDesktop`) and the same code
 * writes durable per-run files with no other change.
 *
 * Guarantees:
 *  - Fail-open: a recorder error NEVER throws into the tool loop or the stream.
 *    Write failures are themselves recorded (`recorder_error`) and warned once.
 *  - Privacy: every string is scrubbed through envSafety.scrubWorkspaceText
 *    BEFORE it is buffered or written, and capped — a run handed provider keys
 *    must not become the thing that leaks them. Local only; nothing is sent.
 *  - Bounded: events per run, bytes per run, and runs kept are all capped;
 *    the log is a tail, not an archive.
 */

import { scrubWorkspaceText } from '../envSafety';
import { classifyFailure, isSuccessStopReason, type FailureTag } from './failureTaxonomy';

export type FlightEventType =
  | 'turn_started'
  | 'context_assembled'
  | 'model_request'
  | 'stream_start'
  | 'stream_first_token'
  | 'stream_end'
  | 'usage'
  | 'tool_call_started'
  | 'tool_result'
  | 'cache_hit'
  | 'edit_applied'
  | 'command_requested'
  | 'command_decision'
  | 'command_finished'
  | 'verify_result'
  | 'budget_note'
  | 'stuck_nudge'
  | 'stop'
  | 'retry'
  | 'provider_error'
  | 'failure_tag'
  | 'recorder_error';

export interface FlightEvent {
  /** Per-run sequence number, 0-based; the append order is the truth. */
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  runId: string;
  type: FlightEventType;
  /** Scrubbed and bounded payload. Never contains raw credentials. */
  data: Record<string, unknown>;
}

export interface FlightRunSummary {
  runId: string;
  /** 'tool-loop' for a chat turn, 'stream' for a standalone model call. */
  kind: string;
  workspaceId: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  events: number;
  /** Set when old events were dropped to stay inside the cap. */
  truncated?: boolean;
  failure?: FailureTag;
}

/**
 * The storage seam. `window.localStorage` satisfies it; so does the autonomy
 * RunStorage shape; so would a main-process file bridge once electron/** grows
 * the IPC (suggested: `flight:write(runId, jsonl)`, `flight:list()`,
 * `flight:read(runId)`, `flight:prune(keep)` — not invented here).
 */
export interface RecorderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FlightRecorder {
  isEnabled(): boolean;
  /** Settings hook: default ON. Disabling stops recording; reads still work. */
  setEnabled(on: boolean): void;
  /** Opens a run, makes it the active one, and records `turn_started`. */
  startRun(meta?: { kind?: string; workspaceId?: string | null; label?: string }): string;
  /** The run events attach to when no runId is given; null when none is open. */
  activeRunId(): string | null;
  /** Appends one event. Never throws; a no-op while disabled. */
  record(type: FlightEventType, data?: Record<string, unknown>, runId?: string): void;
  /** Records `stop`, tags a failed run via the taxonomy, and flushes. */
  stopRun(reason: string, data?: Record<string, unknown>, runId?: string): void;
  /** Newest first. Merges in-memory runs with the persisted index. */
  listRuns(): FlightRunSummary[];
  /** Oldest first. Reads memory while the run is live, disk after a reload. */
  readEvents(runId: string): FlightEvent[];
  /** Writes dirty runs now. Fail-open. */
  flush(): void;
  /** Test seam: clears memory and persisted keys, re-enables recording. */
  reset(): void;
}

/** How many events one run keeps. The recorder is a tail, not an archive. */
export const MAX_EVENTS_PER_RUN = 4000;
/** How many runs stay readable. Older runs are pruned on start and flush. */
export const MAX_RUNS_KEPT = 24;
/** One string field is worth a bounded preview, never a whole file dump. */
export const MAX_FIELD_CHARS = 1200;
/** One run's persisted JSONL may not eat the storage quota. */
export const MAX_RUN_BYTES = 400_000;
/** Debounce: events batch into one write instead of blocking every boundary. */
const FLUSH_DELAY_MS = 200;

const KEY_PREFIX = 'shadrox.flight';
const INDEX_KEY = `${KEY_PREFIX}.index`;
const runKey = (runId: string): string => `${KEY_PREFIX}.run:${runId}`;

interface RunState {
  summary: FlightRunSummary;
  events: FlightEvent[];
  seq: number;
  dirty: boolean;
}

/** FNV-1a is not needed here; ids only need uniqueness within this process. */
let idCounter = 0;

function defaultStorage(): RecorderStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Private mode / blocked storage: memory-only recording still works.
    return null;
  }
}

/** Scrub + bound every string, recursively. Fail-open: a bad shape is dropped. */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const scrubbed = scrubWorkspaceText(value);
    return scrubbed.length > MAX_FIELD_CHARS ? `${scrubbed.slice(0, MAX_FIELD_CHARS)}…[cut]` : scrubbed;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => sanitize(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, 40)) {
      const cleaned = sanitize((value as Record<string, unknown>)[key], depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  const cleaned = sanitize(data, 0);
  return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned as Record<string, unknown> : {};
}

function toEvent(value: unknown, runId: string): FlightEvent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FlightEvent>;
  if (typeof candidate.type !== 'string' || typeof candidate.at !== 'number' || typeof candidate.seq !== 'number') return null;
  return {
    seq: candidate.seq,
    at: candidate.at,
    runId,
    type: candidate.type as FlightEventType,
    data: candidate.data && typeof candidate.data === 'object' ? candidate.data as Record<string, unknown> : {}
  };
}

function parseJsonl(raw: string, runId: string): FlightEvent[] {
  const events: FlightEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = toEvent(JSON.parse(line), runId);
      if (event) events.push(event);
    } catch {
      // A half-written line is a lost event, not a crashed reader.
    }
  }
  return events;
}

export function createFlightRecorder(options: {
  storage?: RecorderStorage | null;
  now?: () => number;
} = {}): FlightRecorder {
  const now = options.now ?? Date.now;
  // `undefined` means "resolve the browser storage lazily"; null means memory-only.
  const resolveStorage = (): RecorderStorage | null =>
    options.storage === undefined ? defaultStorage() : options.storage;

  let enabled = true;
  let currentRunId: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let warnedOnce = false;
  const runs = new Map<string, RunState>();

  const readIndex = (): FlightRunSummary[] => {
    const storage = resolveStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(INDEX_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is FlightRunSummary =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as FlightRunSummary).runId === 'string');
    } catch {
      return [];
    }
  };

  /** The recorder's own failure path: memory-only note + one console warning. */
  const noteFailure = (runId: string | null, message: string): void => {
    try {
      if (runId) {
        const state = runs.get(runId);
        if (state) {
          state.events.push({ seq: state.seq++, at: now(), runId, type: 'recorder_error', data: { message: message.slice(0, 200) } });
          state.summary.events = state.events.length;
        }
      }
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn(`[flightRecorder] persistence failed (recording continues in memory): ${message}`);
      }
    } catch {
      /* the failure path itself must never throw */
    }
  };

  const writeRun = (state: RunState): void => {
    const storage = resolveStorage();
    if (!storage) return;
    let events = state.events;
    let jsonl = events.map((event) => JSON.stringify(event)).join('\n');
    if (jsonl.length > MAX_RUN_BYTES) {
      // Keep the tail: the end of a run is where the failure lives.
      while (events.length > 100 && jsonl.length > MAX_RUN_BYTES) {
        events = events.slice(Math.ceil(events.length / 4));
        jsonl = events.map((event) => JSON.stringify(event)).join('\n');
      }
      state.summary.truncated = true;
    }
    storage.setItem(runKey(state.summary.runId), jsonl);
    state.dirty = false;
  };

  const writeIndex = (): void => {
    const storage = resolveStorage();
    if (!storage) return;
    const merged = new Map<string, FlightRunSummary>();
    for (const summary of readIndex()) merged.set(summary.runId, summary);
    for (const state of runs.values()) merged.set(state.summary.runId, { ...state.summary });
    const all = [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
    const kept = all.slice(0, MAX_RUNS_KEPT);
    for (const dropped of all.slice(MAX_RUNS_KEPT)) {
      try { storage.removeItem(runKey(dropped.runId)); } catch { /* pruning is best-effort */ }
      runs.delete(dropped.runId);
    }
    storage.setItem(INDEX_KEY, JSON.stringify(kept));
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      const storage = resolveStorage();
      if (!storage) return;
      let wrote = false;
      for (const state of runs.values()) {
        if (!state.dirty) continue;
        writeRun(state);
        wrote = true;
      }
      if (wrote) writeIndex();
    } catch (error) {
      noteFailure(currentRunId, error instanceof Error ? error.message : String(error));
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    try {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, FLUSH_DELAY_MS);
      // Node tests must not be held open by a pending recorder write.
      (flushTimer as unknown as { unref?: () => void }).unref?.();
    } catch {
      flush();
    }
  };

  const ensureRun = (runId?: string): RunState | null => {
    const id = runId ?? currentRunId;
    if (id) {
      const existing = runs.get(id);
      if (existing) return existing;
      // A persisted run reopened (e.g. a resumed turn): rebuild from disk.
      const storage = resolveStorage();
      const summary = readIndex().find((entry) => entry.runId === id);
      if (summary) {
        const events = storage ? parseJsonl(storage.getItem(runKey(id)) ?? '', id) : [];
        const state: RunState = { summary: { ...summary }, events, seq: events.length, dirty: false };
        runs.set(id, state);
        return state;
      }
      if (runId) return null;
    }
    // No open run: a standalone stream still gets a trace of its own.
    const started = startRun({ kind: 'implicit' });
    return runs.get(started) ?? null;
  };

  const record: FlightRecorder['record'] = (type, data, runId) => {
    if (!enabled) return;
    try {
      const state = ensureRun(runId);
      if (!state) return;
      const event: FlightEvent = {
        seq: state.seq++,
        at: now(),
        runId: state.summary.runId,
        type,
        data: sanitizeData(data)
      };
      state.events.push(event);
      if (state.events.length > MAX_EVENTS_PER_RUN) {
        state.events.splice(0, state.events.length - MAX_EVENTS_PER_RUN);
        state.summary.truncated = true;
      }
      state.summary.events = state.events.length;
      state.dirty = true;
      scheduleFlush();
    } catch (error) {
      noteFailure(runId ?? currentRunId, error instanceof Error ? error.message : String(error));
    }
  };

  const startRun: FlightRecorder['startRun'] = (meta = {}) => {
    const runId = `run-${now().toString(36)}-${(idCounter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const summary: FlightRunSummary = {
      runId,
      kind: meta.kind ?? 'tool-loop',
      workspaceId: meta.workspaceId ?? null,
      startedAt: now(),
      endedAt: null,
      stopReason: null,
      events: 0
    };
    runs.set(runId, { summary, events: [], seq: 0, dirty: false });
    currentRunId = runId;
    record('turn_started', { kind: summary.kind, workspaceId: summary.workspaceId, label: meta.label }, runId);
    // Prune eagerly so a long session cannot grow the index without bound.
    try {
      if (resolveStorage()) writeIndex();
    } catch (error) {
      noteFailure(runId, error instanceof Error ? error.message : String(error));
    }
    return runId;
  };

  const stopRun: FlightRecorder['stopRun'] = (reason, data, runId) => {
    const id = runId ?? currentRunId;
    if (!id || !runs.get(id)) {
      // Nothing open to stop; still leave the stop reason on record.
      record('stop', { reason, ...sanitizeData(data) }, id ?? undefined);
      return;
    }
    record('stop', { reason, ...sanitizeData(data) }, id);
    const state = runs.get(id);
    if (state) {
      state.summary.endedAt = now();
      state.summary.stopReason = reason;
      if (!isSuccessStopReason(reason)) {
        const tag = classifyFailure(state.events);
        if (tag) {
          state.summary.failure = tag;
          record('failure_tag', { ...tag }, id);
        }
      }
      state.dirty = true;
    }
    if (currentRunId === id) currentRunId = null;
    flush();
  };

  const listRuns: FlightRecorder['listRuns'] = () => {
    const merged = new Map<string, FlightRunSummary>();
    try {
      for (const summary of readIndex()) merged.set(summary.runId, summary);
    } catch { /* memory still answers */ }
    for (const state of runs.values()) merged.set(state.summary.runId, { ...state.summary });
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  };

  const readEvents: FlightRecorder['readEvents'] = (runId) => {
    const state = runs.get(runId);
    if (state) return state.events.map((event) => ({ ...event, data: { ...event.data } }));
    try {
      const storage = resolveStorage();
      if (!storage) return [];
      return parseJsonl(storage.getItem(runKey(runId)) ?? '', runId);
    } catch {
      return [];
    }
  };

  const reset = (): void => {
    try {
      const storage = resolveStorage();
      if (storage) {
        for (const summary of readIndex()) storage.removeItem(runKey(summary.runId));
        storage.removeItem(INDEX_KEY);
      }
    } catch { /* reset is best-effort */ }
    runs.clear();
    currentRunId = null;
    enabled = true;
    warnedOnce = false;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return {
    isEnabled: () => enabled,
    setEnabled: (on) => { enabled = Boolean(on); },
    startRun,
    activeRunId: () => currentRunId,
    record,
    stopRun,
    listRuns,
    readEvents,
    flush,
    reset
  };
}

/**
 * The process-wide recorder the tool loop and the stream layer write to.
 * Settings owns `setEnabled`; the trace viewer owns `listRuns`/`readEvents`.
 */
export const flightRecorder: FlightRecorder = createFlightRecorder();