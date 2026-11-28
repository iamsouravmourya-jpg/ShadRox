import { getDesktopBridge } from '../desktop';
import { normalizeSlashes } from '../diagnostics';

export interface PendingChangeEntry {
  workspaceId: string;
  path: string;
  content: string;
  originalContent: string | null;
  originalVersion: string | null;
  created: boolean;
  addedLines: number;
  removedLines: number;
  updatedAt: number;
}

export interface PendingChangesSnapshot {
  workspaceId: string;
  autoSave: boolean;
  entries: PendingChangeEntry[];
  totalAdded: number;
  totalRemoved: number;
}

export interface WorkspacePendingBridge {
  applyVirtualBuffers?: (entries: Array<{ path: string; content: string; created: boolean }>) => void;
  flushToDisk?: (entries: PendingChangeEntry[]) => Promise<{ saved: string[]; errors: Array<{ name: string; message: string }> }>;
  revertBuffers?: (entries: PendingChangeEntry[]) => void;
}

const DEFAULT_WORKSPACE_KEY = 'default';

const workspaceAutoSave = new Map<string, boolean>();
const pendingByWorkspace = new Map<string, Map<string, PendingChangeEntry>>();
const workspaceBridges = new Map<string, WorkspacePendingBridge>();
const listeners = new Set<() => void>();
const autoSaveListeners = new Map<string, Set<() => void>>();
const snapshotVersions = new Map<string, number>();
const cachedSnapshots = new Map<string, { version: number; snapshot: PendingChangesSnapshot }>();

function workspaceKey(workspaceId: string | null | undefined): string {
  return workspaceId && workspaceId.trim() ? workspaceId.trim() : DEFAULT_WORKSPACE_KEY;
}

function normalizePathKey(filePath: string): string {
  return normalizeSlashes(filePath).replace(/^\/+/, '').replace(/^\.\//, '');
}

function bumpVersion(key: string): void {
  snapshotVersions.set(key, (snapshotVersions.get(key) ?? 0) + 1);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* subscriber isolation */
    }
  }
}

function splitNormalizedLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function computeLineDiffStats(
  beforeText: string | null,
  afterText: string
): { addedLines: number; removedLines: number } {
  const before = splitNormalizedLines(beforeText ?? '');
  const after = splitNormalizedLines(afterText);
  if (before.length === 0) return { addedLines: after.length, removedLines: 0 };
  if (after.length === 0) return { addedLines: 0, removedLines: before.length };

  // Trim common prefix/suffix first so large files diff quickly.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const midBefore = before.slice(start, endBefore + 1);
  const midAfter = after.slice(start, endAfter + 1);

  if (midBefore.length === 0 && midAfter.length === 0) {
    return { addedLines: 0, removedLines: 0 };
  }

  // Exact LCS for bounded hunks; multiset fallback for huge diffs.
  if (midBefore.length * midAfter.length <= 40_000) {
    const cols = midAfter.length + 1;
    let prev = new Uint32Array(cols);
    let curr = new Uint32Array(cols);
    for (let i = 1; i <= midBefore.length; i += 1) {
      for (let j = 1; j <= midAfter.length; j += 1) {
        curr[j] = midBefore[i - 1] === midAfter[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
      }
      const swap = prev;
      prev = curr;
      curr = swap;
      curr.fill(0);
    }
    const common = prev[midAfter.length];
    return {
      addedLines: Math.max(0, midAfter.length - common),
      removedLines: Math.max(0, midBefore.length - common)
    };
  }

  const remaining = new Map<string, number>();
  for (const line of midBefore) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let shared = 0;
  for (const line of midAfter) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      shared += 1;
      remaining.set(line, count - 1);
    }
  }
  return {
    addedLines: Math.max(0, midAfter.length - shared),
    removedLines: Math.max(0, midBefore.length - shared)
  };
}

/**
 * Headless/unit-test default is `true` so direct `tools.ts` tests write immediately
 * unless a workspace explicitly toggles Auto-Save OFF via `setWorkspaceAutoSave`.
 */
export function isAutoSaveEnabled(workspaceId?: string | null): boolean {
  const key = workspaceKey(workspaceId);
  const explicit = workspaceAutoSave.get(key);
  return explicit === undefined ? true : explicit;
}

