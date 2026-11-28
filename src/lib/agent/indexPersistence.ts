import { getDesktopBridge } from '../desktop';
import { canUseIndexedDb } from '../persistence';

/**
 * Shared local large-index persistence layer for `semanticIndex.ts` and
 * `agent/repoMap.ts`. Handles snapshots exceeding the 1.5 MB `localStorage`
 * threshold via:
 *   1) Electron userData disk cache (`workspace:read-cache` / `write-cache`)
 *   2) Browser IndexedDB (`shadrox-index-cache`, bounded LRU of 20 entries)
 *   3) `localStorage` fast fallback when payload <= 1.5 MB
 *
 * Includes FNV-1a envelope checksum validation so corrupt/stale cache payloads
 * never poison startup state.
 */

export type WorkspaceCacheKey = 'semantic-index' | 'ory-tags';

export const MAX_LOCAL_STORAGE_CACHE_CHARS = 1_500_000;
export const MAX_DISK_CACHE_CHARS = 16_000_000;

const IDB_NAME = 'shadrox-index-cache';
const IDB_VERSION = 1;
const IDB_STORE = 'indexCache';
const IDB_MAX_ENTRIES = 20;

interface CacheEnvelope {
  v: 1;
  checksum: string;
  payload: string;
}

interface StoredIdbRecord {
  cacheKey: string;
  envelope: string;
  updatedAt: number;
}

/** Deterministic 32-bit FNV-1a hex checksum for content and cache validation. */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function wrapEnvelope(payload: string): string {
  const envelope: CacheEnvelope = {
    v: 1,
    checksum: fnv1aHash(payload),
    payload
  };
  return JSON.stringify(envelope);
}

function unwrapEnvelope(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CacheEnvelope>;
    if (!parsed || parsed.v !== 1 || typeof parsed.payload !== 'string' || typeof parsed.checksum !== 'string') {
      return null;
    }
    if (fnv1aHash(parsed.payload) !== parsed.checksum) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function requestResult<T>(request: IDBRequest): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => resolve(null);
  });
}

function openIndexCacheDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'cacheKey' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function pruneOldIdbEntries(store: IDBObjectStore): Promise<void> {
  const all = await requestResult<StoredIdbRecord[]>(store.getAll());
  if (!all || all.length <= IDB_MAX_ENTRIES) return;
  const oldest = all.slice().sort((a, b) => a.updatedAt - b.updatedAt).slice(0, all.length - IDB_MAX_ENTRIES);
  for (const record of oldest) {
    store.delete(record.cacheKey);
  }
}

async function writeIdbEnvelope(cacheKey: string, envelope: string): Promise<void> {
  const db = await openIndexCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.put({ cacheKey, envelope, updatedAt: Date.now() } satisfies StoredIdbRecord);
    await pruneOldIdbEntries(store);
    await transactionDone(tx);
  } catch {
    /* IndexedDB best-effort */
  } finally {
    db.close();
  }
}

async function readIdbEnvelope(cacheKey: string): Promise<string | null> {
  const db = await openIndexCacheDb();
  if (!db) return null;
  try {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const record = await requestResult<StoredIdbRecord>(store.get(cacheKey));
    return typeof record?.envelope === 'string' ? record.envelope : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Persist a workspace index payload beyond `localStorage` limits.
 * Small payloads write synchronously-fast to `localStorage` as well; large
 * payloads (>1.5 MB) remove stale `localStorage` entries and store safely in
 * Electron userData cache and/or IndexedDB.
 */
export async function saveWorkspaceIndexCache(
  workspaceId: string,
  key: WorkspaceCacheKey,
  payload: string,
  localStorageKey?: string
): Promise<void> {
  if (!workspaceId || payload.length > MAX_DISK_CACHE_CHARS) return;

  if (localStorageKey && typeof localStorage !== 'undefined') {
    try {
      if (payload.length <= MAX_LOCAL_STORAGE_CACHE_CHARS) {
        localStorage.setItem(localStorageKey, payload);
      } else {
        localStorage.removeItem(localStorageKey);
      }
    } catch {
      /* localStorage quota exceeded — fall through to disk / IndexedDB */
    }
  }

  const envelope = wrapEnvelope(payload);
  if (envelope.length > MAX_DISK_CACHE_CHARS) return;

  const desktop = getDesktopBridge();
  if (desktop?.writeWorkspaceCache) {
    try {
      await desktop.writeWorkspaceCache(workspaceId, key, envelope);
    } catch {
      /* disk cache best-effort */
    }
  }

  await writeIdbEnvelope(`${key}:${workspaceId}`, envelope);
}

/**
 * Load a persisted workspace index payload from Electron disk cache, IndexedDB,
 * or `localStorage`, verifying envelope FNV-1a integrity when wrapped.
 */
export async function loadWorkspaceIndexCache(
  workspaceId: string,
  key: WorkspaceCacheKey,
  localStorageKey?: string
): Promise<string | null> {
  if (!workspaceId) return null;

  const desktop = getDesktopBridge();
  if (desktop?.readWorkspaceCache) {
    try {
      const diskRaw = await desktop.readWorkspaceCache(workspaceId, key);
      if (typeof diskRaw === 'string' && diskRaw.length > 0) {
        const unwrapped = unwrapEnvelope(diskRaw);
        if (unwrapped !== null) return unwrapped;
      }
    } catch {
      /* fall through to IndexedDB / localStorage */
    }
  }

  const idbRaw = await readIdbEnvelope(`${key}:${workspaceId}`);
  if (idbRaw) {
    const unwrapped = unwrapEnvelope(idbRaw);
    if (unwrapped !== null) return unwrapped;
  }

  if (localStorageKey && typeof localStorage !== 'undefined') {
    try {
      const localRaw = localStorage.getItem(localStorageKey);
      if (typeof localRaw === 'string' && localRaw.length > 0) return localRaw;
    } catch {
      /* ignore */
    }
  }

  return null;
}
