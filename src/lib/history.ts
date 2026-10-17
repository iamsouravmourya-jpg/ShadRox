import { detectLanguage } from './languages';
import type { WorkspaceFile } from './types';

/**
 * Content-addressed version history.
 *
 * Every checkpoint stores file *hashes*, not file bodies. A folder of 400 files
 * checked after each chat turn would otherwise duplicate megabytes again and
 * again; instead identical content is stored exactly once and shared.
 */
export interface Checkpoint {
  id: string;
  workspacePath: string;
  /** Chat message this checkpoint belongs to, so the chat can offer a restore. */
  messageId: string;
  label: string;
  createdAt: number;
  files: Array<{ name: string; hash: string }>;
}

/** Everything the UI needs, without the (potentially large) file list. */
export interface CheckpointMeta {
  id: string;
  messageId: string;
  label: string;
  createdAt: number;
  fileCount: number;
}

const DB_NAME = 'shadrox-history';
const DB_VERSION = 1;
const CHECKPOINTS = 'checkpoints';
const BLOBS = 'blobs';
const FIELD_LABEL_CHARS = 90;
/** Old checkpoints are dropped past this point so history cannot grow forever. */
const MAX_CHECKPOINTS_PER_WORKSPACE = 50;

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
      if (!db.objectStoreNames.contains(CHECKPOINTS)) {
        const store = db.createObjectStore(CHECKPOINTS, { keyPath: 'id' });
        store.createIndex('workspacePath', 'workspacePath', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'hash' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

/** SHA-256 when the page is a secure context, with a cheap fallback otherwise. */
async function hashContent(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      /* fall through to the non-crypto hash */
    }
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv${(hash >>> 0).toString(16)}`;
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

/** Stores a checkpoint of the current files, deduplicating content through blobs. */
export async function saveCheckpoint(input: {
  workspacePath: string;
  messageId: string;
  label: string;
  files: WorkspaceFile[];
}): Promise<CheckpointMeta | null> {
  const db = await openDb();
  if (!db || input.files.length === 0) return null;

  const hashed = await Promise.all(
    input.files.map(async (file) => ({ name: file.name, hash: await hashContent(file.content) }))
  );

  const checkpoints: Checkpoint = {
    id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    workspacePath: input.workspacePath,
    messageId: input.messageId,
    label: input.label.trim().slice(0, FIELD_LABEL_CHARS) || 'Checkpoint',
    createdAt: Date.now(),
    files: hashed
  };

  // Blobs are keyed by content hash, so re-putting identical content is a no-op
  // and avoids a read-then-write round trip per file.
  const write = db.transaction([CHECKPOINTS, BLOBS], 'readwrite');
  const blobStore = write.objectStore(BLOBS);
  input.files.forEach((file, index) => {
    blobStore.put({ hash: hashed[index].hash, content: file.content });
  });
  write.objectStore(CHECKPOINTS).put(checkpoints);
  await transactionDone(write);

  await pruneWorkspaceHistory(input.workspacePath, db);

  return {
    id: checkpoints.id,
    messageId: checkpoints.messageId,
    label: checkpoints.label,
    createdAt: checkpoints.createdAt,
    fileCount: hashed.length
  };
}

export async function listCheckpoints(workspacePath: string): Promise<CheckpointMeta[]> {
  const db = await openDb();
  if (!db) return [];
  const tx = db.transaction(CHECKPOINTS, 'readonly');
  const index = tx.objectStore(CHECKPOINTS).index('workspacePath');
  const rows = await requestResult<Checkpoint[]>(index.getAll(workspacePath));
  return (rows ?? [])
    .map((row) => ({
      id: row.id,
      messageId: row.messageId,
      label: row.label,
      createdAt: row.createdAt,
      fileCount: row.files.length
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Rebuilds a full file set from a checkpoint's blobs. */
export async function loadCheckpointFiles(id: string): Promise<WorkspaceFile[] | null> {
  const db = await openDb();
  if (!db) return null;

  const read = db.transaction(CHECKPOINTS, 'readonly');
  const checkpoint = await requestResult<Checkpoint>(read.objectStore(CHECKPOINTS).get(id));
  if (!checkpoint) return null;

  const blobs = db.transaction(BLOBS, 'readonly').objectStore(BLOBS);
  const files: WorkspaceFile[] = [];
  for (const entry of checkpoint.files) {
    const blob = await requestResult<{ hash: string; content: string }>(blobs.get(entry.hash));
    files.push({
      name: entry.name,
      content: blob?.content ?? '',
      language: detectLanguage(entry.name)
    });
  }
  return files;
}

/** Keeps only the newest checkpoints for a workspace and frees orphaned blobs. */
async function pruneWorkspaceHistory(workspacePath: string, db: IDBDatabase): Promise<void> {
  const tx = db.transaction(CHECKPOINTS, 'readwrite');
  const store = tx.objectStore(CHECKPOINTS);
  const index = store.index('workspacePath');
  const rows = (await requestResult<Checkpoint[]>(index.getAll(workspacePath))) ?? [];
  rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(MAX_CHECKPOINTS_PER_WORKSPACE)
    .forEach((row) => store.delete(row.id));
  await transactionDone(tx);
  await pruneBlobs(db);
}

/** Removes blob rows that no remaining checkpoint references. */
async function pruneBlobs(db: IDBDatabase): Promise<void> {
  const read = db.transaction(CHECKPOINTS, 'readonly');
  const all = (await requestResult<Checkpoint[]>(read.objectStore(CHECKPOINTS).getAll())) ?? [];
  const referenced = new Set<string>();
  all.forEach((checkpoint) => checkpoint.files.forEach((file) => referenced.add(file.hash)));

  const tx = db.transaction(BLOBS, 'readwrite');
  const store = tx.objectStore(BLOBS);
  const keys = (await requestResult<IDBValidKey[]>(store.getAllKeys())) ?? [];
  keys.forEach((key) => {
    if (!referenced.has(String(key))) store.delete(key);
  });
  await transactionDone(tx);
}

export async function clearHistory(workspacePath: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const read = db.transaction(CHECKPOINTS, 'readonly');
  const index = read.objectStore(CHECKPOINTS).index('workspacePath');
  const rows = (await requestResult<Checkpoint[]>(index.getAll(workspacePath))) ?? [];
  if (rows.length === 0) return;

  const tx = db.transaction(CHECKPOINTS, 'readwrite');
  const store = tx.objectStore(CHECKPOINTS);
  rows.forEach((row) => store.delete(row.id));
  await transactionDone(tx);
  await pruneBlobs(db);
}
