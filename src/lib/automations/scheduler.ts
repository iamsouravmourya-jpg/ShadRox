/**
 * Deterministic scheduler for local automations.
 *
 * These functions are pure: the caller supplies the clock and owns when a
 * request is actually executed. `dueAutomations` only proposes interval runs;
 * `consumeBudget` is the single place that may increment the daily counter, so
 * the run loop must call it before dispatching an action.
 */

import type {
  AutomationDefinition,
  AutomationRunRequest,
  AutomationState,
  BudgetDecision
} from './types';

const MINUTE_MS = 60_000;

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** Reject absolute paths, drive letters, traversal and empty segments. */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  const normalized = normalizeRelativePath(path.trim());
  if (!normalized) return false;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  if (/[\u0000-\u001f]/.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '' && segment !== '..');
}

/** A save trigger glob must be a safe relative pattern; `*`, `?` and `**` are allowed. */
export function isSafeGlob(glob: string): boolean {
  if (typeof glob !== 'string') return false;
  return glob.trim() !== '' && isSafeRelativePath(glob);
}

function globToRegExp(glob: string): RegExp {
  const source = normalizeRelativePath(glob.trim());
  let pattern = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          index += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  pattern += '$';
  return new RegExp(pattern);
}

export function matchGlob(glob: string, relativePath: string): boolean {
  if (!isSafeGlob(glob) || !isSafeRelativePath(relativePath)) return false;
  return globToRegExp(glob).test(normalizeRelativePath(relativePath.trim()));
}

function compareIds(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function dayKey(now: number): string {
  if (!Number.isFinite(now)) return 'invalid';
  return new Date(now).toISOString().slice(0, 10);
}

/** The earliest moment the interval trigger may fire again, or null if it never can. */
export function nextRunAt(
  definition: AutomationDefinition,
  state: AutomationState
): number | null {
  if (definition.trigger.type !== 'interval') return null;
  const minutes = definition.trigger.minutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const anchor = state.lastRunAt ?? state.createdAt;
  if (!Number.isFinite(anchor)) return null;
  return anchor + minutes * MINUTE_MS;
}

function toRequest(
  definition: AutomationDefinition,
  reason: 'interval' | 'onSave',
  requestedAt?: number
): AutomationRunRequest {
  return {
    automationId: definition.id,
    name: definition.name,
    trigger: definition.trigger.type,
    action: definition.action,
    credits: definition.creditsPerRun,
    reason,
    ...(requestedAt === undefined ? {} : { requestedAt })
  };
}

/**
 * Interval definitions that are due at `now`, ordered by id.
 *
 * `states` may be the array the app persists or a map keyed by id. A missing
 * state means the caller never initialized this definition; it is skipped
 * rather than guessed, because `createdAt` is the anchor that keeps a fresh
 * install from running every automation immediately.
 */
export function dueAutomations(
  definitions: readonly AutomationDefinition[],
  states: readonly AutomationState[] | Record<string, AutomationState>,
  now: number
): AutomationRunRequest[] {
  const stateById =
    Array.isArray(states)
      ? new Map(states.map((state) => [state.id, state]))
      : new Map(Object.entries(states as Record<string, AutomationState>));
  const requests: AutomationRunRequest[] = [];
  const sorted = [...definitions].sort(compareIds);
  for (const definition of sorted) {
    if (!definition.enabled || definition.trigger.type !== 'interval') continue;
    const state = stateById.get(definition.id);
    if (!state) continue;
    const next = nextRunAt(definition, state);
    if (next === null || now < next) continue;
    requests.push(toRequest(definition, 'interval', now));
  }
  return requests;
}

/** Enabled save definitions whose glob covers `relativePath`, ordered by id. */
export function evaluateSaveTriggers(
  definitions: readonly AutomationDefinition[],
  relativePath: string
): AutomationRunRequest[] {
  if (!isSafeRelativePath(relativePath)) return [];
  const path = normalizeRelativePath(relativePath.trim());
  const requests: AutomationRunRequest[] = [];
  const sorted = [...definitions].sort(compareIds);
  for (const definition of sorted) {
    if (!definition.enabled || definition.trigger.type !== 'onSave') continue;
    if (!matchGlob(definition.trigger.glob, path)) continue;
    requests.push(toRequest(definition, 'onSave'));
  }
  return requests;
}

/**
 * Reserve one run against the definition's daily cap.
 *
 * The returned state must be persisted only when `allowed` is true; a refused
 * decision returns the existing state untouched. The UTC day rollover resets the
 * count, and a successful reservation records `lastRunAt` for the interval
 * scheduler. Spending is deliberately counted here, before dispatch, so a failed
 * action cannot be retried for free in a loop.
 */
export function consumeBudget(
  state: AutomationState,
  definition: AutomationDefinition,
  now: number
): BudgetDecision {
  const today = dayKey(now);
  const runsToday = state.dayKey === today ? state.runCount : 0;
  const cap = definition.maxRunsPerDay;
  if (typeof cap === 'number' && Number.isFinite(cap) && runsToday >= cap) {
    return {
      allowed: false,
      state: { ...state, dayKey: today, runCount: runsToday },
      reason: `daily cap reached (${runsToday}/${cap}) for automation "${definition.id}"`
    };
  }
  return {
    allowed: true,
    state: {
      ...state,
      dayKey: today,
      runCount: runsToday + 1,
      lastRunAt: now
    }
  };
}
