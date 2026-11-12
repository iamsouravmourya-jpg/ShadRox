/**
 * The user's own say in the routing decision.
 *
 * ShadRox can rank models by what it measured, but the person paying the
 * provider's bill outranks the measurement: a pinned model is placed first
 * whatever the ledger says, and pinning is reversible from the same panel that
 * set it. Nothing here is a hint the router may ignore — that would make the
 * control a decoration.
 */

import type { CalibratedTaskType } from './types';

const KEY = 'shadrox.calibrated-auto.preferences';

/** Per-task model pins. A missing or null entry means "ShadRox may choose". */
export type ModelPreferences = Partial<Record<CalibratedTaskType, string | null>>;

const TASK_TYPES: CalibratedTaskType[] = ['refactor', 'bugfix', 'feature', 'test', 'chat'];

function coerce(value: unknown): ModelPreferences {
  const preferences: ModelPreferences = {};
  if (!value || typeof value !== 'object') return preferences;
  for (const taskType of TASK_TYPES) {
    const pinned = (value as Record<string, unknown>)[taskType];
    if (typeof pinned === 'string' && pinned.trim()) preferences[taskType] = pinned.trim();
  }
  return preferences;
}

function read(): ModelPreferences {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return coerce(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

export function listPreferences(): ModelPreferences {
  return read();
}

/** The model the user pinned for this task type, or null when routing is theirs. */
export function preferredModel(taskType: CalibratedTaskType): string | null {
  return read()[taskType] ?? null;
}

/**
 * Pin or un-pin a model and return the whole map, so one call can both write
 * and repaint the panel. Passing null hands the choice back to the router.
 */
export function setPreferredModel(taskType: CalibratedTaskType, model: string | null): ModelPreferences {
  const next = { ...read(), [taskType]: model && model.trim() ? model.trim() : null };
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage is optional */
  }
  return next;
}
