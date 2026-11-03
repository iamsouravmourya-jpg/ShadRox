/**
 * Background runs: a run that survives an app restart without pretending it is
 * still alive.
 *
 * There is no background process. What is persisted here is a description of a
 * run — never its file contents, replies or patches — so the next launch can say
 * "this run was interrupted" and resume it only in the same workspace and only
 * while the budget allows. A snapshot that says `running` on disk is a snapshot
 * the app never got to finish; `settleInterrupted` is the only thing allowed to
 * rewrite that, and it rewrites it to `paused`, never to a live state.
 */

import { DEFAULT_RUN_BUDGET } from './types';

export const BACKGROUND_SNAPSHOT_VERSION = 1;
export const MAX_BACKGROUND_TASKS = 100;
export const MAX_BACKGROUND_TITLE = 500;
export const MAX_BACKGROUND_GOAL = 500;
export const MAX_BACKGROUND_EVENT = 200;
export const MAX_BACKGROUND_ID = 120;
export const MAX_BACKGROUND_ROOT = 1024;
export const MAX_BACKGROUND_CREDITS = 1_000_000;
export const MAX_BACKGROUND_ATTEMPTS = 999;
/** Below this, a resume would buy a fraction of a turn; the panel says so instead. */
export const MIN_RESUME_CREDITS = 0.1;
export const BACKGROUND_KEEP_LIMIT = 5;

export type BackgroundMode = 'autonomy' | 'team';
export type BackgroundStatus = 'running' | 'paused' | 'stopped' | 'done' | 'failed';
export type BackgroundTaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';

/** The only slice of a milestone/task the resume line needs. */
export interface BackgroundTaskSummary {
  id: string;
  title: string;
  status: BackgroundTaskStatus;
  attempts: number;
}

export interface BackgroundRunSnapshot {
  version: typeof BACKGROUND_SNAPSHOT_VERSION;
  runId: string;
  workspaceRoot: string;
  goal: string;
  mode: BackgroundMode;
  status: BackgroundStatus;
  startedAt: number;
  updatedAt: number;
  creditsSpent: number;
  budgetCredits: number;
  tasks: BackgroundTaskSummary[];
  lastEvent: string;
  /** True only when the app closed under a run; `settleInterrupted` sets it. */
  interrupted: boolean;
}

/** A milestone or a team task, as much of it as the snapshot keeps. */
export interface BackgroundTaskSource {
  id?: string;
  title?: string;
  status?: string;
  /** A team task counts attempts; a milestone keeps the attempt records. */
  attempts?: number | ReadonlyArray<unknown>;
}

/** A `RunState` or `TeamState` plus the workspace it belongs to. */
export interface BackgroundRunSource {
  workspaceRoot: string;
  goal: string;
  id?: string;
  mode?: BackgroundMode;
  status?: string;
  startedAt?: number;
  updatedAt?: number;
  creditsSpent?: number;
  budgetCredits?: number;
  milestones?: ReadonlyArray<BackgroundTaskSource>;
  tasks?: ReadonlyArray<BackgroundTaskSource>;
  lastEvent?: string;
  /** Why the run is not running, used as the last event when none was given. */
  error?: string;
  interrupted?: boolean;
}

export interface BackgroundParseResult {
  snapshot: BackgroundRunSnapshot | null;
  errors: string[];
}

export interface ResumeCheck {
  ok: boolean;
  reason?: string;
}

export interface BackgroundRunStore {
  /** Raw JSON strings, one per persisted run. */
  load: () => string[];
  save: (snapshot: BackgroundRunSnapshot) => void;
  remove: (runId: string) => void;
}

const STATUSES: readonly BackgroundStatus[] = ['running', 'paused', 'stopped', 'done', 'failed'];
const TASK_STATUSES: readonly BackgroundTaskStatus[] = ['pending', 'running', 'passed', 'failed', 'blocked'];

