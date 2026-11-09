import { canUseIndexedDb } from '../persistence';
import { redactCapsule, sealCapsule, verifyCapsuleIntegrity } from './redactor';
import { CAPSULE_FORMAT, CAPSULE_VERSION, type CapsuleExport, type ChangeCapsule } from './types';

/**
 * Local capsule storage, mirroring history.ts: a singleton openDb promise that
 * resolves null when IndexedDB is unavailable (plain node / isolated preview),
 * so every public fn gracefully no-ops instead of throwing.
 */

const DB_NAME = 'shadrox-capsules';
const DB_VERSION = 1;
const CAPSULES = 'capsules';
const MAX_CAPSULES_PER_WORKSPACE = 50;

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
      if (!db.objectStoreNames.contains(CAPSULES)) {
        const store = db.createObjectStore(CAPSULES, { keyPath: 'id' });
        store.createIndex('workspaceRoot', 'workspaceRoot', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
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

export async function saveCapsule(capsule: ChangeCapsule): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const tx = db.transaction(CAPSULES, 'readwrite');
  tx.objectStore(CAPSULES).put(capsule);
  await transactionDone(tx);
  return true;
}

export async function listCapsules(workspaceRoot: string): Promise<ChangeCapsule[]> {
  const db = await openDb();
  if (!db) return [];
  const tx = db.transaction(CAPSULES, 'readonly');
  const index = tx.objectStore(CAPSULES).index('workspaceRoot');
  const rows = await requestResult<ChangeCapsule[]>(index.getAll(workspaceRoot));
  return (rows ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCapsule(id: string): Promise<ChangeCapsule | null> {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(CAPSULES, 'readonly');
  return requestResult<ChangeCapsule>(tx.objectStore(CAPSULES).get(id));
}

export async function deleteCapsule(id: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const tx = db.transaction(CAPSULES, 'readwrite');
  tx.objectStore(CAPSULES).delete(id);
  await transactionDone(tx);
  return true;
}

export async function pruneCapsules(workspaceRoot: string, max = MAX_CAPSULES_PER_WORKSPACE): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const tx = db.transaction(CAPSULES, 'readwrite');
  const store = tx.objectStore(CAPSULES);
  const index = store.index('workspaceRoot');
  const rows = (await requestResult<ChangeCapsule[]>(index.getAll(workspaceRoot))) ?? [];
  const excess = rows.sort((a, b) => b.createdAt - a.createdAt).slice(max);
  excess.forEach((row) => store.delete(row.id));
  await transactionDone(tx);
  return excess.length;
}

export async function exportCapsules(workspaceRoot: string): Promise<CapsuleExport> {
  return {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    exportedAt: Date.now(),
    capsules: await listCapsules(workspaceRoot)
  };
}

function isExportEnvelope(data: unknown): data is CapsuleExport {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as CapsuleExport).format === CAPSULE_FORMAT &&
    (data as CapsuleExport).version === CAPSULE_VERSION &&
    Array.isArray((data as CapsuleExport).capsules)
  );
}

function isCapsuleShape(value: unknown): value is ChangeCapsule {
  if (typeof value !== 'object' || value === null) return false;
  const capsule = value as Partial<ChangeCapsule>;
  return (
    typeof capsule.id === 'string' &&
    capsule.id.length > 0 &&
    typeof capsule.taskId === 'string' &&
    typeof capsule.workspaceRoot === 'string' &&
    Array.isArray(capsule.diffs)
  );
}

export async function importCapsules(
  data: unknown,
  workspaceRoot: string
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  // Envelope validation runs before the no-db short-circuit so a malformed
  // export is reported honestly even where local storage is unavailable.
  if (!isExportEnvelope(data)) {
    return { imported: 0, skipped: 0, errors: ['invalid capsule export'] };
  }
  const db = await openDb();
  if (!db) {
    return { imported: 0, skipped: 0, errors: ['local storage unavailable'] };
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const raw of data.capsules) {
    if (!isCapsuleShape(raw)) {
      skipped += 1;
      errors.push('invalid capsule shape');
      continue;
    }
    if (!(await verifyCapsuleIntegrity(raw))) {
      skipped += 1;
      errors.push(`integrity check failed: ${raw.id}`);
      continue;
    }
    // Defense-in-depth: imported content is re-scrubbed and resealed, and its
    // workspaceRoot remapped to the target before the seal recomputes selfHash.
    const { capsule: redacted } = redactCapsule(raw);
    const resealed = await sealCapsule({ ...redacted, workspaceRoot });
    if (await getCapsule(resealed.id)) {
      skipped += 1;
      continue;
    }
    if (await saveCapsule(resealed)) {
      imported += 1;
    } else {
      skipped += 1;
      errors.push(`save failed: ${resealed.id}`);
    }
  }

  return { imported, skipped, errors };
}
