import { scrubWorkspaceText } from '../envSafety';
import { INTENT_FORMAT, INTENT_VERSION, type DecisionInput, type DecisionPatch, type IntentDecision, type IntentExport } from './types';
import { normalizeIntentPath, refreshDecisionStatuses } from './graph';

const PREFIX = 'shadrox.intent.';

function key(workspaceRoot: string): string {
  return `${PREFIX}${workspaceRoot}`;
}

function available(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function read(workspaceRoot: string): IntentDecision[] {
  if (!available()) return [];
  try {
    const raw = window.localStorage.getItem(key(workspaceRoot));
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isDecision) : [];
  } catch {
    return [];
  }
}

function write(workspaceRoot: string, decisions: readonly IntentDecision[]): boolean {
  if (!available()) return false;
  try {
    window.localStorage.setItem(key(workspaceRoot), JSON.stringify(decisions));
    return true;
  } catch {
    return false;
  }
}

function isDecision(value: unknown): value is IntentDecision {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<IntentDecision>;
  return typeof item.id === 'string' && typeof item.workspaceRoot === 'string' &&
    typeof item.title === 'string' && typeof item.body === 'string' &&
    Array.isArray(item.targets) && typeof item.baseHashes === 'object';
}

export function listDecisions(workspaceRoot: string): IntentDecision[] {
  return read(workspaceRoot).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createDecision(input: DecisionInput): IntentDecision {
  const now = Date.now();
  return {
    id: `dec-${now}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceRoot: input.workspaceRoot,
    createdAt: now,
    updatedAt: now,
    kind: input.kind,
    title: scrubWorkspaceText(input.title).trim(),
    body: scrubWorkspaceText(input.body).trim(),
    targets: input.targets.map((target) => ({ path: normalizeIntentPath(target.path), ...(target.symbol ? { symbol: target.symbol } : {}) })),
    baseHashes: { ...input.baseHashes },
    status: 'fresh',
    source: input.source ?? 'user',
    capsuleRef: input.capsuleRef ?? null
  };
}

export function saveDecision(decision: IntentDecision): boolean {
  const decisions = read(decision.workspaceRoot).filter((item) => item.id !== decision.id);
  return write(decision.workspaceRoot, [...decisions, {
    ...decision,
    title: scrubWorkspaceText(decision.title).trim(),
    body: scrubWorkspaceText(decision.body).trim(),
    updatedAt: Date.now()
  }]);
}

export function updateDecision(id: string, workspaceRoot: string, patch: DecisionPatch): IntentDecision | null {
  const existing = read(workspaceRoot).find((decision) => decision.id === id);
  if (!existing) return null;
  const updated: IntentDecision = {
    ...existing,
    ...patch,
    title: scrubWorkspaceText(patch.title ?? existing.title).trim(),
    body: scrubWorkspaceText(patch.body ?? existing.body).trim(),
    updatedAt: Date.now()
  };
  return saveDecision(updated) ? updated : null;
}

export function deleteDecision(id: string, workspaceRoot: string): boolean {
  return write(workspaceRoot, read(workspaceRoot).filter((decision) => decision.id !== id));
}

export function exportIntent(workspaceRoot: string): IntentExport {
  return { format: INTENT_FORMAT, version: INTENT_VERSION, exportedAt: Date.now(), workspaceRoot, decisions: listDecisions(workspaceRoot) };
}

export function importIntent(data: unknown, workspaceRoot: string): { imported: number; skipped: number; errors: string[] } {
  if (!data || typeof data !== 'object' || (data as IntentExport).format !== INTENT_FORMAT || (data as IntentExport).version !== INTENT_VERSION || !Array.isArray((data as IntentExport).decisions)) {
    return { imported: 0, skipped: 0, errors: ['invalid intent graph export'] };
  }
  const existing = read(workspaceRoot);
  const ids = new Set(existing.map((decision) => decision.id));
  let imported = 0;
  let skipped = 0;
  for (const decision of (data as IntentExport).decisions) {
    if (!isDecision(decision) || ids.has(decision.id)) { skipped += 1; continue; }
    existing.push({ ...decision, workspaceRoot });
    ids.add(decision.id);
    imported += 1;
  }
  if (imported > 0) write(workspaceRoot, existing);
  return { imported, skipped, errors: [] };
}

export function refreshStoredStatuses(workspaceRoot: string, hashes: Record<string, string>): IntentDecision[] {
  const refreshed = refreshDecisionStatuses(read(workspaceRoot), hashes);
  write(workspaceRoot, refreshed);
  return refreshed;
}
