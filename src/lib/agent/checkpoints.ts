import { confirmAction } from '../confirm';
import { getRecentWorkspaces } from '../storage';
import type { ShadRoxDesktopAPI } from '../desktop';
import type { CheckpointMeta } from '../history';
import type { AgentTurnState } from './turnState';

/**
 * Agent checkpoints, wired to the EXISTING renderer history mechanism.
 *
 * The chat's timeline already stores content-addressed checkpoints in the
 * 'shadrox-history' IndexedDB (src/lib/history.ts), keyed by absolute workspace
 * path, with pre-image merge and created-path tracking. This module does not
 * reinvent any of that: it is a thin port over the same primitives, plus the
 * workspace-id → path resolution the bridge does not expose, plus the restore
 * rail (delete what the run created, save back what it changed).
 *
 * Storage is injectable so tests drive it without IndexedDB; the default
 * adapter lazy-loads history.ts so a headless import never pulls browser code.
 * Every operation is fail-open: a checkpoint that cannot be made never blocks
 * the turn, it just reports that no safety net exists.
 */

export interface CheckpointFile {
  name: string;
  content: string;
}

export interface CheckpointStorage {
  save(input: { workspacePath: string; messageId: string; label: string; files: CheckpointFile[] }): Promise<CheckpointMeta | null>;
  list(workspacePath: string): Promise<CheckpointMeta[]>;
  loadFiles(id: string): Promise<CheckpointFile[] | null>;
  mergeFiles(id: string, files: CheckpointFile[]): Promise<number>;
  addCreatedPaths(id: string, paths: string[]): Promise<void>;
  loadCreatedPaths(id: string): Promise<string[]>;
}

const defaultStorage: CheckpointStorage = {
  async save(input) {
    const history = await import('../history');
    return history.saveCheckpoint({ ...input, files: input.files.map((file) => ({ ...file, language: 'plaintext' })) });
  },
  async list(workspacePath) {
    const history = await import('../history');
    return history.listCheckpoints(workspacePath);
  },
  async loadFiles(id) {
    const history = await import('../history');
    return history.loadCheckpointFiles(id);
  },
  async mergeFiles(id, files) {
    const history = await import('../history');
    return history.mergeCheckpointFiles(id, files.map((file) => ({ ...file, language: 'plaintext' })));
  },
  async addCreatedPaths(id, paths) {
    const history = await import('../history');
    await history.addCheckpointCreatedPaths(id, paths);
  },
  async loadCreatedPaths(id) {
    const history = await import('../history');
    return history.loadCheckpointCreatedPaths(id);
  }
};

let storage: CheckpointStorage = defaultStorage;
let hostResolver: ((workspaceId: string) => string | null) | null = null;

export function setCheckpointStorage(next: CheckpointStorage | null): void {
  storage = next ?? defaultStorage;
}

/** The host (App) can pin the exact opened path; without it, recents are used. */
export function setCheckpointHost(resolver: ((workspaceId: string) => string | null) | null): void {
  hostResolver = resolver;
}

/**
 * The bridge has no workspaceId → rootPath getter, so the absolute path that
 * keys the history store comes from the host when it registers one, else from
 * the recents list (exact id first, most recently opened folder as fallback).
 */
export function resolveWorkspacePath(workspaceId: string): string | null {
  const pinned = hostResolver?.(workspaceId);
  if (pinned) return pinned;
  const recents = getRecentWorkspaces();
  const exact = recents.find((entry) => entry.id === workspaceId && entry.path);
  if (exact) return exact.path;
  const folder = recents.find((entry) => entry.kind === 'folder' && entry.path);
  return folder?.path ?? null;
}

/** The slice of the bridge the checkpoint rails need; stubs may lack all of it. */
export type CheckpointBridge = Partial<Pick<ShadRoxDesktopAPI, 'loadFiles' | 'deletePath' | 'saveFiles' | 'restoreMachineTurn'>>;

const MAX_CHECKPOINT_FILES = 200;
const MAX_PREIMAGE_BYTES = 512 * 1024;

export async function createAgentCheckpoint(workspaceId: string, label: string, files: CheckpointFile[]): Promise<CheckpointMeta | null> {
  const workspacePath = resolveWorkspacePath(workspaceId);
  if (!workspacePath) return null;
  try {
    return await storage.save({
      workspacePath,
      messageId: `agent-${Date.now()}`,
      label: label.trim() || 'Agent checkpoint',
      files: files.slice(0, MAX_CHECKPOINT_FILES)
    });
  } catch {
    return null;
  }
}

/**
 * The turn's safety net, taken before its first write: pre-images of exactly
 * the files about to change, merged into one checkpoint as the turn touches
 * more paths, with created paths recorded so a restore deletes them again.
 * Uses loadFiles only — never readFile — so it adds no reads to the turn's
 * read-set accounting. Fail-open everywhere.
 */