export function setWorkspaceAutoSave(workspaceId: string | null | undefined, enabled: boolean): void {
  const key = workspaceKey(workspaceId);
  const next = Boolean(enabled);
  if (workspaceAutoSave.get(key) === next) return;
  workspaceAutoSave.set(key, next);
  bumpVersion(key);
  // Notify auto-save specific listeners
  const keyListeners = autoSaveListeners.get(key);
  if (keyListeners) {
    for (const listener of keyListeners) {
      try {
        listener();
      } catch {
        /* subscriber isolation */
      }
    }
  }
}

export function registerWorkspaceBridge(
  workspaceId: string | null | undefined,
  bridge: WorkspacePendingBridge
): () => void {
  const key = workspaceKey(workspaceId);
  workspaceBridges.set(key, bridge);
  return () => {
    if (workspaceBridges.get(key) === bridge) {
      workspaceBridges.delete(key);
    }
  };
}

export function stagePendingChange(
  workspaceId: string | null | undefined,
  input: {
    path: string;
    content: string;
    originalContent: string | null;
    originalVersion: string | null;
    created?: boolean;
  }
): PendingChangeEntry | null {
  const key = workspaceKey(workspaceId);
  const normalizedPath = normalizePathKey(input.path);
  let map = pendingByWorkspace.get(key);
  if (!map) {
    map = new Map<string, PendingChangeEntry>();
    pendingByWorkspace.set(key, map);
  }

  const existing = map.get(normalizedPath);
  const baseOriginalContent = existing ? existing.originalContent : input.originalContent;
  const baseOriginalVersion = existing ? existing.originalVersion : input.originalVersion;
  const baseCreated = existing ? existing.created : Boolean(input.created && input.originalContent === null);

  if (baseOriginalContent !== null && input.content === baseOriginalContent) {
    map.delete(normalizedPath);
    workspaceBridges.get(key)?.revertBuffers?.([
      {
        workspaceId: key,
        path: normalizedPath,
        content: baseOriginalContent,
        originalContent: baseOriginalContent,
        originalVersion: baseOriginalVersion,
        created: baseCreated,
        addedLines: 0,
        removedLines: 0,
        updatedAt: Date.now()
      }
    ]);
    bumpVersion(key);
    return null;
  }

  const stats = computeLineDiffStats(baseOriginalContent, input.content);
  const entry: PendingChangeEntry = {
    workspaceId: key,
    path: normalizedPath,
    content: input.content,
    originalContent: baseOriginalContent,
    originalVersion: baseOriginalVersion,
    created: baseCreated,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
    updatedAt: Date.now()
  };

  map.set(normalizedPath, entry);
  workspaceBridges.get(key)?.applyVirtualBuffers?.([
    { path: entry.path, content: entry.content, created: entry.created }
  ]);
  bumpVersion(key);
  return entry;
}

export function getPendingChange(workspaceId: string | null | undefined, filePath: string): PendingChangeEntry | null {
  const key = workspaceKey(workspaceId);
  const normalizedPath = normalizePathKey(filePath);
  return pendingByWorkspace.get(key)?.get(normalizedPath) ?? null;
}

