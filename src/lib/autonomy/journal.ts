/**
 * The run journal: what a run did, kept after the tab closes.
 *
 * The panel's log is React state, so a crash or a reload erases the only account
 * of the steps that led to it. The journal is the durable copy of those same
 * lines — append-only, capped, and redacted before it reaches storage, because a
 * log written by a run that was handed provider keys must not become the thing
 * that leaks them. It records nothing the engine did not already announce on
 * `onEvent`, so there is no second, quieter path for an action to be reported.
 */

import { redactSecrets } from '../secrets';
import type { RunStorage } from './runStore';

export interface JournalEntry {
  /** When the event was announced, epoch milliseconds. */
  at: number;
  /** The run that wrote it, so a resumed run continues its own history. */
  runId?: string;
  /** The readable line, already redacted and capped. */
  text: string;
}

export interface RunJournal {
  /** Records one line. Returns the entry, or null when storage refused it. */
  append: (text: string, runId?: string) => JournalEntry | null;
  /** Everything still kept, oldest first; a `runId` narrows it to one run. */
  entries: (runId?: string) => JournalEntry[];
  /** The readable tail of `entries`, in the same order. */
  lines: (runId?: string) => string[];
}

/** How many lines a workspace keeps. The journal is a tail, not an archive. */
export const MAX_JOURNAL_ENTRIES = 500;

/** One event is worth one readable line; a whole file dump is not a log line. */
export const MAX_JOURNAL_CHARS = 400;

const KEY_PREFIX = 'shadrox.autonomy.journal';

function keyFor(rootPath: string): string {
  return `${KEY_PREFIX}:${rootPath || 'default'}`;
}

function toEntry(value: unknown): JournalEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JournalEntry>;
  if (typeof candidate.text !== 'string' || typeof candidate.at !== 'number') return null;
  if (candidate.runId !== undefined && typeof candidate.runId !== 'string') return null;
  return { at: candidate.at, text: candidate.text, ...(candidate.runId ? { runId: candidate.runId } : {}) };
}

function cap(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_JOURNAL_CHARS ? `${trimmed.slice(0, MAX_JOURNAL_CHARS - 1)}…` : trimmed;
}

/** Wrap a storage backend. A `null` backend gives a journal that remembers nothing. */
export function createRunJournal(
  storage: RunStorage | null,
  rootPath: string,
  options: { now?: () => number } = {}
): RunJournal {
  const now = options.now ?? Date.now;
  if (!storage) return { append: () => null, entries: () => [], lines: () => [] };

  const read = (): JournalEntry[] => {
    try {
      const raw = storage.getItem(keyFor(rootPath));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(toEntry).filter((entry): entry is JournalEntry => entry !== null);
    } catch {
      // A half-written blob is a journal nobody can read, not a crashed panel.
      return [];
    }
  };

  const entries = (runId?: string): JournalEntry[] => {
    const all = read();
    return runId ? all.filter((entry) => entry.runId === runId) : all;
  };

  return {
    append(text, runId) {
      const line = cap(redactSecrets(text));
      if (!line) return null;
      const entry: JournalEntry = { at: now(), text: line, ...(runId ? { runId } : {}) };
      const next = [...read(), entry].slice(-MAX_JOURNAL_ENTRIES);
      try {
        storage.setItem(keyFor(rootPath), JSON.stringify(next));
      } catch {
        // Quota or private mode: a run whose journal could not be written still runs.
        return null;
      }
      return entry;
    },
    entries,
    lines: (runId) => entries(runId).map((entry) => entry.text)
  };
}

/** The browser-backed journal, or a forgetful one where there is no storage. */
export function browserRunJournal(rootPath: string | null): RunJournal {
  try {
    return createRunJournal(typeof window === 'undefined' ? null : window.localStorage, rootPath ?? '');
  } catch {
    return createRunJournal(null, rootPath ?? '');
  }
}
