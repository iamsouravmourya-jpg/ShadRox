import {
  MAX_PROMPT_CHECKPOINTS,
  normalizeCheckpointPath,
  type PromptCheckpointSnapshot
} from './chatCheckpoints';
import { canUseIndexedDb } from './persistence';
import type { SubagentActivityRecord } from './types';

const DB_NAME = 'shadrox-workspace-state';
const DB_VERSION = 1;
const STORE_NAME = 'workspaceState';
const MAX_WORKSPACES = 20;
const MAX_SUBAGENT_MESSAGE_ENTRIES = 80;
const MAX_SUBAGENTS_PER_MESSAGE = 8;
const MAX_SINGLE_FILE_BYTES = 1_500_000;
const MAX_WORKSPACE_CHECKPOINT_BYTES = 8_000_000;

export type SubagentsByMessageMap = Record<string, SubagentActivityRecord[]>;

export interface WorkspaceUiState {
  promptCheckpoints: PromptCheckpointSnapshot[];
  subagentsByMessage: SubagentsByMessageMap;
}

interface StoredWorkspaceStateRecord {
  workspaceKey: string;
  promptCheckpoints: PromptCheckpointSnapshot[];
  subagentsByMessage: SubagentsByMessageMap;
  updatedAt: number;
}

export interface WorkspaceStateStore {
  load(workspaceKey: string): Promise<WorkspaceUiState>;
  saveCheckpoints(workspaceKey: string, checkpoints: readonly PromptCheckpointSnapshot[]): Promise<void>;
  saveSubagents(workspaceKey: string, subagentsByMessage: Readonly<SubagentsByMessageMap>): Promise<void>;
  clearCheckpoints(workspaceKey: string): Promise<void>;
  clearSubagents(workspaceKey: string): Promise<void>;
  clearAll(workspaceKey: string): Promise<void>;
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

function sanitizeSubagentRecord(
  raw: unknown,
  options?: { settleRunning?: boolean }
): SubagentActivityRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<SubagentActivityRecord>;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (typeof item.label !== 'string' || !item.label.trim()) return null;

  let status: SubagentActivityRecord['status'] =
    item.status === 'done' || item.status === 'error' || item.status === 'running'
      ? item.status
      : 'error';
  let summary = typeof item.summary === 'string' && item.summary ? item.summary.slice(0, 4_000) : undefined;
  let currentAction =
    typeof item.currentAction === 'string' && item.currentAction
      ? item.currentAction.slice(0, 200)
      : undefined;

  if (options?.settleRunning && status === 'running') {
    status = 'error';
    if (!summary) summary = 'Interrupted before completion.';
    currentAction = undefined;
  }

  return {
    id: item.id,
    ...(item.index === 1 || item.index === 2 ? { index: item.index } : {}),
    ...(typeof item.title === 'string' && item.title ? { title: item.title.slice(0, 120) } : {}),
    label: item.label.slice(0, 240),
    status,
    ...(currentAction ? { currentAction } : {}),
    ...(typeof item.stepsCount === 'number' && Number.isFinite(item.stepsCount)
      ? { stepsCount: Math.max(0, Math.trunc(item.stepsCount)) }
      : {}),
    ...(summary ? { summary } : {})
  };
}

export function sanitizeSubagentsByMessage(
  raw: unknown,
  options?: { settleRunning?: boolean }
): SubagentsByMessageMap {
  if (!raw || typeof raw !== 'object') return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  const trimmedEntries = entries.slice(-MAX_SUBAGENT_MESSAGE_ENTRIES);
  const result: SubagentsByMessageMap = {};
  for (const [messageId, list] of trimmedEntries) {
    if (!messageId || !Array.isArray(list)) continue;
    const clean: SubagentActivityRecord[] = [];
    for (const item of list.slice(0, MAX_SUBAGENTS_PER_MESSAGE)) {
      const sanitized = sanitizeSubagentRecord(item, options);
      if (sanitized) clean.push(sanitized);
    }
    if (clean.length > 0) result[messageId] = clean;
  }
  return result;
}