export async function ensureTurnCheckpoint(turn: AgentTurnState, desktop: CheckpointBridge, paths: string[]): Promise<string | null> {
  const wanted = [...new Set(paths)].filter((path) => !turn.checkpointPaths.has(path)).slice(0, MAX_CHECKPOINT_FILES);
  if (wanted.length === 0) return turn.checkpointId;
  if (typeof desktop.loadFiles !== 'function') return turn.checkpointId;
  const workspacePath = resolveWorkspacePath(turn.workspaceId);
  if (!workspacePath) return turn.checkpointId;
  try {
    const loaded = await desktop.loadFiles(turn.workspaceId, wanted, { maxBytesPerFile: MAX_PREIMAGE_BYTES, maxTotalBytes: MAX_PREIMAGE_BYTES * 4 });
    const preimages: CheckpointFile[] = loaded.files.map((file) => ({ name: file.name, content: file.content }));
    if (!turn.checkpointId) {
      const meta = await storage.save({
        workspacePath,
        messageId: `agent-turn-${turn.startedAt}`,
        label: 'Before agent changes',
        files: preimages
      });
      if (!meta) return null;
      turn.checkpointId = meta.id;
    } else if (preimages.length > 0) {
      await storage.mergeFiles(turn.checkpointId, preimages);
    }
    for (const path of wanted) turn.checkpointPaths.add(path);
    if (turn.created.size > 0) await storage.addCreatedPaths(turn.checkpointId, [...turn.created]);
    return turn.checkpointId;
  } catch {
    return turn.checkpointId;
  }
}

export async function listAgentCheckpoints(workspaceId: string): Promise<{ path: string | null; checkpoints: CheckpointMeta[] }> {
  const workspacePath = resolveWorkspacePath(workspaceId);
  if (!workspacePath) return { path: null, checkpoints: [] };
  try {
    return { path: workspacePath, checkpoints: await storage.list(workspacePath) };
  } catch {
    return { path: workspacePath, checkpoints: [] };
  }
}

export interface RestoreResult {
  ok: boolean;
  message: string;
}

/**
 * Restores a checkpoint through the same rail the timeline uses: machine
 * checkpoints go to the main-process machine-turn restore; ordinary ones
 * delete the paths the run created and save the stored pre-images back.
 * The user approves the exact restore in a dialog first — a restore overwrites
 * current disk state, so it is never silent.
 */
export async function restoreAgentCheckpoint(workspaceId: string, desktop: CheckpointBridge, id: string): Promise<RestoreResult> {
  const workspacePath = resolveWorkspacePath(workspaceId);
  if (!workspacePath) return { ok: false, message: 'The workspace path is unknown, so its checkpoint history cannot be opened.' };
  let meta: CheckpointMeta | undefined;
  try {
    meta = (await storage.list(workspacePath)).find((entry) => entry.id === id);
  } catch {
    meta = undefined;
  }
  if (!meta) return { ok: false, message: `No checkpoint "${id}" exists for this workspace. Call list_checkpoints to see the real ids.` };

  const approved = await confirmAction({
    title: `Restore "${meta.label}"?`,
    body: `This overwrites the current files with the checkpoint from ${new Date(meta.createdAt).toLocaleString()} (${meta.fileCount} files) and removes files created after it.\n\nAnything changed since then is lost unless it is in your version control. Cancel keeps the current state.`,
    confirmLabel: 'Restore',
    tone: 'danger'
  });
  if (!approved) return { ok: false, message: 'The user did not approve the restore; nothing was changed.' };

  if (meta.machine) {
    if (typeof desktop.restoreMachineTurn !== 'function') {
      return { ok: false, message: 'This is a machine checkpoint and the bridge has no machine-turn restore channel.' };
    }
    const result = await desktop.restoreMachineTurn(workspaceId, id);
    if (result.status === 'noop' || result.report?.noChanges) {
      return { ok: true, message: result.message || 'No file changes in this turn to undo.' };
    }
    return { ok: result.ok, message: result.ok ? `Restored machine checkpoint "${meta.label}". ${result.message}` : `Machine restore failed: ${result.message}` };
  }

  const files = await storage.loadFiles(id);
  if (!files) return { ok: false, message: `Checkpoint "${id}" could not be loaded from history.` };
  const created = await storage.loadCreatedPaths(id);
  if (typeof desktop.saveFiles !== 'function' || typeof desktop.deletePath !== 'function') {
    return { ok: false, message: 'The desktop bridge cannot write files, so the restore cannot run.' };
  }
  const removed: string[] = [];
  const removeErrors: string[] = [];
  for (const path of created) {
    try {
      await desktop.deletePath(workspaceId, path);
      removed.push(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|no such file|no longer in the workspace/i.test(message)) removeErrors.push(`${path}: ${message}`);
    }
  }
  const saved = await desktop.saveFiles(workspaceId, files.map((file) => ({ name: file.name, content: file.content })));
  if (saved.errors.length > 0) {
    return {
      ok: false,
      message: `Restore partially failed: ${saved.errors.map((error) => `${error.name}: ${error.message}`).join('; ')}. ${removed.length} created file(s) were removed; ${saved.saved.length} file(s) restored.`
    };
  }
  const tail = removeErrors.length > 0 ? ` Could not remove: ${removeErrors.join('; ')}.` : '';
  return { ok: true, message: `Restored "${meta.label}": ${saved.saved.length} file(s) written back, ${removed.length} created file(s) removed.${tail}` };
}