export function listPendingChanges(workspaceId: string | null | undefined): PendingChangeEntry[] {
  const key = workspaceKey(workspaceId);
  const map = pendingByWorkspace.get(key);
  if (!map) return [];
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function listPendingOverrides(workspaceId: string | null | undefined): Array<{ path: string; content: string }> {
  return listPendingChanges(workspaceId).map((entry) => ({ path: entry.path, content: entry.content }));
}

async function persistEntries(
  workspaceId: string,
  entries: PendingChangeEntry[]
): Promise<{ saved: string[]; errors: Array<{ name: string; message: string }> }> {
  if (entries.length === 0) return { saved: [], errors: [] };
  const bridge = workspaceBridges.get(workspaceId);
  if (bridge?.flushToDisk) {
    return bridge.flushToDisk(entries);
  }
  const desktop = getDesktopBridge();
  if (!desktop?.saveFiles) {
    return {
      saved: [],
      errors: entries.map((entry) => ({ name: entry.path, message: 'Desktop saveFiles bridge is unavailable.' }))
    };
  }
  return desktop.saveFiles(
    workspaceId,
    entries.map((entry) => ({
      name: entry.path,
      content: entry.content,
      expectedVersion: entry.originalVersion
    }))
  );
}

export async function acceptPendingChange(
  workspaceId: string | null | undefined,
  filePath: string
): Promise<{ ok: boolean; error?: string; savedPath?: string }> {
  const key = workspaceKey(workspaceId);
  const normalizedPath = normalizePathKey(filePath);
  const map = pendingByWorkspace.get(key);
  const entry = map?.get(normalizedPath);
  if (!entry) return { ok: false, error: `No pending change for ${normalizedPath}.` };

  const result = await persistEntries(key, [entry]);
  const failed = result.errors.find((item) => normalizePathKey(item.name) === normalizedPath);
  if (failed || !result.saved.some((saved) => normalizePathKey(saved) === normalizedPath)) {
    return { ok: false, error: failed?.message ?? `Could not save ${normalizedPath}.` };
  }
  map?.delete(normalizedPath);
  bumpVersion(key);
  return { ok: true, savedPath: normalizedPath };
}

export async function acceptAllPendingChanges(
  workspaceId: string | null | undefined
): Promise<{ ok: boolean; errors: string[]; savedPaths: string[] }> {
  const key = workspaceKey(workspaceId);
  const map = pendingByWorkspace.get(key);
  const entries = listPendingChanges(key);
  if (!map || entries.length === 0) return { ok: true, errors: [], savedPaths: [] };

  const result = await persistEntries(key, entries);
  const savedSet = new Set(result.saved.map((saved) => normalizePathKey(saved)));
  for (const saved of savedSet) {
    map.delete(saved);
  }
  if (savedSet.size > 0) bumpVersion(key);
  return {
    ok: result.errors.length === 0,
    errors: result.errors.map((err) => `${err.name}: ${err.message}`),
    savedPaths: [...savedSet]
  };
}

export function rejectPendingChange(
  workspaceId: string | null | undefined,
  filePath: string
): { ok: boolean; path: string } {
  const key = workspaceKey(workspaceId);
  const normalizedPath = normalizePathKey(filePath);
  const map = pendingByWorkspace.get(key);
  const entry = map?.get(normalizedPath);
  if (!entry) return { ok: false, path: normalizedPath };

  map?.delete(normalizedPath);
  workspaceBridges.get(key)?.revertBuffers?.([entry]);
  bumpVersion(key);
  return { ok: true, path: normalizedPath };
}

export function rejectAllPendingChanges(
  workspaceId: string | null | undefined
): { ok: boolean; revertedPaths: string[] } {
  const key = workspaceKey(workspaceId);
  const map = pendingByWorkspace.get(key);
  const entries = listPendingChanges(key);
  if (!map || entries.length === 0) return { ok: true, revertedPaths: [] };

  map.clear();
  workspaceBridges.get(key)?.revertBuffers?.(entries);
  bumpVersion(key);
  return { ok: true, revertedPaths: entries.map((entry) => entry.path) };
}

export function clearWorkspacePendingChanges(workspaceId?: string | null): void {
  if (workspaceId === undefined) {
    pendingByWorkspace.clear();
    workspaceAutoSave.clear();
    workspaceBridges.clear();
    snapshotVersions.clear();
    cachedSnapshots.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const key = workspaceKey(workspaceId);
  pendingByWorkspace.delete(key);
  bumpVersion(key);
}

export function subscribePendingChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeAutoSave(workspaceId: string | null | undefined, listener: () => void): () => void {
  const key = workspaceKey(workspaceId);
  let set = autoSaveListeners.get(key);
  if (!set) {
    set = new Set();
    autoSaveListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

export function getPendingSnapshot(workspaceId: string | null | undefined): PendingChangesSnapshot {
  const key = workspaceKey(workspaceId);
  const version = snapshotVersions.get(key) ?? 0;
  const cached = cachedSnapshots.get(key);
  if (cached && cached.version === version) return cached.snapshot;

  const entries = listPendingChanges(key);
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const entry of entries) {
    totalAdded += entry.addedLines;
    totalRemoved += entry.removedLines;
  }
  const snapshot: PendingChangesSnapshot = {
    workspaceId: key,
    autoSave: isAutoSaveEnabled(key),
    entries,
    totalAdded,
    totalRemoved
  };
  cachedSnapshots.set(key, { version, snapshot });
  return snapshot;
}
