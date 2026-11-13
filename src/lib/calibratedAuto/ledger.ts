import { isProven, poolPrior, shrunkPassRate } from './statistics';
import type { CalibratedRoute, CalibratedTaskType, OutcomeRecord, RouteProfile } from './types';

const KEY = 'shadrox.calibrated-auto.outcomes';
const MAX_RECORDS = 500;
const TASK_TYPES: CalibratedTaskType[] = ['refactor', 'bugfix', 'feature', 'test', 'chat'];
const ROUTES: CalibratedRoute[] = ['reader', 'writer', 'frontier'];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Records come from localStorage, where anything can live. A malformed number
 * must not silently become `NaN` and poison every average, so each field is
 * re-checked on the way in and the record is dropped when the parts an outcome
 * is judged from are missing.
 */
function coerce(value: unknown): OutcomeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<OutcomeRecord>;
  if (typeof record.route !== 'string' || typeof record.model !== 'string') return null;
  if (typeof record.passed !== 'boolean' || typeof record.verified !== 'boolean') return null;
  return {
    id: typeof record.id === 'string' ? record.id : `outcome-${record.model}`,
    createdAt: number(record.createdAt, 0),
    taskType: oneOf(record.taskType, TASK_TYPES, 'chat'),
    route: oneOf(record.route, ROUTES, 'writer'),
    model: record.model,
    passed: record.passed,
    verified: record.verified,
    reason: typeof record.reason === 'string' ? record.reason : 'recorded before outcomes carried a reason',
    repairIterations: number(record.repairIterations, 0),
    inputTokens: number(record.inputTokens, 0),
    outputTokens: number(record.outputTokens, 0),
    latencyMs: number(record.latencyMs, 0)
  };
}

function read(): OutcomeRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.map(coerce).filter((item): item is OutcomeRecord => item !== null) : [];
  } catch {
    return [];
  }
}

function write(records: readonly OutcomeRecord[]): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(records.slice(-MAX_RECORDS))); } catch { /* storage is optional */ }
}

export function listOutcomes(): OutcomeRecord[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

export function recordOutcome(input: Omit<OutcomeRecord, 'id' | 'createdAt'>): OutcomeRecord {
  const record = { ...input, id: `outcome-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
  write([...read(), record]);
  return record;
}

/**
 * Per-route profiles, drawn only from verified turns.
 *
 * `passRate` and `score` are null when a route has no verified evidence: the
 * caller must then fall back to its default rather than to a fabricated 50%
 * that looks like a measurement.
 */
export function routeProfiles(taskType?: CalibratedTaskType): RouteProfile[] {
  const records = read().filter((record) => !taskType || record.taskType === taskType);
  const routes = ROUTES;
  const prior = poolPrior(routes.map((route) => {
    const verified = records.filter((record) => record.route === route && record.verified);
    return { passes: verified.filter((record) => record.passed).length, runs: verified.length };
  }));
  return routes.map((route) => {
    const entries = records.filter((record) => record.route === route);
    const verified = entries.filter((record) => record.verified);
    const passes = verified.filter((record) => record.passed).length;
    const averageRepairs = entries.length ? entries.reduce((sum, record) => sum + record.repairIterations, 0) / entries.length : 0;
    const averageLatencyMs = entries.length ? entries.reduce((sum, record) => sum + record.latencyMs, 0) / entries.length : 0;
    const averageTokens = entries.length ? entries.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0) / entries.length : 0;
    const passRate = shrunkPassRate(passes, verified.length, prior);
    // Cost and latency are only ever penalties: without a proven pass rate
    // there is no score to compare, and an unproven route must not look cheap
    // and therefore good.
    const score = passRate === null
      ? null
      : passRate * 100 - averageRepairs * 12 - averageTokens / 20000 - averageLatencyMs / 120000;
    return {
      route,
      attempts: entries.length,
      verifiedAttempts: verified.length,
      unverifiedAttempts: entries.length - verified.length,
      passRate,
      averageRepairs,
      averageLatencyMs,
      averageTokens,
      score
    };
  });
}

/** Whether a route has enough verified history to be chosen on its record. */
export function routeIsProven(profile: RouteProfile): boolean {
  return isProven(profile.verifiedAttempts);
}