function sanitizeCheckpointSnapshot(raw: unknown, fallbackWorkspaceKey: string): PromptCheckpointSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<PromptCheckpointSnapshot>;
  if (typeof candidate.userMessageId !== 'string' || !candidate.userMessageId.trim()) return null;
  if (typeof candidate.promptText !== 'string') return null;

  const priorFiles: Record<string, string> = {};
  if (candidate.priorFiles && typeof candidate.priorFiles === 'object') {
    for (const [rawPath, content] of Object.entries(candidate.priorFiles)) {
      const cleanPath = normalizeCheckpointPath(rawPath);
      if (!cleanPath || typeof content !== 'string' || content.length > MAX_SINGLE_FILE_BYTES) continue;
      priorFiles[cleanPath] = content;
    }
  }

  const createdPathsSet = new Set<string>();
  if (Array.isArray(candidate.createdPaths)) {
    for (const rawPath of candidate.createdPaths) {
      if (typeof rawPath !== 'string') continue;
      const cleanPath = normalizeCheckpointPath(rawPath);
      if (cleanPath) createdPathsSet.add(cleanPath);
    }
  }

  if (Object.keys(priorFiles).length === 0 && createdPathsSet.size === 0) return null;

  return {
    userMessageId: candidate.userMessageId,
    promptText: candidate.promptText,
    workspaceKey:
      typeof candidate.workspaceKey === 'string' && candidate.workspaceKey
        ? candidate.workspaceKey
        : fallbackWorkspaceKey,
    createdAt:
      typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
    priorFiles,
    createdPaths: [...createdPathsSet]
  };
}

function estimateCheckpointBytes(snapshot: PromptCheckpointSnapshot): number {
  let bytes = snapshot.promptText.length;
  for (const [filePath, content] of Object.entries(snapshot.priorFiles)) {
    bytes += filePath.length + content.length;
  }
  for (const createdPath of snapshot.createdPaths) {
    bytes += createdPath.length;
  }
  return bytes;
}

export function sanitizePromptCheckpoints(
  raw: unknown,
  workspaceKey: string
): PromptCheckpointSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const clean: PromptCheckpointSnapshot[] = [];
  for (const entry of raw) {
    const sanitized = sanitizeCheckpointSnapshot(entry, workspaceKey);
    if (sanitized) clean.push(sanitized);
  }
  const recent = clean.slice(-MAX_PROMPT_CHECKPOINTS);
  // Enforce workspace byte budget by keeping the newest snapshots first.
  const kept: PromptCheckpointSnapshot[] = [];
  let totalBytes = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const cp = recent[i];
    const size = estimateCheckpointBytes(cp);
    if (totalBytes + size > MAX_WORKSPACE_CHECKPOINT_BYTES && kept.length > 0) break;
    kept.push(cp);
    totalBytes += size;
  }
  return kept.reverse();
}

