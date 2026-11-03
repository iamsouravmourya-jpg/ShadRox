/**
 * Where a run's state survives a reload.
 *
 * The engine persists after every verdict, so the worst a crash can cost is the
 * milestone in flight. The store is deliberately defensive: a corrupt or
 * foreign blob is treated as "no run" rather than crashing the panel, because
 * this is the one place a bad byte on disk could otherwise take the app down.
 */

import type { Milestone, RunState } from './types';

export interface RunStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface RunStore {
  save: (rootPath: string, state: RunState) => void;
  load: (rootPath: string) => RunState | null;
  clear: (rootPath: string) => void;
}

const KEY_PREFIX = 'shadrox.autonomy.run';

function keyFor(rootPath: string): string {
  return `${KEY_PREFIX}:${rootPath || 'default'}`;
}

/** Validate just enough that the panel cannot render a half-shape. */
export function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RunState>;
  if (typeof candidate.goal !== 'string' || typeof candidate.status !== 'string') return false;
  if (typeof candidate.creditsSpent !== 'number' || typeof candidate.startedAt !== 'number') return false;
  if (!Array.isArray(candidate.milestones)) return false;
  return candidate.milestones.every((milestone) => {
    const entry = milestone as Partial<Milestone>;
    return Boolean(entry)
      && typeof entry.id === 'string'
      && typeof entry.title === 'string'
      && Array.isArray(entry.attempts);
  });
}

/** Wrap a storage backend. A `null` backend gives a store that forgets by design. */
export function createRunStore(storage: RunStorage | null): RunStore {
  if (!storage) {
    return { save: () => undefined, load: () => null, clear: () => undefined };
  }
  return {
    save(rootPath, state) {
      try {
        storage.setItem(keyFor(rootPath), JSON.stringify(state));
      } catch {
        // Quota or private mode: a run that cannot be persisted still runs.
      }
    },
    load(rootPath) {
      try {
        const raw = storage.getItem(keyFor(rootPath));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isRunState(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    clear(rootPath) {
      try {
        storage.removeItem(keyFor(rootPath));
      } catch {
        // A failed clear only means the next load sees a stale run.
      }
    }
  };
}

/** The browser-backed store, or a no-op when there is no storage (SSR/tests). */
export function browserRunStore(): RunStore {
  try {
    return createRunStore(typeof window === 'undefined' ? null : window.localStorage);
  } catch {
    return createRunStore(null);
  }
}