/**
 * Secrets still reach this module through a goal or an event line. They are
 * replaced, not persisted, so a shared screenshot of the resume prompt cannot
 * leak a key the run was started with.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(sk|rk|pk|ghp|gho|ghs|xox[abpr])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(api[-_]?key|access[-_]?token|secret|password|passwd)\s*[:=]\s*\S+/gi, '$1=[redacted]']
];

function redact(value: string, limit: number): string {
  const cleaned = SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim()
  );
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

/** One line: a goal or event is shown in chat, so newlines become spaces. */
function sanitizeText(value: string, limit: number): string {
  return redact(value.replace(/\s+/g, ' '), limit);
}

/** A path: whitespace is meaningful, so only control characters are removed. */
function sanitizePath(value: string, limit: number): string {
  return redact(value, limit);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function roundCredits(value: number): number {
  return Math.min(MAX_BACKGROUND_CREDITS, Math.round(Math.max(0, value) * 10) / 10);
}

function timestamp(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number >= 0 ? Math.floor(number) : fallback;
}

function attemptCount(value: unknown): number {
  const count = Array.isArray(value) ? value.length : value;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 0;
  return Math.min(MAX_BACKGROUND_ATTEMPTS, Math.floor(count));
}

function toBackgroundStatus(value: unknown, fallback: BackgroundStatus): BackgroundStatus {
  if (value === undefined) return fallback;
  if (value === 'running' || value === 'planning' || value === 'ready') return 'running';
  if (value === 'paused') return 'paused';
  if (value === 'done') return 'done';
  if (value === 'failed') return 'failed';
  return 'stopped';
}

function toTaskStatus(value: unknown): BackgroundTaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
    ? (value as BackgroundTaskStatus)
    : 'pending';
}

function formatCredits(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function defaultEvent(
  mode: BackgroundMode,
  status: BackgroundStatus,
  tasks: BackgroundTaskSummary[]
): string {
  const done = tasks.filter((task) => task.status === 'passed').length;
  return `${mode === 'team' ? 'Team' : 'Run'} ${status}: ${done} of ${tasks.length} tasks complete.`;
}

function summarizeTask(source: BackgroundTaskSource, index: number): BackgroundTaskSummary {
  const id = typeof source.id === 'string' ? sanitizeText(source.id, MAX_BACKGROUND_ID) : '';
  const title = typeof source.title === 'string' ? sanitizeText(source.title, MAX_BACKGROUND_TITLE) : '';
  return {
    id: id || `task-${index + 1}`,
    title: title || `Task ${index + 1}`,
    status: toTaskStatus(source.status),
    attempts: attemptCount(source.attempts)
  };
}

/**
 * Builds the snapshot written when a run is persisted or the app is closing.
 * Only the whitelisted fields below are copied, so a caller cannot smuggle file
 * contents or credentials in by attaching them to the run object.
 */
export function createBackgroundSnapshot(run: BackgroundRunSource): BackgroundRunSnapshot {
  if (!run || typeof run !== 'object') {
    throw new Error('createBackgroundSnapshot requires a run');
  }
  const workspaceRoot = typeof run.workspaceRoot === 'string'
    ? sanitizePath(run.workspaceRoot, MAX_BACKGROUND_ROOT)
    : '';
  if (!workspaceRoot) {
    throw new Error('createBackgroundSnapshot requires a workspaceRoot');
  }
  if (!isAbsoluteWorkspaceRoot(workspaceRoot)) {
    throw new Error('background snapshots require an absolute workspaceRoot');
  }
  const goal = typeof run.goal === 'string' ? sanitizeText(run.goal, MAX_BACKGROUND_GOAL) : '';
  if (!goal) {
    throw new Error('createBackgroundSnapshot requires a goal');
  }

  const startedAt = timestamp(run.startedAt, Date.now());
  const updatedAt = Math.max(startedAt, timestamp(run.updatedAt, startedAt));
  const sources = run.milestones ?? run.tasks ?? [];
  const tasks = sources.slice(0, MAX_BACKGROUND_TASKS).map(summarizeTask);
  const status = toBackgroundStatus(run.status, 'running');
  const mode: BackgroundMode = run.mode === 'team' ? 'team' : 'autonomy';
  const budget = roundCredits(finiteNumber(run.budgetCredits, DEFAULT_RUN_BUDGET.maxCredits));
  const event = typeof run.lastEvent === 'string'
    ? run.lastEvent
    : typeof run.error === 'string'
      ? run.error
      : '';

  return {
    version: BACKGROUND_SNAPSHOT_VERSION,
    runId: sanitizeText(typeof run.id === 'string' ? run.id : '', MAX_BACKGROUND_ID) || `run-${startedAt}`,
    workspaceRoot,
    goal,
    mode,
    status,
    startedAt,
    updatedAt,
    creditsSpent: roundCredits(finiteNumber(run.creditsSpent, 0)),
    budgetCredits: budget > 0 ? budget : DEFAULT_RUN_BUDGET.maxCredits,
    tasks,
    lastEvent: sanitizeText(event, MAX_BACKGROUND_EVENT) || defaultEvent(mode, status, tasks),
    interrupted: run.interrupted === true
  };
}

function isAbsoluteWorkspaceRoot(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\');
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith('\\\\');
}

function normalizeRoot(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

function sameWorkspace(left: string, right: string): boolean {
  const a = normalizeRoot(left);
  const b = normalizeRoot(right);
  if (!a || !b) return false;
  // Windows paths are case-insensitive; POSIX paths are not, and rewriting that
  // would resume a run in a sibling directory that only differs by case.
  return isWindowsPath(a) || isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Fixed key order, so the same snapshot always serializes to the same bytes. */
function canonicalSnapshot(snapshot: BackgroundRunSnapshot): BackgroundRunSnapshot {
  return {
    version: BACKGROUND_SNAPSHOT_VERSION,
    runId: snapshot.runId,
    workspaceRoot: snapshot.workspaceRoot,
    goal: snapshot.goal,
    mode: snapshot.mode,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    creditsSpent: snapshot.creditsSpent,
    budgetCredits: snapshot.budgetCredits,
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      attempts: task.attempts
    })),
    lastEvent: snapshot.lastEvent,
    interrupted: snapshot.interrupted
  };
}