export function createWorkspaceStateStore(options?: {
  indexedDb?: IDBFactory | null;
}): WorkspaceStateStore {
  const memoryFallback = new Map<string, StoredWorkspaceStateRecord>();
  const pendingByKey = new Map<string, Promise<void>>();
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const resolveFactory = (): IDBFactory | null => {
    if (options && 'indexedDb' in options) {
      return options.indexedDb ?? null;
    }
    if (!canUseIndexedDb()) return null;
    return globalThis.indexedDB;
  };

  const openDb = (): Promise<IDBDatabase | null> => {
    const factory = resolveFactory();
    if (!factory) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const request = factory.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              const store = db.createObjectStore(STORE_NAME, { keyPath: 'workspaceKey' });
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
    return dbPromise;
  };

  const readRecord = async (workspaceKey: string): Promise<StoredWorkspaceStateRecord | null> => {
    const db = await openDb();
    if (!db) return memoryFallback.get(workspaceKey) ?? null;
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const row = await requestResult<StoredWorkspaceStateRecord>(tx.objectStore(STORE_NAME).get(workspaceKey));
      return row ?? null;
    } catch {
      return memoryFallback.get(workspaceKey) ?? null;
    }
  };

  const pruneOldWorkspaces = async (db: IDBDatabase): Promise<void> => {
    try {
      const readTx = db.transaction(STORE_NAME, 'readonly');
      const rows = await requestResult<StoredWorkspaceStateRecord[]>(readTx.objectStore(STORE_NAME).getAll());
      if (!rows || rows.length <= MAX_WORKSPACES) return;
      const stale = [...rows]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(MAX_WORKSPACES);
      if (stale.length === 0) return;
      const writeTx = db.transaction(STORE_NAME, 'readwrite');
      const store = writeTx.objectStore(STORE_NAME);
      for (const entry of stale) {
        store.delete(entry.workspaceKey);
      }
      await transactionDone(writeTx);
    } catch {
      /* best-effort pruning */
    }
  };

  const writeRecord = async (record: StoredWorkspaceStateRecord): Promise<void> => {
    const isEmpty =
      record.promptCheckpoints.length === 0 && Object.keys(record.subagentsByMessage).length === 0;
    const db = await openDb();
    if (!db) {
      if (isEmpty) memoryFallback.delete(record.workspaceKey);
      else memoryFallback.set(record.workspaceKey, record);
      return;
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      if (isEmpty) store.delete(record.workspaceKey);
      else store.put(record);
      await transactionDone(tx);
      if (!isEmpty) await pruneOldWorkspaces(db);
    } catch {
      if (isEmpty) memoryFallback.delete(record.workspaceKey);
      else memoryFallback.set(record.workspaceKey, record);
    }
  };

  const enqueueUpdate = (
    workspaceKey: string,
    updater: (existing: StoredWorkspaceStateRecord) => StoredWorkspaceStateRecord
  ): Promise<void> => {
    if (!workspaceKey) return Promise.resolve();
    const prior = pendingByKey.get(workspaceKey) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const current = (await readRecord(workspaceKey)) ?? {
          workspaceKey,
          promptCheckpoints: [],
          subagentsByMessage: {},
          updatedAt: 0
        };
        const updated = updater(current);
        await writeRecord(updated);
      });
    pendingByKey.set(workspaceKey, next);
    return next.finally(() => {
      if (pendingByKey.get(workspaceKey) === next) {
        pendingByKey.delete(workspaceKey);
      }
    });
  };

  return {
    async load(workspaceKey: string): Promise<WorkspaceUiState> {
      if (!workspaceKey) return { promptCheckpoints: [], subagentsByMessage: {} };
      const pending = pendingByKey.get(workspaceKey);
      if (pending) await pending.catch(() => {});
      const row = await readRecord(workspaceKey);
      if (!row) return { promptCheckpoints: [], subagentsByMessage: {} };
      return {
        promptCheckpoints: sanitizePromptCheckpoints(row.promptCheckpoints, workspaceKey),
        subagentsByMessage: sanitizeSubagentsByMessage(row.subagentsByMessage, { settleRunning: true })
      };
    },

    saveCheckpoints(workspaceKey: string, checkpoints: readonly PromptCheckpointSnapshot[]): Promise<void> {
      const sanitized = sanitizePromptCheckpoints(checkpoints, workspaceKey);
      return enqueueUpdate(workspaceKey, (existing) => ({
        workspaceKey,
        promptCheckpoints: sanitized,
        subagentsByMessage: sanitizeSubagentsByMessage(existing.subagentsByMessage),
        updatedAt: Date.now()
      }));
    },

    saveSubagents(workspaceKey: string, subagentsByMessage: Readonly<SubagentsByMessageMap>): Promise<void> {
      const sanitized = sanitizeSubagentsByMessage(subagentsByMessage);
      return enqueueUpdate(workspaceKey, (existing) => ({
        workspaceKey,
        promptCheckpoints: sanitizePromptCheckpoints(existing.promptCheckpoints, workspaceKey),
        subagentsByMessage: sanitized,
        updatedAt: Date.now()
      }));
    },

    clearCheckpoints(workspaceKey: string): Promise<void> {
      return enqueueUpdate(workspaceKey, (existing) => ({
        workspaceKey,
        promptCheckpoints: [],
        subagentsByMessage: sanitizeSubagentsByMessage(existing.subagentsByMessage),
        updatedAt: Date.now()
      }));
    },

    clearSubagents(workspaceKey: string): Promise<void> {
      return enqueueUpdate(workspaceKey, (existing) => ({
        workspaceKey,
        promptCheckpoints: sanitizePromptCheckpoints(existing.promptCheckpoints, workspaceKey),
        subagentsByMessage: {},
        updatedAt: Date.now()
      }));
    },

    clearAll(workspaceKey: string): Promise<void> {
      return enqueueUpdate(workspaceKey, () => ({
        workspaceKey,
        promptCheckpoints: [],
        subagentsByMessage: {},
        updatedAt: Date.now()
      }));
    }
  };
}

const defaultStore = createWorkspaceStateStore();

export function loadWorkspaceUiState(workspaceKey: string): Promise<WorkspaceUiState> {
  return defaultStore.load(workspaceKey);
}

export function saveWorkspaceCheckpoints(
  workspaceKey: string,
  checkpoints: readonly PromptCheckpointSnapshot[]
): Promise<void> {
  return defaultStore.saveCheckpoints(workspaceKey, checkpoints);
}

export function saveWorkspaceSubagents(
  workspaceKey: string,
  subagentsByMessage: Readonly<SubagentsByMessageMap>
): Promise<void> {
  return defaultStore.saveSubagents(workspaceKey, subagentsByMessage);
}

export function clearWorkspaceCheckpoints(workspaceKey: string): Promise<void> {
  return defaultStore.clearCheckpoints(workspaceKey);
}

export function clearWorkspaceSubagents(workspaceKey: string): Promise<void> {
  return defaultStore.clearSubagents(workspaceKey);
}
