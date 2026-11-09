import type { CalibratedRoute, CalibratedTaskType, OutcomeRecord, RouteProfile } from './types';

const KEY = 'shadrox.calibrated-auto.outcomes';
const MAX_RECORDS = 500;

function read(): OutcomeRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is OutcomeRecord => Boolean(item && typeof item === 'object' && typeof (item as OutcomeRecord).route === 'string')) : [];
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

export function routeProfiles(taskType?: CalibratedTaskType): RouteProfile[] {
  const records = read().filter((record) => !taskType || record.taskType === taskType);
  const routes: CalibratedRoute[] = ['reader', 'writer', 'frontier'];
  return routes.map((route) => {
    const entries = records.filter((record) => record.route === route);
    const attempts = entries.length;
    const passRate = attempts ? entries.filter((record) => record.passed && record.verified).length / attempts : 0.5;
    const averageRepairs = attempts ? entries.reduce((sum, record) => sum + Math.max(0, record.repairIterations), 0) / attempts : 0;
    const averageLatencyMs = attempts ? entries.reduce((sum, record) => sum + Math.max(0, record.latencyMs), 0) / attempts : 0;
    const averageTokens = attempts ? entries.reduce((sum, record) => sum + Math.max(0, record.inputTokens + record.outputTokens), 0) / attempts : 0;
    const score = passRate * 100 - averageRepairs * 12 - averageTokens / 20000 - averageLatencyMs / 120000;
    return { route, attempts, passRate, averageRepairs, averageLatencyMs, averageTokens, score };
  });
}