export function serializeBackgroundSnapshot(snapshot: BackgroundRunSnapshot): string {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('serializeBackgroundSnapshot requires a snapshot');
  }
  return JSON.stringify(canonicalSnapshot(snapshot));
}

function readText(value: unknown, field: string, limit: number, errors: string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }
  return redact(value, limit);
}

function readNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[]
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number`);
    return null;
  }
  if (value < min || value > max) {
    errors.push(`${field} is out of range`);
    return null;
  }
  return value;
}

function readInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[]
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`${field} must be a whole number`);
    return null;
  }
  if (value < min || value > max) {
    errors.push(`${field} is out of range`);
    return null;
  }
  return value;
}

function readTasks(value: unknown, errors: string[]): BackgroundTaskSummary[] | null {
  if (!Array.isArray(value)) {
    errors.push('tasks must be an array');
    return null;
  }
  if (value.length > MAX_BACKGROUND_TASKS) {
    errors.push(`tasks must not have more than ${MAX_BACKGROUND_TASKS} entries`);
    return null;
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`tasks[${index}] must be an object`);
      return { id: '', title: '', status: 'pending' as const, attempts: 0 };
    }
    const task = entry as Record<string, unknown>;
    if (typeof task.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(task.status)) {
      errors.push(`tasks[${index}].status is not a known task status`);
    }
    return {
      id: readText(task.id, `tasks[${index}].id`, MAX_BACKGROUND_ID, errors),
      title: readText(task.title, `tasks[${index}].title`, MAX_BACKGROUND_TITLE, errors),
      status: toTaskStatus(task.status),
      attempts: readInteger(task.attempts, `tasks[${index}].attempts`, 0, MAX_BACKGROUND_ATTEMPTS, errors) ?? 0
    };
  });
}

/**
 * Reads a persisted snapshot and says exactly what is wrong with it. Never
 * throws and never returns a half-valid snapshot: `errors` non-empty means the
 * caller shows "that run cannot be restored" instead of a broken panel.
 */
export function parseBackgroundSnapshot(raw: string): BackgroundParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { snapshot: null, errors: ['the snapshot is empty'] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { snapshot: null, errors: ['the snapshot is not valid JSON'] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { snapshot: null, errors: ['the snapshot is not an object'] };
  }

  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];

  if (candidate.version !== BACKGROUND_SNAPSHOT_VERSION) {
    errors.push(`version must be ${BACKGROUND_SNAPSHOT_VERSION}`);
  }
  const runId = readText(candidate.runId, 'runId', MAX_BACKGROUND_ID, errors);
  const workspaceRoot = readText(candidate.workspaceRoot, 'workspaceRoot', MAX_BACKGROUND_ROOT, errors);
  const goal = readText(candidate.goal, 'goal', MAX_BACKGROUND_GOAL, errors);
  const lastEvent = readText(candidate.lastEvent, 'lastEvent', MAX_BACKGROUND_EVENT, errors);
  if (workspaceRoot && !isAbsoluteWorkspaceRoot(workspaceRoot)) {
    errors.push('workspaceRoot must be an absolute path');
  }
  if (workspaceRoot && hasTraversal(workspaceRoot)) {
    errors.push('workspaceRoot must not contain ".." segments');
  }

  if (candidate.mode !== 'autonomy' && candidate.mode !== 'team') {
    errors.push('mode must be "autonomy" or "team"');
  }
  if (typeof candidate.status !== 'string' || !(STATUSES as readonly string[]).includes(candidate.status)) {
    errors.push('status is not a known run status');
  }
  if (typeof candidate.interrupted !== 'boolean') {
    errors.push('interrupted must be a boolean');
  }

  const startedAt = readInteger(candidate.startedAt, 'startedAt', 0, Number.MAX_SAFE_INTEGER, errors);
  const updatedAt = readInteger(candidate.updatedAt, 'updatedAt', 0, Number.MAX_SAFE_INTEGER, errors);
  if (startedAt !== null && updatedAt !== null && updatedAt < startedAt) {
    errors.push('updatedAt must not precede startedAt');
  }
  const creditsSpent = readNumber(candidate.creditsSpent, 'creditsSpent', 0, MAX_BACKGROUND_CREDITS, errors);
  const budgetCredits = readNumber(candidate.budgetCredits, 'budgetCredits', 0, MAX_BACKGROUND_CREDITS, errors);
  if (budgetCredits !== null && budgetCredits <= 0) {
    errors.push('budgetCredits must be greater than zero');
  }

  const tasks = readTasks(candidate.tasks, errors);
  if (errors.length > 0) {
    return { snapshot: null, errors };
  }
  if (startedAt === null || updatedAt === null || creditsSpent === null || budgetCredits === null || tasks === null) {
    return { snapshot: null, errors: ['the snapshot is incomplete'] };
  }

  return {
    snapshot: {
      version: BACKGROUND_SNAPSHOT_VERSION,
      runId,
      workspaceRoot,
      goal,
      mode: candidate.mode as BackgroundMode,
      status: candidate.status as BackgroundStatus,
      startedAt,
      updatedAt,
      creditsSpent: roundCredits(creditsSpent),
      budgetCredits: roundCredits(budgetCredits),
      tasks,
      lastEvent,
      interrupted: candidate.interrupted as boolean
    },
    errors: []
  };
}

function copySnapshot(snapshot: BackgroundRunSnapshot): BackgroundRunSnapshot {
  return { ...snapshot, tasks: snapshot.tasks.map((task) => ({ ...task })) };
}

/**
 * Turns a snapshot that still claims to be running into one that admits it was
 * cut off. The status is the only claim that changes; `updatedAt` is preserved
 * so the resume prompt can say how stale the run is.
 */
export function settleInterrupted(snapshot: BackgroundRunSnapshot): BackgroundRunSnapshot {
  const copy = copySnapshot(snapshot);
  if (snapshot.status !== 'running') return copy;
  copy.status = 'paused';
  copy.interrupted = true;
  return copy;
}

function budgetRemaining(snapshot: BackgroundRunSnapshot): number {
  return Math.round((snapshot.budgetCredits - snapshot.creditsSpent) * 10) / 10;
}

/** A resume needs the same workspace, a paused run, and credit left to spend. */
export function canResume(snapshot: BackgroundRunSnapshot, currentWorkspaceRoot: string): ResumeCheck {
  if (snapshot.status !== 'paused') {
    return { ok: false, reason: `A ${snapshot.status} run cannot be resumed; only a paused run can.` };
  }
  if (!sameWorkspace(snapshot.workspaceRoot, currentWorkspaceRoot)) {
    return { ok: false, reason: `This run belongs to ${snapshot.workspaceRoot}, which is not the open workspace.` };
  }
  if (budgetRemaining(snapshot) < MIN_RESUME_CREDITS) {
    return {
      ok: false,
      reason: `The budget is spent (${formatCredits(snapshot.creditsSpent)} of ${formatCredits(snapshot.budgetCredits)} credits).`
    };
  }
  return { ok: true };
}

/** One line for the chat resume prompt: what is left and what it has cost. */
export function resumeSummary(snapshot: BackgroundRunSnapshot): string {
  const total = snapshot.tasks.length;
  const left = snapshot.tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
  const taskWord = total === 1 ? 'task' : 'tasks';
  const creditWord = snapshot.creditsSpent === 1 ? 'credit' : 'credits';
  return `Resume: ${left} of ${total} ${taskWord} left, ${formatCredits(snapshot.creditsSpent)} ${creditWord} spent of ${formatCredits(snapshot.budgetCredits)}.`;
}

function runIdOf(raw: string): string | null {
  return parseBackgroundSnapshot(raw).snapshot?.runId ?? null;
}

/**
 * The store the app injects with real storage. `load` hands back raw strings so
 * a corrupt entry can be reported and dropped rather than crashing the restore.
 */
export function createMemoryStore(
  initial: ReadonlyArray<string | BackgroundRunSnapshot> = []
): BackgroundRunStore {
  const entries: string[] = initial.map((entry) => (
    typeof entry === 'string' ? entry : serializeBackgroundSnapshot(entry)
  ));

  return {
    load: () => [...entries],
    save(snapshot: BackgroundRunSnapshot): void {
      if (!snapshot || typeof snapshot.runId !== 'string' || !snapshot.runId.trim()) {
        throw new Error('a background snapshot needs a runId');
      }
      const raw = serializeBackgroundSnapshot(snapshot);
      const index = entries.findIndex((existing) => runIdOf(existing) === snapshot.runId);
      if (index >= 0) entries[index] = raw;
      else entries.push(raw);
    },
    remove(runId: string): void {
      const remaining = entries.filter((existing) => runIdOf(existing) !== runId);
      entries.splice(0, entries.length, ...remaining);
    }
  };
}

function compareSnapshots(a: BackgroundRunSnapshot, b: BackgroundRunSnapshot): number {
  return b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId);
}

/** Every restorable snapshot, newest first. Unreadable entries are skipped. */
export function loadSnapshots(store: BackgroundRunStore): BackgroundRunSnapshot[] {
  let raw: string[] = [];
  try {
    raw = store.load();
  } catch {
    return [];
  }

  const byRunId = new Map<string, BackgroundRunSnapshot>();
  for (const entry of raw) {
    const { snapshot } = parseBackgroundSnapshot(entry);
    if (!snapshot) continue;
    const existing = byRunId.get(snapshot.runId);
    if (!existing || existing.updatedAt < snapshot.updatedAt) byRunId.set(snapshot.runId, snapshot);
  }
  return [...byRunId.values()].sort(compareSnapshots);
}

/** Keeps the most recently updated snapshots and forgets the rest. */
export function pruneSnapshots(store: BackgroundRunStore, keep = BACKGROUND_KEEP_LIMIT): BackgroundRunSnapshot[] {
  const limit = Math.max(0, Math.floor(keep));
  const snapshots = loadSnapshots(store);
  const kept = snapshots.slice(0, limit);
  const keptIds = new Set(kept.map((snapshot) => snapshot.runId));
  for (const snapshot of snapshots) {
    if (!keptIds.has(snapshot.runId)) store.remove(snapshot.runId);
  }
  return kept;
}
