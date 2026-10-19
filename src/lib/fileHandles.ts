import type { HandleEntry } from './workspace';
import { canUseIndexedDb } from './persistence';

/**
 * File System Access handles survive a page reload when kept in IndexedDB.
 *
 * A stored handle is not a permission grant — the browser still asks the user
 * once after a refresh — but without it there would be no way back to the file
 * at all, because handles cannot be reconstructed from a path.
 */
const DB_NAME = 'shadrox-handles';
const DB_VERSION = 1;
const STORE = 'handles';

interface HandleRecord {
  workspacePath: string;
  entries: HandleEntry[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function createDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!canUseIndexedDb()) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'workspacePath' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

export async function saveHandles(workspacePath: string, entries: HandleEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ workspacePath, entries, savedAt: Date.now() } satisfies HandleRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Handles saved during an earlier session, or `[]` when there are none. */
export async function loadHandles(workspacePath: string): Promise<HandleEntry[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(workspacePath);
    request.onsuccess = () => resolve((request.result as HandleRecord | undefined)?.entries ?? []);
    request.onerror = () => resolve([]);
  });
}

export async function dropHandles(workspacePath: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(workspacePath);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Drops handle records for workspaces that are no longer in the recent list. */
export async function pruneHandles(keepPaths: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const keep = new Set(keepPaths);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      request.result.forEach((key) => {
        if (!keep.has(String(key))) store.delete(key);
      });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
