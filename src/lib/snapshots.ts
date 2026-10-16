import type { WorkspaceFile } from './types';

/** A remembered copy of a workspace so "Recently opened" never has to re-ask for the folder. */
export interface WorkspaceSnapshot {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  files: WorkspaceFile[];
  savedAt: number;
}

const DB_NAME = 'devora-workspace';
const DB_VERSION = 1;
const STORE = 'snapshots';

/**
 * IndexedDB is used instead of localStorage because a mounted folder can hold
 * hundreds of files and would blow past the ~5 MB localStorage quota.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function createDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

export async function getSnapshot(path: string): Promise<WorkspaceSnapshot | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(path);
    request.onsuccess = () => resolve((request.result as WorkspaceSnapshot) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function saveSnapshot(snapshot: Omit<WorkspaceSnapshot, 'savedAt'>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...snapshot, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Drops snapshots whose workspace is no longer in the recent list. */
export async function pruneSnapshots(keepPaths: string[]): Promise<void> {
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
