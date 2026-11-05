import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetMap } from '../lib/assets';
import { resolveActiveFileIndex } from '../lib/activeFile';
import { detectLanguage } from '../lib/languages';
import type { FilePatch } from '../lib/markdown';
import { loadHandleRecord, pruneHandles, saveHandles } from '../lib/fileHandles';
import { addCheckpointCreatedPaths, listCheckpoints, loadCheckpointCreatedPaths, loadCheckpointFiles, mergeCheckpointFiles, saveCheckpoint, type CheckpointMeta } from '../lib/history';
import { diffToCheckpoint, type CheckpointDiff } from '../lib/checkpointDiff';
import { getSnapshot, pruneSnapshots, saveSnapshot } from '../lib/snapshots';
import { getRecentWorkspaces, pushRecentWorkspace, removeRecentWorkspace } from '../lib/storage';
import { getDesktopBridge, type DirectoryPage, type StagedTransaction, type WorkspaceChange } from '../lib/desktop';
import { confirmAction } from '../lib/confirm';
import {
  ensureReadWrite,
  filesFromFileList,
  hydrateAssets,
  pickDirectory,
  pickFiles,
  supportsDirectoryPicker,
  supportsFilePicker,
  type HandleEntry
} from '../lib/workspace';
import type { RecentEntry, WorkspaceFile, WorkspaceFileEntry, WorkspaceFolder } from '../lib/types';

/** What happened to each file the assistant tried to write. */
export interface ApplyPatchesResult {
  updated: string[];
  created: string[];
  unchanged: string[];
}

/** The honest result of a disk write-back: buffers are not files. */
export interface SaveOutcome {
  written: number;
  failed: boolean;
  /** Provider/best-effort reason when nothing was written. */
  message: string | null;
}

interface MountOptions {
  handles?: HandleEntry[];
  directoryHandle?: unknown;
  nativeWorkspaceId?: string;
  /** Absolute filesystem paths so the desktop app can reopen without a picker. */
  filePaths?: string[];
  /** Binary assets (images, fonts) served to the preview as data URLs. */
  assets?: AssetMap;
  /** Explorer-visible file count reported by the desktop bridge for a folder. */
  diskFileCount?: number;
  diskFileCountTruncated?: boolean;
  /** Explorer-visible paths + sizes reported by the desktop bridge. */
  diskFileTree?: WorkspaceFileEntry[];
}

export interface EditorGroup {
  tabs: string[];
  activePath: string | null;
  pinnedTabs: string[];
}

export interface PatchProposal extends StagedTransaction {
  workspaceId: string;
  base: WorkspaceFile[];
}

/**
 * One workspace path as the attach picker needs it: names only, no contents.
 * Derived from the disk tree, so it lists the whole folder instead of the tabs
 * that happen to be open.
 */
export interface WorkspaceTreeEntry {
  /** Workspace-relative path, same shape as `WorkspaceFile.name`. */
  name: string;
  /** Bytes on disk (0 for a path the watcher just reported) or buffer length. */
  size: number;
}

interface UseWorkspaceResult {
  directoryPages: Record<string, DirectoryPage>;
  loadingDirectories: string[];
  loadDirectory: (path: string, cursor?: number) => Promise<void>;
  openFile: (path: string, groupIndex?: number) => Promise<void>;
  closeTab: (index: number, groupIndex?: number) => void;
  editorGroups: EditorGroup[];
  activeEditorGroup: number;
  splitEditor: () => void;
  focusEditorGroup: (index: number) => void;
  closeEditorGroup: (index: number) => void;
  reorderEditorTabs: (groupIndex: number, fromPath: string, toPath: string) => void;
  togglePinnedTab: (groupIndex: number, path: string) => void;
  conflicts: string[];
  resolveConflict: (name: string, action: 'reload' | 'keep') => Promise<void>;
  pendingProposal: PatchProposal | null;
  stageFilePatches: (patches: FilePatch[], base: WorkspaceFile[], workspaceId: string) => Promise<void>;
  applyProposal: () => Promise<void>;
  discardProposal: () => Promise<void>;
  changeRevision: number;
  workspace: WorkspaceFolder | null;
  files: WorkspaceFile[];
  /**
   * Every path the workspace holds — the disk tree plus any buffer the tree has
   * not caught up with — as `{ name, size }`. Deliberately separate from `files`
   * (the loaded/open tabs, which the chat context depends on).
   */
  allFiles: WorkspaceTreeEntry[];
  activeFile: WorkspaceFile | null;
  activeFileIndex: number;
  /** Binary assets mounted from disk, keyed by workspace-relative path. */
  assets: AssetMap;
  recents: RecentEntry[];
  isBusy: boolean;
  statusMessage: string | null;
  openFolder: () => Promise<void>;
  openFiles: () => Promise<void>;
  openDropped: (list: FileList) => Promise<void>;
  /** Reopens a remembered workspace straight from its local snapshot. */
  openRecent: (entry: RecentEntry) => Promise<void>;
  /** Drops one entry from the recent list. */
  removeRecent: (id: string) => void;
  selectFile: (index: number, groupIndex?: number) => void;
  /** Leaves the editor and goes back to the file list. */
  closeFile: () => void;
  updateActiveContent: (content: string) => void;
  applyFilePatches: (patches: FilePatch[]) => ApplyPatchesResult;
  createFile: (name: string, content?: string) => void;
  deleteFile: (index: number) => void;
  /** Renames a file on disk (desktop only) and keeps its buffer in sync. */
  renameFile: (from: string, to: string) => Promise<boolean>;
  /** Creates a folder on disk (desktop folder workspaces only). */
  createDirectory: (path: string) => Promise<boolean>;
  /** Deletes one file or empty folder from disk and drops its buffer. */
  deleteWorkspaceEntry: (path: string) => Promise<boolean>;
  /**
   * Reads the named files off disk into buffers. Must run before a patch touches
   * a file the user has not opened, or the edit is treated as a new file.
   */
  loadFilesForPatching: (paths: string[]) => Promise<WorkspaceFile[]>;
  /**
   * Records which paths the current turn created onto the checkpoint taken
   * before it, so a rollback deletes them from disk instead of leaving them.
   */
  noteCheckpointCreated: (paths: string[]) => Promise<void>;
  /** Reloads the active buffer from disk, discarding local edits. */
  revertActiveFile: () => Promise<void>;
  closeWorkspace: () => void;

  // --- disk write-back -----------------------------------------------------
  /** True when the open workspace actually carries handles we can write through. */
  canWriteToDisk: boolean;
  /** Workspace-relative names whose editor content differs from disk. */
  dirtyFiles: string[];
  isSaving: boolean;
  diskMessage: string | null;
  autoSave: boolean;
  setAutoSave: (value: boolean) => void;
  saveAll: () => Promise<void>;
  /**
   * Writes the named files through to disk and reports what actually landed.
   * The chat apply path needs the outcome: "applied" in the editor is not
   * "saved", and the user must never be told a file changed when it did not.
   */
  saveFiles: (names: string[]) => Promise<SaveOutcome>;
  /**
   * Saves a review set as one disk transaction: every file lands or none do.
   * Falls back to `saveFiles` (and says so) when the batch cannot be staged.
   */
  saveFilesAtomic: (names: string[]) => Promise<SaveOutcome>;

  // --- restore timeline ----------------------------------------------------
  checkpoints: CheckpointMeta[];
  /**
   * Snapshots the current files so a later chat turn can be undone.
   * `onlyIfIdle` skips the snapshot while a machine turn is open — a nested
   * apply then rides the turn's checkpoint instead of double-snapshotting.
   * `turn` marks the checkpoint as one a finish call will close; run-level
   * bookmarks pass false so they never hold the idle gate open.
   */
  markCheckpoint: (messageId: string, label: string, machine?: boolean, onlyIfIdle?: boolean, turn?: boolean) => Promise<string | null>;
  finishMachineCheckpoint: (id: string | null) => Promise<void>;
  inspectMachineCheckpoint: (id: string) => Promise<void>;
  exportDeltaReceipt: (id: string) => Promise<string>;
  /** `ok` = the state was restored; `partial` = restored, but some steps failed. */
  restoreCheckpoint: (id: string) => Promise<{ ok: boolean; partial: boolean }>;
  /** What restoring would do to the current buffers, so a restore is never blind. */
  previewCheckpointDiff: (id: string) => Promise<CheckpointDiff | null>;
  /**
   * Restores a checkpoint and writes it through to disk in one transaction.
   * Used by the autonomous run's failure path; the manual timeline restore
   * stays buffer-only so the user can inspect before saving.
   */
  rollbackToCheckpoint: (id: string) => Promise<boolean>;
}

const EMPTY_FILES: WorkspaceFile[] = [];
/** Unedited, unopened buffers past this count are dropped back to the file list. */
const MAX_LOADED_BUFFERS = 48;

/** Strips the `./` and backslashes that models write into patch paths. */
export function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Traversal-safe, dot-free workspace-relative path. */
function isEditablePath(path: string): boolean {
  return path.length > 0 && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function contentVersion(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function useWorkspace(): UseWorkspaceResult {
  const [workspace, setWorkspace] = useState<WorkspaceFolder | null>(null);
  // Nothing is selected on mount: the user sees the file list first and picks.
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [editorGroups, setEditorGroups] = useState<EditorGroup[]>([{ tabs: [], activePath: null, pinnedTabs: [] }]);
  const [activeEditorGroup, setActiveEditorGroup] = useState(0);
  const [assets, setAssets] = useState<AssetMap>({});
  const [recents, setRecents] = useState<RecentEntry[]>(() => getRecentWorkspaces());
  const [isBusy, setIsBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [diskBaseline, setDiskBaseline] = useState<Record<string, string>>({});
  const [canWriteToDisk, setCanWriteToDisk] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [diskMessage, setDiskMessage] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const machineTurns = useRef(new Map<string, string>());
  /** Turn checkpoints awaiting their finish call; the only-if-idle gate reads this. */
  const openTurns = useRef(new Set<string>());
  const machineStarting = useRef(0);

  const files = workspace?.files ?? EMPTY_FILES;
  /**
   * The whole workspace, not just the open tabs. A folder mount keeps its file
   * list in `diskFileTree` (paths + sizes, contents unread); single-file mounts
   * and freshly created buffers only exist in `files`, so both are merged.
   */
  const allFiles = useMemo<WorkspaceTreeEntry[]>(() => {
    const byPath = new Map<string, WorkspaceTreeEntry>();
    for (const entry of workspace?.diskFileTree ?? []) {
      byPath.set(entry.path, { name: entry.path, size: entry.size });
    }
    for (const file of files) {
      if (!byPath.has(file.name)) byPath.set(file.name, { name: file.name, size: file.content.length });
    }
    return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [workspace?.diskFileTree, files]);
  // CodeEditor renders `files[activeFileIndex] ?? files[0]`, so a document is on
  // screen even while no index is selected. Keystrokes must land in that same
  // file, otherwise the edit lives only in the CodeMirror doc. Both sides use
  // resolveActiveFileIndex so they cannot drift apart again.
  const activeFileIndex = resolveActiveFileIndex(selectedFileIndex, files.length);
  const activeFile = files[activeFileIndex] ?? null;

  useEffect(() => {
    const path = selectedFileIndex >= 0 ? files[selectedFileIndex]?.name : null;
    if (!path) return;
    setEditorGroups((previous) => {
      const current = previous[activeEditorGroup];
      if (!current || (current.activePath === path && current.tabs.includes(path))) return previous;
      const next = previous.slice();
      next[activeEditorGroup] = {
        ...current,
        tabs: current.tabs.includes(path) ? current.tabs : [...current.tabs, path],
        activePath: path
      };
      return next;
    });
  }, [files, selectedFileIndex, activeEditorGroup]);

  const filesRef = useRef<WorkspaceFile[]>(files);
  const baselineRef = useRef<Record<string, string>>(diskBaseline);
  const handlesRef = useRef<Map<string, any>>(new Map());
  const directoryHandleRef = useRef<any>(null);
  const canWriteRef = useRef(false);
  const desktopWorkspaceIdRef = useRef<string | null>(null);
  const workspaceIdentityRef = useRef<string | null>(null);
  const [directoryPages, setDirectoryPages] = useState<Record<string, DirectoryPage>>({});
  const pagesRef = useRef(directoryPages);
  pagesRef.current = directoryPages;
  const [loadingDirectories, setLoadingDirectories] = useState<string[]>([]);
  const directoryRequests = useRef(new Map<string, symbol>());
  const fileRequest = useRef(0);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const conflictRef = useRef(conflicts);
  conflictRef.current = conflicts;
  const deletedPaths = useRef(new Set<string>());
  const [pendingProposal, setPendingProposal] = useState<PatchProposal | null>(null);
  const proposalRef = useRef(pendingProposal);
  proposalRef.current = pendingProposal;
  const savingRef = useRef(false);
  const [changeRevision, setChangeRevision] = useState(0);
  /** The checkpoint the current turn was taken against — disk pre-images merge in here. */
  const activeCheckpointRef = useRef<{ id: string; workspacePath: string } | null>(null);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    baselineRef.current = diskBaseline;
  }, [diskBaseline]);

  /** Files edited in the browser but not (yet) written back to the user's disk. */
  const dirtyFiles = useMemo(() => {
    if (!canWriteToDisk) return [];
    return files.filter((file) => diskBaseline[file.name] !== file.content).map((file) => file.name);
  }, [files, diskBaseline, canWriteToDisk]);

  const refreshCheckpoints = useCallback(async (workspacePath: string) => {
    setCheckpoints(await listCheckpoints(workspacePath));
  }, []);

  const mount = useCallback(
    (name: string, path: string, kind: 'folder' | 'file', nextFiles: WorkspaceFile[], options: MountOptions = {}) => {
      const handles = options.handles ?? [];
      handlesRef.current = new Map(handles.map((entry) => [entry.path, entry.handle]));
      directoryHandleRef.current = options.directoryHandle ?? null;
      desktopWorkspaceIdRef.current = options.nativeWorkspaceId ?? null;
      workspaceIdentityRef.current = `${kind}-${path}`;
      filesRef.current = nextFiles;
      baselineRef.current = Object.fromEntries(nextFiles.map((file) => [file.name, file.content]));
      setDirectoryPages({});
      pagesRef.current = {};
      directoryRequests.current.clear();
      fileRequest.current += 1;
      setLoadingDirectories([]);
      setConflicts([]);
      setPendingProposal(null);
      activeCheckpointRef.current = null;
      setAssets(options.assets ?? {});
      const writable = handles.length > 0 || Boolean(options.directoryHandle) || Boolean(options.nativeWorkspaceId);
      canWriteRef.current = writable;
      setCanWriteToDisk(writable);

      // Everything just came off disk, so nothing is dirty yet.
      setDiskBaseline(Object.fromEntries(nextFiles.map((file) => [file.name, file.content])));
      setDiskMessage(writable ? null : 'Dropped files loaded as read-only. File System handles not provided by browser.');

      setWorkspace({
        id: `${kind}-${path}`,
        name,
        path,
        kind,
        nativeWorkspaceId: options.nativeWorkspaceId,
        files: nextFiles,
        diskFileCount: options.diskFileCount,
        diskFileCountTruncated: options.diskFileCountTruncated,
        diskFileTree: options.diskFileTree
      });
      setSelectedFileIndex(-1);
      const initialTabs = nextFiles.map((file) => file.name);
      setEditorGroups([{
        tabs: initialTabs,
        activePath: initialTabs[0] ?? null,
        pinnedTabs: []
      }]);
      setActiveEditorGroup(0);
      setStatusMessage(null);
      setRecents(pushRecentWorkspace({
        name,
        path,
        // A folder's buffers are empty until a tab is opened; the recent card
        // must show the folder's file count, not the tab count.
        fileCount: kind === 'folder' ? options.diskFileCount ?? nextFiles.length : nextFiles.length,
        kind,
        filePaths: options.filePaths
      }));
      void saveSnapshot({ path, name, kind, files: nextFiles });
      if (handles.length > 0 || options.directoryHandle) void saveHandles(path, handles, options.directoryHandle);
      void refreshCheckpoints(path);
    },
    [refreshCheckpoints]
  );

  const openFolder = useCallback(async () => {
    const desktop = getDesktopBridge();
    if (desktop) {
      setIsBusy(true);
      try {
        const opened = await desktop.openFolder();
        if (!opened) return;
        mount(opened.name, opened.rootPath, 'folder', opened.files.map((file) => ({
          ...file,
          language: detectLanguage(file.name)
        })), {
          assets: opened.assets,
          nativeWorkspaceId: opened.workspaceId,
          filePaths: opened.filePaths,
          diskFileCount: opened.fileCount,
          diskFileCountTruncated: opened.fileCountTruncated,
          diskFileTree: opened.fileTree
        });
        if (opened.warnings.length > 0) setStatusMessage(opened.warnings.join(' '));
      } catch (error) {
        setStatusMessage(error instanceof Error ? `Could not open folder: ${error.message}` : 'Could not open folder.');
      } finally {
        setIsBusy(false);
      }
      return;
    }

    if (!supportsDirectoryPicker()) {
      setStatusMessage('Folder picker is not supported in this browser. Please use Chrome, Edge, or Brave.');
      return;
    }
    setIsBusy(true);
    try {
      const directory = await pickDirectory();
      if (!directory) return;
      if (directory.files.length === 0) {
        setStatusMessage('No readable code files found in selected folder.');
        return;
      }
      if (!directory.writeGranted) {
        setStatusMessage(
          'Opened read-only — write access was declined, so ShadRox cannot save your files. Re-open the folder and allow editing.'
        );
      }
      mount(directory.name, directory.name, 'folder', directory.files, {
        handles: directory.handles,
        directoryHandle: directory.directoryHandle,
        assets: directory.assets
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setStatusMessage('Could not open folder. Please try again.');
    } finally {
      setIsBusy(false);
    }
  }, [mount]);

  const openFiles = useCallback(async () => {
    const desktop = getDesktopBridge();
    if (desktop) {
      setIsBusy(true);
      try {
        const opened = await desktop.openFiles();
        if (!opened) return;
        if (opened.files.length === 0) {
          setStatusMessage('No readable code files were selected.');
          return;
        }
        mount(opened.name, opened.rootPath, 'file', opened.files.map((file) => ({
          ...file,
          language: detectLanguage(file.name)
        })), {
          assets: opened.assets,
          nativeWorkspaceId: opened.workspaceId,
          filePaths: opened.filePaths
        });
        if (opened.warnings.length > 0) setStatusMessage(opened.warnings.join(' '));
      } catch (error) {
        setStatusMessage(error instanceof Error ? `Could not open files: ${error.message}` : 'Could not open files.');
      } finally {
        setIsBusy(false);
      }
      return;
    }

    if (!supportsFilePicker()) {
      setStatusMessage('File picker is not supported in this browser. Please drag and drop files.');
      return;
    }
    setIsBusy(true);
    try {
      const picked = await pickFiles();
      if (!picked || picked.files.length === 0) return;
      mount(
        picked.files.length === 1 ? picked.files[0].name : `${picked.files.length} files`,
        `files:${picked.files.map((file) => file.name).sort().join('|')}`,
        'file',
        picked.files,
        { handles: picked.handles }
      );
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setStatusMessage('Could not open files. Please try again.');
    } finally {
      setIsBusy(false);
    }
  }, [mount]);

  const openDropped = useCallback(
    async (list: FileList) => {
      setIsBusy(true);
      try {
        const dropped = await filesFromFileList(list);
        if (dropped.length === 0) {
          setStatusMessage('No readable code files detected in dropped items.');
          return;
        }
        mount(
          dropped.length === 1 ? dropped[0].name : `${dropped.length} files`,
          `files:${dropped.map((file) => file.name).sort().join('|')}`,
          'file',
          dropped
        );
      } finally {
        setIsBusy(false);
      }
    },
    [mount]
  );

  const openRecent = useCallback(
    async (entry: RecentEntry) => {
      setIsBusy(true);
      try {
        const desktop = getDesktopBridge();
        if (desktop?.reopenWorkspace) {
          try {
            const opened = await desktop.reopenWorkspace({
              kind: entry.kind,
              path: entry.path,
              filePaths: entry.filePaths
            });
            if (!opened) return;
            mount(opened.name, opened.rootPath, opened.kind, opened.files.map((file) => ({
              ...file,
              language: detectLanguage(file.name)
            })), {
              assets: opened.assets,
              nativeWorkspaceId: opened.workspaceId,
              filePaths: opened.filePaths,
              diskFileCount: opened.fileCount,
              diskFileCountTruncated: opened.fileCountTruncated,
              diskFileTree: opened.fileTree
            });
            if (opened.warnings.length > 0) setStatusMessage(opened.warnings.join(' '));
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Entries written by older builds stored an internal id instead of
            // a real path, so they can only be restored by picking again.
            const hasRealPath = /[\\/]/.test(entry.path);
            setStatusMessage(
              hasRealPath
                ? `Could not reopen ${entry.name}: ${message}`
                : `Select ${entry.name} again so ShadRox can remember its location.`
            );
            if (hasRealPath) return;
          }
        }

        if (desktop) {
          if (entry.kind === 'folder') await openFolder();
          else await openFiles();
          return;
        }

        const snapshot = await getSnapshot(entry.path);
        if (snapshot && snapshot.files.length > 0) {
          // Handles live in their own store, so a reopened workspace can still
          // write to disk — and its images can be read back into the preview.
          // Write access is asked for here, on the click that reopens the
          // folder, so it is one prompt at open instead of one per save.
          const stored = await loadHandleRecord(entry.path);
          let writeGranted = true;
          if (stored.directoryHandle) writeGranted = await ensureReadWrite(stored.directoryHandle);
          mount(snapshot.name, snapshot.path, snapshot.kind, snapshot.files, {
            handles: stored.entries,
            directoryHandle: stored.directoryHandle,
            assets: await hydrateAssets(stored.entries)
          });
          if (!writeGranted) {
            setStatusMessage(
              'Reopened read-only — the browser did not grant write access, so saves will not reach disk.'
            );
          }
          return;
        }
        // Entries saved before snapshots existed can only be restored by picking again.
        setStatusMessage(
          `No local snapshot cached for ${entry.name}. Please select the folder once to re-grant access.`
        );
        if (entry.kind === 'folder') await openFolder();
        else await openFiles();
      } finally {
        setIsBusy(false);
      }
    },
    [mount, openFolder, openFiles]
  );

  const removeRecent = useCallback((id: string) => {
    setRecents(removeRecentWorkspace(id));
  }, []);

  const loadDirectory = useCallback(async (path: string, cursor = 0) => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id || directoryRequests.current.has(path)) return;
    const request = Symbol();
    directoryRequests.current.set(path, request);
    setLoadingDirectories((previous) => [...previous, path]);
    try {
      const page = await desktop.listDirectory(id, path, cursor);
      if (desktopWorkspaceIdRef.current !== id) return;
      setDirectoryPages((previous) => ({
        ...previous,
        [path]: { ...page, entries: cursor ? [...(previous[path]?.entries ?? []), ...page.entries] : page.entries }
      }));
    } catch (error) {
      if (desktopWorkspaceIdRef.current === id) setStatusMessage(String(error));
    } finally {
      if (directoryRequests.current.get(path) === request) {
        directoryRequests.current.delete(path);
        setLoadingDirectories((previous) => previous.filter((entry) => entry !== path));
      }
    }
  }, []);

  useEffect(() => {
    if (workspace?.nativeWorkspaceId) void loadDirectory('');
  }, [workspace?.nativeWorkspaceId, loadDirectory]);

  const openFile = useCallback(async (name: string, groupIndex = activeEditorGroup) => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id) return;
    const request = ++fileRequest.current;
    const existing = filesRef.current.findIndex((file) => file.name === name);
    setActiveEditorGroup(groupIndex);
    if (existing >= 0) { setSelectedFileIndex(existing); return; }
    try {
      const loaded = await desktop.readFile(id, name);
      if (desktopWorkspaceIdRef.current !== id) return;
      const next = [...filesRef.current.filter((file) => file.name !== name), { ...loaded, language: detectLanguage(name) }];
      while (next.length > MAX_LOADED_BUFFERS) {
        const removable = next.findIndex((file) => file.name !== name && file.content === baselineRef.current[file.name] && !conflictRef.current.includes(file.name));
        if (removable < 0) break;
        next.splice(removable, 1);
      }
      filesRef.current = next;
      baselineRef.current = { ...baselineRef.current, [name]: loaded.content };
      setDiskBaseline(baselineRef.current);
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      if (request === fileRequest.current) setSelectedFileIndex(next.findIndex((file) => file.name === name));
    } catch (error) {
      if (desktopWorkspaceIdRef.current === id) setStatusMessage(`Could not open ${name}: ${String(error)}`);
    }
  }, [activeEditorGroup]);

  const splitEditor = useCallback(() => {
    if (editorGroups.length >= 2) return;
    const activePath = editorGroups[activeEditorGroup]?.activePath ?? files[activeFileIndex]?.name;
    if (!activePath) return;
    const nextIndex = editorGroups.length;
    setEditorGroups((previous) => [
      ...previous,
      { tabs: [activePath], activePath, pinnedTabs: [] }
    ]);
    setActiveEditorGroup(nextIndex);
    setSelectedFileIndex(filesRef.current.findIndex((file) => file.name === activePath));
  }, [activeEditorGroup, activeFileIndex, editorGroups, files]);

  const focusEditorGroup = useCallback((index: number) => {
    const group = editorGroups[index];
    if (!group) return;
    setActiveEditorGroup(index);
    setSelectedFileIndex(group.activePath
      ? filesRef.current.findIndex((file) => file.name === group.activePath)
      : -1);
  }, [editorGroups]);

  const closeEditorGroup = useCallback((index: number) => {
    if (editorGroups.length <= 1 || !editorGroups[index]) return;
    const nextGroups = editorGroups.filter((_, groupIndex) => groupIndex !== index);
    const nextActive = activeEditorGroup === index
      ? Math.max(0, index - 1)
      : activeEditorGroup > index ? activeEditorGroup - 1 : activeEditorGroup;
    setEditorGroups(nextGroups);
    setActiveEditorGroup(nextActive);
    const activePath = nextGroups[nextActive]?.activePath;
    setSelectedFileIndex(activePath
      ? filesRef.current.findIndex((file) => file.name === activePath)
      : -1);
  }, [activeEditorGroup, editorGroups]);

  const reorderEditorTabs = useCallback((groupIndex: number, fromPath: string, toPath: string) => {
    setEditorGroups((previous) => previous.map((group, index) => {
      if (index !== groupIndex) return group;
      const from = group.tabs.indexOf(fromPath);
      const to = group.tabs.indexOf(toPath);
      if (from < 0 || to < 0 || from === to) return group;
      const tabs = group.tabs.slice();
      tabs.splice(from, 1);
      tabs.splice(to, 0, fromPath);
      const pinned = new Set(group.pinnedTabs);
      return {
        ...group,
        tabs: [
          ...tabs.filter((path) => pinned.has(path)),
          ...tabs.filter((path) => !pinned.has(path))
        ]
      };
    }));
  }, []);

  const togglePinnedTab = useCallback((groupIndex: number, path: string) => {
    setEditorGroups((previous) => previous.map((group, index) => {
      if (index !== groupIndex || !group.tabs.includes(path)) return group;
      const pinnedTabs = group.pinnedTabs.includes(path)
        ? group.pinnedTabs.filter((entry) => entry !== path)
        : [path, ...group.pinnedTabs];
      return {
        ...group,
        pinnedTabs,
        tabs: [
          ...pinnedTabs.filter((entry) => group.tabs.includes(entry)),
          ...group.tabs.filter((entry) => !pinnedTabs.includes(entry))
        ]
      };
    }));
  }, []);

  const closeTab = useCallback(async (index: number, groupIndex = activeEditorGroup) => {
    const current = filesRef.current;
    const file = current[index];
    const group = editorGroups[groupIndex];
    if (!file || !group?.tabs.includes(file.name)) return;
    if (file.content !== baselineRef.current[file.name]) {
      const confirmed = await confirmAction({
        title: `Discard unsaved changes in "${file.name}"?`,
        body: 'Closing this tab discards your local edits. The copy on disk is unchanged.',
        confirmLabel: 'Discard changes',
        tone: 'danger'
      });
      if (!confirmed) return;
    }
    const remaining = group.tabs.filter((path) => path !== file.name);
    const activePath = group.activePath === file.name
      ? remaining[Math.min(group.tabs.indexOf(file.name), remaining.length - 1)] ?? null
      : group.activePath;
    const nextGroups = editorGroups.map((entry, entryIndex) => entryIndex === groupIndex
      ? {
          ...entry,
          tabs: remaining,
          pinnedTabs: entry.pinnedTabs.filter((path) => path !== file.name),
          activePath
        }
      : entry);
    const stillOpen = nextGroups.some((entry) => entry.tabs.includes(file.name));
    const next = stillOpen ? current : current.filter((entry) => entry.name !== file.name);
    filesRef.current = next;
    setEditorGroups(nextGroups);
    setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
    if (groupIndex === activeEditorGroup) {
      setSelectedFileIndex(activePath
        ? next.findIndex((entry) => entry.name === activePath)
        : -1);
    }
    setConflicts((previous) => previous.filter((name) => name !== file.name));
  }, [activeEditorGroup, editorGroups]);

  const refreshDiskFile = useCallback(async (name: string, force?: 'reload' | 'keep') => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id) return;
    try {
      const loaded = await desktop.readFile(id, name);
      if (desktopWorkspaceIdRef.current !== id) return;
      const current = filesRef.current.find((file) => file.name === name);
      if (!current) return;
      if (!force && current.content !== baselineRef.current[name] && current.content !== loaded.content && baselineRef.current[name] !== loaded.content) {
        setConflicts((previous) => [...new Set([...previous, name])]);
        return;
      }
      const next = filesRef.current.map((file) => file.name !== name ? file : {
        ...file, content: force === 'keep' || (!force && current.content !== baselineRef.current[name]) ? current.content : loaded.content,
        version: loaded.version
      });
      filesRef.current = next;
      baselineRef.current = { ...baselineRef.current, [name]: loaded.content };
      setDiskBaseline(baselineRef.current);
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      setConflicts((previous) => previous.filter((path) => path !== name));
    } catch (error) {
      if (desktopWorkspaceIdRef.current !== id) return;
      setConflicts((previous) => [...new Set([...previous, name])]);
      setDiskMessage(`Cannot reload ${name}; it may have been deleted or moved. Your editor buffer is preserved. ${String(error)}`);
    }
  }, []);

  const resolveConflict = useCallback(async (name: string, action: 'reload' | 'keep') => {
    if (deletedPaths.current.has(name)) {
      const next = action === 'reload' ? filesRef.current.filter((file) => file.name !== name)
        : filesRef.current.map((file) => file.name === name ? { ...file, version: undefined } : file);
      filesRef.current = next;
      delete baselineRef.current[name];
      setDiskBaseline({ ...baselineRef.current });
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      setSelectedFileIndex(-1);
      setConflicts((previous) => previous.filter((path) => path !== name));
      deletedPaths.current.delete(name);
      return;
    }
    await refreshDiskFile(name, action);
  }, [refreshDiskFile]);

  /**
   * Folds fs-watcher deltas into the flat tree a folder mount captured once.
   * Without this a file deleted (or created) by the agent stayed in
   * `diskFileTree` forever, because nothing re-lists the whole folder.
   */
  const applyDiskTreeChanges = useCallback((changes: WorkspaceChange['changes']) => {
    if (changes.length === 0) return;
    setWorkspace((previous) => {
      const tree = previous?.diskFileTree;
      if (!previous || !tree) return previous;
      let next = tree;
      const removed = changes.filter((change) => change.kind === 'unlink' || change.kind === 'unlinkDir');
      if (removed.length > 0) {
        const gone = (path: string) => removed.some((change) => change.kind === 'unlinkDir'
          ? path === change.path || path.startsWith(`${change.path}/`)
          : path === change.path);
        const kept = next.filter((entry) => !gone(entry.path));
        if (kept.length !== next.length) next = kept;
      }
      const added = changes.filter((change) => change.kind === 'add');
      if (added.length > 0) {
        const known = new Set(next.map((entry) => entry.path));
        // Size is unknown until the next full list; 0 is what listWorkspaceFiles
        // also reports for a path it could not stat.
        const fresh = added.filter((change) => !known.has(change.path)).map((change) => ({ path: change.path, size: 0 }));
        if (fresh.length > 0) next = [...next, ...fresh].sort((left, right) => left.path.localeCompare(right.path));
      }
      if (next === tree) return previous;
      return {
        ...previous,
        diskFileTree: next,
        diskFileCount: previous.diskFileCountTruncated ? previous.diskFileCount : next.length
      };
    });
  }, []);

  /**
   * A tracked file disappeared from disk. A clean buffer is dropped and its tab
   * closed so the editor cannot keep showing contents that no longer exist; a
   * buffer with local edits is kept and flagged instead, because closing it
   * would silently throw the user's work away.
   */
  const dropDeletedBuffer = useCallback((name: string) => {
    const current = filesRef.current;
    const index = current.findIndex((file) => file.name === name);
    if (index < 0) return;
    if (current[index].content !== baselineRef.current[name]) {
      deletedPaths.current.add(name);
      setConflicts((previous) => [...new Set([...previous, name])]);
      setDiskMessage(`${name} was deleted on disk. Your unsaved edits are still in the editor — save to recreate it, or close the tab to discard them.`);
      return;
    }
    const next = current.filter((file) => file.name !== name);
    filesRef.current = next;
    delete baselineRef.current[name];
    setDiskBaseline({ ...baselineRef.current });
    setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
    setEditorGroups((previous) => previous.map((group) => ({
      ...group,
      tabs: group.tabs.filter((path) => path !== name),
      pinnedTabs: group.pinnedTabs.filter((path) => path !== name),
      activePath: group.activePath === name ? null : group.activePath
    })));
    setSelectedFileIndex((selected) => selected === -1 ? -1 : selected > index ? selected - 1 : selected === index ? Math.min(index, next.length - 1) : selected);
    setConflicts((previous) => previous.filter((path) => path !== name));
    deletedPaths.current.delete(name);
    setDiskMessage(`${name} was deleted on disk — its tab is closed.`);
  }, []);

  useEffect(() => {
    const desktop = getDesktopBridge();
    const id = workspace?.nativeWorkspaceId;
    if (!desktop || !id) return;
    let queued: WorkspaceChange['changes'] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const flush = () => {
      if (disposed) return;
      if (savingRef.current) { timer = setTimeout(flush, 100); return; }
      const changes = queued;
      queued = [];
      const parents = new Set(changes.map(({ path }) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''));
      for (const parent of parents) if (pagesRef.current[parent]) void loadDirectory(parent);
      // The explorer counts and attach list read `diskFileTree`, which a folder
      // mount only fills once. Apply the watcher's deltas so a delete or a file
      // the agent created shows up no matter who made the change.
      applyDiskTreeChanges(changes);
      for (const file of filesRef.current) {
        const change = [...changes].reverse().find((entry) => entry.path === file.name || (entry.kind === 'unlinkDir' && file.name.startsWith(`${entry.path}/`)));
        if (change) {
          if (change.kind === 'unlink' || change.kind === 'unlinkDir') {
            dropDeletedBuffer(file.name);
          } else {
            deletedPaths.current.delete(file.name);
            void refreshDiskFile(file.name);
          }
        }
      }
      setChangeRevision((value) => value + 1);
    };
    const unsubscribe = desktop.onWorkspaceChange((event) => {
      if (event.workspaceId !== id) return;
      queued = [...queued, ...event.changes].slice(-2000);
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [workspace?.nativeWorkspaceId, loadDirectory, refreshDiskFile, applyDiskTreeChanges, dropDeletedBuffer]);

  const selectFile = useCallback((index: number, groupIndex = activeEditorGroup) => {
    fileRequest.current += 1;
    setActiveEditorGroup(groupIndex);
    setSelectedFileIndex(index);
  }, [activeEditorGroup]);

  const closeFile = useCallback(() => {
    setSelectedFileIndex(-1);
    setEditorGroups((previous) => previous.map((group, index) => (
      index === activeEditorGroup ? { ...group, activePath: null } : group
    )));
  }, [activeEditorGroup]);

  const updateActiveContent = useCallback(
    (content: string) => {
      setWorkspace((previous) => {
        if (!previous) return previous;
        const nextFiles = previous.files.map((file, index) =>
          index === activeFileIndex ? { ...file, content } : file
        );
        return { ...previous, files: nextFiles };
      });
    },
    [activeFileIndex]
  );

  const applyFilePatches = useCallback((patches: FilePatch[]): ApplyPatchesResult => {
    const result: ApplyPatchesResult = { updated: [], created: [], unchanged: [] };
    if (!workspace || workspaceIdentityRef.current !== `${workspace.kind}-${workspace.path}` || patches.length === 0) return result;
    const next = [...filesRef.current];
    for (const patch of patches) {
      const target = patch.path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!target || target.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const index = next.findIndex((file) => file.name.toLowerCase() === target.toLowerCase());
      if (index >= 0) {
        if (next[index].content === patch.content) result.unchanged.push(next[index].name);
        else {
          next[index] = { ...next[index], content: patch.content };
          result.updated.push(next[index].name);
        }
      } else {
        next.push({ name: target, content: patch.content, language: detectLanguage(target) });
        result.created.push(target);
      }
    }
    if (result.updated.length || result.created.length) {
      filesRef.current = next;
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      setSelectedFileIndex(next.findIndex((file) => file.name === result.updated[0] || file.name === result.created[0]));
    }
    return result;
  }, [workspace]);

  /**
   * Pulls the named files off disk into editor buffers before a patch touches
   * them. A folder is mounted as paths only, so the file the assistant means to
   * edit is almost never open yet — and an edit to a file with no buffer was
   * treated as creating a brand-new file, which the transactional save refused
   * because the path already exists. Loading the real content fixes both: the
   * patch has text to match against and the baseline version is known.
   */
  const loadFilesForPatching = useCallback(async (paths: string[]): Promise<WorkspaceFile[]> => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id) return filesRef.current;
    const identity = workspaceIdentityRef.current;
    const wanted = [...new Set(paths.map(normalizeWorkspacePath))]
      .filter((path) => isEditablePath(path))
      .filter((path) => !filesRef.current.some((file) => file.name.toLowerCase() === path.toLowerCase()));
    if (wanted.length === 0) return filesRef.current;

    const loaded = await desktop.loadFiles(id, wanted).catch((error: unknown) => {
      setDiskMessage(`Could not load the files to patch: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!loaded) return filesRef.current;
    if (desktopWorkspaceIdRef.current !== id || workspaceIdentityRef.current !== identity) return filesRef.current;

    const additions = loaded.files
      .filter((file) => !filesRef.current.some((existing) => existing.name === file.name))
      .map((file) => ({
        name: file.name,
        content: file.content,
        language: detectLanguage(file.name),
        version: file.version
      }));
    if (additions.length === 0) {
      if (loaded.missing.length > 0) {
        setDiskMessage(`${loaded.missing.length} file${loaded.missing.length === 1 ? '' : 's'} the patch targets could not be read: ${loaded.missing.slice(0, 3).map((entry) => entry.path).join(', ')}.`);
      }
      return filesRef.current;
    }

    const next = [...filesRef.current, ...additions];
    const active = activeCheckpointRef.current;
    if (active && workspaceIdentityRef.current === identity) {
      void mergeCheckpointFiles(active.id, additions);
    }
    const protect = new Set(additions.map((file) => file.name));
    while (next.length > MAX_LOADED_BUFFERS) {
      const removable = next.findIndex((file) => !protect.has(file.name)
        && file.content === baselineRef.current[file.name]
        && !conflictRef.current.includes(file.name));
      if (removable < 0) break;
      next.splice(removable, 1);
    }
    additions.forEach((file) => {
      baselineRef.current[file.name] = file.content;
    });
    filesRef.current = next;
    setDiskBaseline({ ...baselineRef.current });
    setWorkspace((previous) => (previous ? { ...previous, files: next } : previous));
    return next;
  }, []);

  // --- disk write-back -------------------------------------------------------

  /** Finds (or creates) the handle for a workspace-relative path. */
  const resolveHandle = useCallback(async (path: string): Promise<any | null> => {
    const existing = handlesRef.current.get(path);
    if (existing) return existing;

    const root = directoryHandleRef.current;
    if (!root) return null;

    try {
      const segments = path.split('/').filter(Boolean);
      let directory = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        directory = await directory.getDirectoryHandle(segments[index], { create: true });
      }
      const handle = await directory.getFileHandle(segments[segments.length - 1], { create: true });
      handlesRef.current.set(path, handle);
      return handle;
    } catch (error) {
      console.warn('[shadrox] could not resolve a disk handle for', path, error);
      return null;
    }
  }, []);

  /**
   * Permission is normally already granted at folder-open time. `requestPermission`
   * only works inside a user gesture, so a debounced auto-save that finds the
   * grant expired cannot prompt — it reports the problem instead of blocking.
   */
  const writeOne = useCallback(
    async (file: WorkspaceFile): Promise<boolean> => {
      const handle = await resolveHandle(file.name);
      if (!handle) return false;

      if (!(await ensureReadWrite(handle))) {
        setDiskMessage('Write access expired for this folder. Re-open it from the hub to grant it again.');
        return false;
      }

      const writable = await handle.createWritable();
      await writable.write(file.content);
      await writable.close();
      setDiskBaseline((previous) => ({ ...previous, [file.name]: file.content }));
      return true;
    },
    [resolveHandle]
  );

  const saveFilesToDisk = useCallback(
    async (names: string[]): Promise<SaveOutcome> => {
      const skipped = (message: string | null): SaveOutcome => ({ written: 0, failed: true, message });
      if (!canWriteRef.current) {
        return skipped('This workspace has no writable files, so nothing could be saved.');
      }
      if (names.length === 0) return { written: 0, failed: false, message: null };
      if (savingRef.current) return skipped('A save is already running — try again in a moment.');
      if (names.some((name) => conflictRef.current.includes(name))) {
        setDiskMessage('Resolve external file changes before saving. No files were written.');
        return skipped('Resolve the external file changes first — no files were written.');
      }
      savingRef.current = true;
      setIsSaving(true);
      setDiskMessage(null);

      let written = 0;
      let failed = false;

      try {
        const snapshot = filesRef.current;
        const desktop = getDesktopBridge();
        const nativeWorkspaceId = desktopWorkspaceIdRef.current;
        if (desktop && nativeWorkspaceId) {
          const requested = snapshot.filter((file) => names.includes(file.name));
          const result = await desktop.saveFiles(nativeWorkspaceId, requested.map((file) => ({
            name: file.name, content: file.content, expectedVersion: file.version ?? null
          })));
          if (desktopWorkspaceIdRef.current !== nativeWorkspaceId) {
            return skipped('The workspace changed while saving — no confirmation available.');
          }
          written = result.saved.length;
          failed = result.errors.length > 0;
          const savedFiles = new Set(result.saved);
          if (savedFiles.size > 0) {
            const saved = snapshot.filter((file) => savedFiles.has(file.name));
            const versions = new Map(await Promise.all(saved.map(async (file) => [file.name, await contentVersion(file.content)] as const)));
            if (desktopWorkspaceIdRef.current !== nativeWorkspaceId) {
              return { written, failed: true, message: 'The workspace changed while saving.' };
            }
            baselineRef.current = { ...baselineRef.current, ...Object.fromEntries(saved.map((file) => [file.name, file.content])) };
            setDiskBaseline(baselineRef.current);
            setWorkspace((previous) => previous ? { ...previous, files: previous.files.map((file) => versions.has(file.name) ? { ...file, version: versions.get(file.name) } : file) } : previous);
          }
          const errorText = result.errors
            .map((error) => `${error.name || 'File'}: ${error.message}`)
            .join(' ');
          if (result.errors.length > 0) {
            setDiskMessage(`${written} file${written === 1 ? '' : 's'} saved. ${errorText}`);
          } else if (written > 0) {
            setDiskMessage(`${written} file${written > 1 ? 's' : ''} saved to disk.`);
          }
          return { written, failed, message: result.errors.length ? errorText : null };
        }

        for (const name of names) {
          const file = snapshot.find((candidate) => candidate.name === name);
          if (!file) continue;
          if (await writeOne(file)) written += 1;
          else failed = true;
        }
        if (written > 0) setDiskMessage(`${written} file${written > 1 ? 's' : ''} saved to disk.`);
        else if (failed) setDiskMessage('Save failed — missing file handle or permission.');
      } catch (error) {
        const message = error instanceof Error ? `Save failed: ${error.message}` : 'Save failed.';
        setDiskMessage(message);
        return { written: 0, failed: true, message };
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
      return { written, failed, message: failed && written === 0 ? 'Save failed — missing file handle or permission.' : null };
    },
    [writeOne]
  );

  const saveAll = useCallback(async () => {
    const baseline = baselineRef.current;
    await saveFilesToDisk(
      filesRef.current.filter((file) => baseline[file.name] !== file.content).map((file) => file.name)
    );
  }, [saveFilesToDisk]);

  /**
   * One disk transaction for a whole review set. A batch can only be staged
   * when every file already exists on disk (baseline) and none is conflicted;
   * anything else — browsers, freshly created files — falls back to per-file
   * writes and reports that the save was not transactional.
   */
  const saveFilesAtomic = useCallback(
    async (names: string[]): Promise<SaveOutcome> => {
      const requested = [...new Set(names)];
      if (requested.length === 0) return { written: 0, failed: false, message: null };
      if (savingRef.current) return { written: 0, failed: true, message: 'A save is already running — try again in a moment.' };

      const desktop = getDesktopBridge();
      const id = desktopWorkspaceIdRef.current;
      const snapshot = filesRef.current.filter((file) => requested.includes(file.name));
      const stageable = Boolean(desktop && id)
        && snapshot.length === requested.length
        && !requested.some((name) => conflictRef.current.includes(name));

      if (!desktop || !id || !stageable) {
        const reason = !desktop
          ? 'Saves are not transactional in browser mode — files are written one at a time.'
          : 'This batch could not be staged for a transactional save — files were written one at a time.';
        const outcome = await saveFilesToDisk(requested);
        return {
          written: outcome.written,
          failed: outcome.failed,
          message: [outcome.message, reason].filter(Boolean).join(' ')
        };
      }

      savingRef.current = true;
      setIsSaving(true);
      setDiskMessage(null);
      let transactionId: string | null = null;
      try {
        const staged = await desktop.stageFiles(id, snapshot.map((file) => ({
          name: file.name,
          content: file.content,
          // Unknown baseline (a brand-new buffer) skips the stage-time comparison;
          // the staged transaction still pins the on-disk version at commit time.
          expectedVersion: baselineRef.current[file.name] !== undefined ? file.version ?? null : undefined
        })));
        transactionId = staged.transactionId;
        const result = await desktop.commitTransaction(id, staged.transactionId);
        const errorText = result.errors.map((error) => `${error.name || 'File'}: ${error.message}`).join(' ');
        if (result.errors.length > 0 || result.saved.length !== requested.length) {
          await desktop.discardTransaction(id, staged.transactionId).catch(() => {});
          transactionId = null;
          const rollbackText = result.rollbackErrors?.length
            ? ` Some files could not be restored: ${result.rollbackErrors.map((error) => error.name).join(', ')}.`
            : result.rolledBack ? ' The change set was rolled back.' : '';
          const message = `${errorText || 'The transaction was not committed completely.'}${rollbackText}`;
          setDiskMessage(`Atomic save failed: ${message}`);
          return { written: 0, failed: true, message };
        }
        transactionId = null;
        if (desktopWorkspaceIdRef.current !== id) {
          return { written: 0, failed: true, message: 'The workspace changed while saving — no confirmation available.' };
        }
        const versions = new Map(await Promise.all(snapshot.map(async (file) => [file.name, await contentVersion(file.content)] as const)));
        baselineRef.current = { ...baselineRef.current, ...Object.fromEntries(snapshot.map((file) => [file.name, file.content])) };
        setDiskBaseline(baselineRef.current);
        setWorkspace((previous) => previous ? { ...previous, files: previous.files.map((file) => versions.has(file.name) ? { ...file, version: versions.get(file.name) } : file) } : previous);
        setDiskMessage(`${requested.length} file${requested.length === 1 ? '' : 's'} saved to disk as one transaction.`);
        return { written: requested.length, failed: false, message: null };
      } catch (error) {
        if (transactionId) await desktop.discardTransaction(id, transactionId).catch(() => {});
        const message = error instanceof Error ? error.message : 'Unknown write error.';
        setDiskMessage(`Atomic save failed: ${message}`);
        return { written: 0, failed: true, message };
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [saveFilesToDisk]
  );

  // --- assistant edits -------------------------------------------------------

  const discardProposal = useCallback(async () => {
    const proposal = proposalRef.current;
    if (!proposal || savingRef.current) return;
    const desktop = getDesktopBridge();
    if (desktop && desktopWorkspaceIdRef.current) {
      await desktop.discardTransaction(desktopWorkspaceIdRef.current, proposal.transactionId);
    }
    proposalRef.current = null;
    setPendingProposal(null);
  }, []);

  const stageFilePatches = useCallback(async (patches: FilePatch[], base: WorkspaceFile[], identity: string) => {
    if (workspaceIdentityRef.current !== identity || !patches.length) return;
    if (savingRef.current) throw new Error('Wait for the current save before staging changes.');
    const originals = new Map(base.map((file) => [file.name, file]));
    for (const patch of patches) {
      const current = filesRef.current.find((file) => file.name === patch.path);
      if (current?.content !== originals.get(patch.path)?.content) throw new Error(`${patch.path} changed during generation. Generate a fresh proposal.`);
      if (conflictRef.current.includes(patch.path)) throw new Error(`Resolve the external change in ${patch.path} first.`);
    }
    await discardProposal();
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    const staged = desktop && id ? await desktop.stageFiles(id, patches.map((patch) => ({
      name: patch.path, content: patch.content, expectedVersion: originals.get(patch.path)?.version ?? null
    }))) : {
      transactionId: crypto.randomUUID(),
      files: patches.map((patch) => ({ name: patch.path, before: originals.get(patch.path)?.content ?? null, after: patch.content }))
    };
    if (workspaceIdentityRef.current !== identity) {
      if (desktop && id) await desktop.discardTransaction(id, staged.transactionId).catch(() => {});
      return;
    }
    const proposal = { ...staged, workspaceId: identity, base };
    proposalRef.current = proposal;
    setPendingProposal(proposal);
  }, [discardProposal]);

  const applyProposal = useCallback(async () => {
    const proposal = proposalRef.current;
    if (!proposal || savingRef.current || proposal.workspaceId !== workspaceIdentityRef.current) return;
    const current = filesRef.current;
    for (const patch of proposal.files) {
      if (current.find((file) => file.name === patch.name)?.content !== proposal.base.find((file) => file.name === patch.name)?.content || conflictRef.current.includes(patch.name)) {
        setDiskMessage(`${patch.name} changed after staging. Discard this proposal and generate it again.`);
        return;
      }
    }
    savingRef.current = true;
    setIsSaving(true);
    try {
      const desktop = getDesktopBridge();
      const id = desktopWorkspaceIdRef.current;
      const versions = new Map(await Promise.all(proposal.files.map(async (patch) => [patch.name, await contentVersion(patch.after)] as const)));
      if (desktop && id) {
        const result = await desktop.commitTransaction(id, proposal.transactionId);
        if (result.errors.length) throw new Error(result.errors.map((error) => `${error.name}: ${error.message}`).join(' '));
      }
      if (proposal.workspaceId !== workspaceIdentityRef.current) return;
      const next = [...filesRef.current];
      for (const patch of proposal.files) {
        const index = next.findIndex((file) => file.name === patch.name);
        const original = proposal.base.find((file) => file.name === patch.name);
        const file = { name: patch.name, content: patch.after, language: detectLanguage(patch.name), version: desktop && id ? versions.get(patch.name) : undefined };
        if (index < 0) next.push(file);
        else next[index] = { ...file, content: next[index].content === original?.content ? patch.after : next[index].content };
        if (desktop && id) baselineRef.current = { ...baselineRef.current, [patch.name]: patch.after };
      }
      filesRef.current = next;
      setDiskBaseline(baselineRef.current);
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      setSelectedFileIndex(next.findIndex((file) => file.name === proposal.files[0]?.name));
      proposalRef.current = null;
      setPendingProposal(null);
      setDiskMessage(desktop && id ? `${proposal.files.length} staged files applied to disk.` : 'Proposal applied to editor buffers. Save to disk separately; browser saves are not transactional.');
      setChangeRevision((value) => value + 1);
      for (const path of Object.keys(pagesRef.current)) void loadDirectory(path);
    } catch (error) {
      setDiskMessage(`Proposal not applied: ${String(error)}`);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [loadDirectory]);

  /**
   * Tags the turn's checkpoint with the paths an apply created, so a rollback
   * deletes them again. A file the user made by hand is never in this list.
   */
  const noteCheckpointCreated = useCallback(async (paths: string[]): Promise<void> => {
    const active = activeCheckpointRef.current;
    if (!active || paths.length === 0) return;
    await addCheckpointCreatedPaths(active.id, paths);
  }, []);

  const createFile = useCallback((name: string, content = '') => {
    const cleanName = normalizeWorkspacePath(name);
    if (!cleanName || !isEditablePath(cleanName)) {
      setDiskMessage('That file name is not a valid workspace path.');
      return;
    }
    const existingIndex = filesRef.current.findIndex((file) => file.name === cleanName);
    if (existingIndex >= 0) {
      setSelectedFileIndex(existingIndex);
      return;
    }
    const created: WorkspaceFile = { name: cleanName, content, language: detectLanguage(cleanName) };
    const next = [...filesRef.current, created];
    filesRef.current = next;
    setWorkspace((previous) => previous
      ? { ...previous, files: next }
      : {
          id: `file-${cleanName}`,
          name: cleanName,
          path: `file:${cleanName}`,
          kind: 'file',
          nativeWorkspaceId: undefined,
          files: next
        });
    setSelectedFileIndex(next.length - 1);

    // "New file" must produce a file. In a desktop folder the buffer is written
    // straight through; the created path is tagged on the turn's checkpoint so a
    // rollback can delete it again.
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (desktop && id && workspaceIdentityRef.current?.startsWith('folder-')) {
      void saveFilesAtomic([cleanName]).then((outcome) => {
        if (outcome.failed || outcome.written === 0) return;
        void noteCheckpointCreated([cleanName]);
        void loadDirectory(cleanName.split('/').slice(0, -1).join('/'));
      });
    }
  }, [saveFilesAtomic, noteCheckpointCreated, loadDirectory]);

  const deleteFile = useCallback((index: number) => {
    const current = filesRef.current;
    if (current.length <= 1 || !current[index]) return;
    const deletedPath = current[index].name;
    const nextFiles = current.filter((_, fileIndex) => fileIndex !== index);
    filesRef.current = nextFiles;
    delete baselineRef.current[deletedPath];
    setDiskBaseline({ ...baselineRef.current });
    setWorkspace((previous) => previous ? { ...previous, files: nextFiles } : previous);
    setEditorGroups((previous) => previous.map((group) => ({
      ...group,
      tabs: group.tabs.filter((path) => path !== deletedPath),
      pinnedTabs: group.pinnedTabs.filter((path) => path !== deletedPath),
      activePath: group.activePath === deletedPath ? null : group.activePath
    })));
    setSelectedFileIndex((active) => active === -1 ? -1 : Math.min(active, nextFiles.length - 1));
  }, []);

  const renameFile = useCallback(async (from: string, to: string) => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    const cleanTo = to.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!desktop || !id) {
      setDiskMessage('Renaming files is available in the desktop app.');
      return false;
    }
    if (!cleanTo || cleanTo === from) return false;
    if (filesRef.current.some((file) => file.name === cleanTo)) {
      setDiskMessage(`A file named ${cleanTo} is already open.`);
      return false;
    }
    try {
      const renamed = await desktop.renameFile(id, from, cleanTo);
      if (desktopWorkspaceIdRef.current !== id) return false;
      const next = filesRef.current.map((file) => file.name === from
        ? { ...file, name: cleanTo, version: renamed.version ?? file.version, language: detectLanguage(cleanTo) }
        : file);
      filesRef.current = next;
      const previousBaseline = baselineRef.current[from];
      delete baselineRef.current[from];
      if (previousBaseline !== undefined) baselineRef.current[cleanTo] = previousBaseline;
      setDiskBaseline({ ...baselineRef.current });
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      setEditorGroups((previous) => previous.map((group) => ({
        ...group,
        tabs: group.tabs.map((path) => path === from ? cleanTo : path),
        pinnedTabs: group.pinnedTabs.map((path) => path === from ? cleanTo : path),
        activePath: group.activePath === from ? cleanTo : group.activePath
      })));
      setConflicts((previous) => previous.filter((name) => name !== from));
      setDiskMessage(`Renamed ${from} to ${cleanTo}.`);
      return true;
    } catch (error) {
      setDiskMessage(`Could not rename ${from}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, []);

  /** Explorer "New Folder". Desktop folders only; the bridge refuses dot-names. */
  const createDirectory = useCallback(async (rawPath: string): Promise<boolean> => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    const clean = normalizeWorkspacePath(rawPath);
    if (!clean || !isEditablePath(clean)) {
      setDiskMessage('That folder name is not a valid workspace path.');
      return false;
    }
    if (!desktop || !id) {
      setDiskMessage('Creating folders is available in the desktop app.');
      return false;
    }
    try {
      await desktop.createDirectory(id, clean);
      setDiskMessage(`Created folder ${clean}.`);
      void loadDirectory(clean.split('/').slice(0, -1).join('/'));
      return true;
    } catch (error) {
      setDiskMessage(`Could not create ${clean}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [loadDirectory]);

  /**
   * Removes one file (or empty folder) from disk and its buffer from the editor.
   * Refuses a buffer with unsaved edits so a delete can never throw away work
   * that was only ever in the editor.
   */
  const deleteWorkspaceEntry = useCallback(async (rawPath: string): Promise<boolean> => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    const clean = normalizeWorkspacePath(rawPath);
    if (!clean || !isEditablePath(clean)) {
      setDiskMessage('That path is not a valid workspace entry.');
      return false;
    }
    if (!desktop || !id) {
      setDiskMessage('Deleting files is available in the desktop app.');
      return false;
    }
    const buffer = filesRef.current.find((file) => file.name === clean);
    if (buffer && buffer.content !== baselineRef.current[clean]) {
      setDiskMessage(`${clean} has unsaved edits — save or revert it before deleting.`);
      return false;
    }
    try {
      const removed = await desktop.deletePath(id, clean);
      if (desktopWorkspaceIdRef.current !== id) return false;
      const index = filesRef.current.findIndex((file) => file.name === clean);
      if (index >= 0) {
        const next = filesRef.current.filter((file) => file.name !== clean);
        filesRef.current = next;
        delete baselineRef.current[clean];
        setDiskBaseline({ ...baselineRef.current });
        setWorkspace((previous) => (previous ? { ...previous, files: next } : previous));
        setEditorGroups((previous) => previous.map((group) => ({
          ...group,
          tabs: group.tabs.filter((path) => path !== clean),
          pinnedTabs: group.pinnedTabs.filter((path) => path !== clean),
          activePath: group.activePath === clean ? null : group.activePath
        })));
        setSelectedFileIndex((current) => (current === -1 ? -1 : current > index ? current - 1 : current === index ? Math.min(index, next.length - 1) : current));
      }
      setConflicts((previous) => previous.filter((name) => name !== clean));
      deletedPaths.current.delete(clean);
      // Refresh the explorer immediately instead of waiting for the watcher.
      applyDiskTreeChanges([{ path: clean, kind: removed.kind === 'directory' ? 'unlinkDir' : 'unlink' }]);
      void loadDirectory(clean.split('/').slice(0, -1).join('/'));
      setDiskMessage(`Deleted ${removed.kind === 'directory' ? 'folder' : 'file'} ${clean}.`);
      return true;
    } catch (error) {
      setDiskMessage(`Could not delete ${clean}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [loadDirectory, applyDiskTreeChanges]);

  const revertActiveFile = useCallback(async () => {
    const file = filesRef.current[activeFileIndex];
    if (!file) return;
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id) {
      setDiskMessage('Revert to disk is available in the desktop app.');
      return;
    }
    try {
      const loaded = await desktop.readFile(id, file.name);
      if (desktopWorkspaceIdRef.current !== id) return;
      const next = filesRef.current.map((entry) => entry.name === file.name
        ? { ...entry, content: loaded.content, version: loaded.version }
        : entry);
      filesRef.current = next;
      baselineRef.current = { ...baselineRef.current, [file.name]: loaded.content };
      setDiskBaseline({ ...baselineRef.current });
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      // Reverting is the user's own action; it does not need a notification.
      setDiskMessage(null);
    } catch (error) {
      setDiskMessage(`Could not revert ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [activeFileIndex]);

  const closeWorkspace = useCallback(() => {
    const desktop = getDesktopBridge();
    const currentId = desktopWorkspaceIdRef.current;
    if (desktop && currentId) void desktop.closeWorkspace(currentId);
    setWorkspace(null);
    setSelectedFileIndex(-1);
    setEditorGroups([{ tabs: [], activePath: null, pinnedTabs: [] }]);
    setActiveEditorGroup(0);
    workspaceIdentityRef.current = null;
    filesRef.current = [];
    baselineRef.current = {};
    directoryRequests.current.clear();
    deletedPaths.current.clear();
    setAssets({});
    setDirectoryPages({});
    pagesRef.current = {};
    setLoadingDirectories([]);
    setConflicts([]);
    setPendingProposal(null);
    proposalRef.current = null;
    setStatusMessage(null);
    setDiskMessage(null);
    setCheckpoints([]);
    // A closed workspace can never finish its turns; drop the idle gate so a
    // later manual apply is not blocked by checkpoints of a workspace that is
    // gone. Their native snapshots die with the workspace handle anyway.
    machineTurns.current.clear();
    openTurns.current.clear();
    machineStarting.current = 0;
    activeCheckpointRef.current = null;
    handlesRef.current = new Map();
    directoryHandleRef.current = null;
    desktopWorkspaceIdRef.current = null;
    canWriteRef.current = false;
    setCanWriteToDisk(false);
  }, []);

  // --- restore timeline ------------------------------------------------------

  const markCheckpoint = useCallback(
    async (messageId: string, label: string, machine = true, onlyIfIdle = false, turn = true): Promise<string | null> => {
      // The idle gate covers every open turn — native machine turns *and* plain
      // buffer-only ones — so a nested apply never takes a second snapshot while
      // a turn is running, and never re-points activeCheckpointRef mid-turn.
      if (!workspace || (onlyIfIdle && (machineTurns.current.size || openTurns.current.size || machineStarting.current))) return null;
      machineStarting.current++;
      const desktop = getDesktopBridge();
      const nativeId = desktopWorkspaceIdRef.current;
      try {
        const meta = await saveCheckpoint({
          workspacePath: workspace.path, messageId, label, files: filesRef.current,
          machine: Boolean(machine && desktop && nativeId && workspace.kind === 'folder')
        });
        if (!meta) return null;
        if (turn) openTurns.current.add(meta.id);
        if (meta.machine && desktop && nativeId) {
          machineTurns.current.set(meta.id, nativeId);
          try { meta.machineReport = await desktop.beginMachineTurn(nativeId, meta.id); }
          catch { machineTurns.current.delete(meta.id); setDiskMessage('Machine snapshot unavailable for this turn; disk rewind is disabled.'); }
        }
        if (desktopWorkspaceIdRef.current !== nativeId) return meta.id;
        activeCheckpointRef.current = { id: meta.id, workspacePath: workspace.path };
        setCheckpoints((previous) => [meta, ...previous]);
        return meta.id;
      } catch {
        setDiskMessage('Checkpoint could not be recorded; rewind is unavailable for this turn.');
        return null;
      } finally { machineStarting.current--; }
    },
    [workspace]
  );

  const inspectMachineCheckpoint = useCallback(async (id: string) => {
    const desktop = getDesktopBridge();
    const nativeId = desktopWorkspaceIdRef.current;
    if (!desktop || !nativeId) return;
    const report = await desktop.inspectMachineTurn(nativeId, id).catch(() => null);
    if (desktopWorkspaceIdRef.current === nativeId) {
      setCheckpoints((previous) => previous.map((entry) => entry.id === id ? { ...entry, machineReport: report } : entry));
    }
  }, []);

  const exportDeltaReceipt = useCallback(async (id: string): Promise<string> => {
    const checkpoint = checkpoints.find((entry) => entry.id === id);
    if (!checkpoint?.machine) return 'This checkpoint is not a machine turn; only Machine Delta receipts can be exported.';
    const desktop = getDesktopBridge();
    const nativeId = desktopWorkspaceIdRef.current;
    if (!desktop || !nativeId) return 'Machine receipts need the desktop workspace that captured this turn; it is not open.';
    try {
      const exported = await desktop.exportMachineReceipt(nativeId, id);
      const verdict = await desktop.verifyMachineReceipt(nativeId, exported.receiptId);
      return `${verdict.message} Written to ${exported.filePath}${exported.partial ? ' (partial capture — see omissions).' : ''}`;
    } catch (error) {
      return error instanceof Error ? error.message : 'Delta receipt export failed.';
    }
  }, [checkpoints]);

  const finishMachineCheckpoint = useCallback(async (id: string | null) => {
    if (!id) return;
    // Buffer-only turns have no native snapshot to finish, but they still hold
    // the idle gate open until this runs — clear it for every checkpoint id.
    openTurns.current.delete(id);
    const nativeId = machineTurns.current.get(id);
    const desktop = getDesktopBridge();
    if (!desktop || !nativeId) return;
    try {
      await desktop.finishMachineTurn(nativeId, id);
    } catch {
      setDiskMessage('End snapshot failed; this turn cannot be rewound.');
    } finally {
      machineTurns.current.delete(id);
      await inspectMachineCheckpoint(id);
    }
  }, [inspectMachineCheckpoint]);

  /**
   * Restores one checkpoint. A machine checkpoint rewinds through the native
   * delta only — it never silently degrades into the buffer rollback below.
   * `ok` means the captured state was restored; `partial` means it was restored
   * but some steps (e.g. stopping owned previews) did not complete. Legacy
   * checkpoints stay buffer-only; the user saves to disk deliberately.
   */
  const restoreCheckpoint = useCallback(
    async (id: string): Promise<{ ok: boolean; partial: boolean }> => {
      const failure = { ok: false, partial: false };
      const checkpoint = checkpoints.find((entry) => entry.id === id);
      if (checkpoint?.machine) {
        const desktop = getDesktopBridge();
        const nativeId = desktopWorkspaceIdRef.current;
        if (!desktop || !nativeId) {
          setDiskMessage('Machine rewind needs the desktop workspace that captured this turn; it is not open, so nothing was restored.');
          return failure;
        }
        if (filesRef.current.some((file) => baselineRef.current[file.name] !== file.content)) {
          setDiskMessage('Save or discard unsaved editor changes before machine rewind.');
          return failure;
        }
        try {
          const result = await desktop.restoreMachineTurn(nativeId, id);
          if (desktopWorkspaceIdRef.current !== nativeId) return failure;
          // The native response separates "files restored" (report state) from
          // "every step succeeded" (ok). Say partial when the disk contents came
          // back but e.g. a preview could not be stopped — never plain success.
          const restoredState = result.report.state === 'restored';
          setDiskMessage(
            result.ok
              ? result.message
              : restoredState
                ? `Partial rewind — the captured files were restored, but not every step finished: ${result.message}`
                : result.message
          );
          if (restoredState) {
            for (const change of result.report.files) {
              if (change.beforeHash === null) {
                const buffered = filesRef.current.find((file) => file.name === change.path);
                if (buffered && buffered.content !== baselineRef.current[change.path]) {
                  setConflicts((previous) => [...new Set([...previous, change.path])]);
                  continue;
                }
                filesRef.current = filesRef.current.filter((file) => file.name !== change.path);
                delete baselineRef.current[change.path];
                setEditorGroups((previous) => previous.map((group) => ({ ...group,
                  tabs: group.tabs.filter((name) => name !== change.path), pinnedTabs: group.pinnedTabs.filter((name) => name !== change.path),
                  activePath: group.activePath === change.path ? null : group.activePath
                })));
              } else if (filesRef.current.some((file) => file.name === change.path)) {
                await refreshDiskFile(change.path);
              }
            }
            setWorkspace((previous) => previous ? { ...previous, files: [...filesRef.current] } : previous);
            setDiskBaseline({ ...baselineRef.current });
            for (const directory of new Set(['', ...result.report.files.map((file) => file.path.split('/').slice(0, -1).join('/'))])) {
              await loadDirectory(directory);
            }
          }
          await inspectMachineCheckpoint(id);
          return restoredState ? { ok: true, partial: !result.ok } : failure;
        } catch (error) {
          setDiskMessage(error instanceof Error ? error.message : 'Machine rewind failed.');
          await inspectMachineCheckpoint(id);
          return failure;
        }
      }
      const restored = await loadCheckpointFiles(id);
      if (!restored || restored.length === 0) return failure;

      const activeName = filesRef.current[activeFileIndex]?.name;
      setWorkspace((previous) =>
        previous ? { ...previous, files: restored } : previous
      );
      const nextIndex = restored.findIndex((file) => file.name === activeName);
      setSelectedFileIndex(nextIndex);
      setDiskMessage('Legacy checkpoint restored in the editor buffers only — nothing was written to disk. Click "Save to disk" to persist the files.');
      return { ok: true, partial: false };
    },
    [activeFileIndex, checkpoints, refreshDiskFile, loadDirectory, inspectMachineCheckpoint]
  );

  const previewCheckpointDiff = useCallback(async (id: string): Promise<CheckpointDiff | null> => {
    const stored = await loadCheckpointFiles(id);
    return stored ? diffToCheckpoint(filesRef.current, stored) : null;
  }, []);

  /**
   * Restores a checkpoint and persists it. Files the run created after the
   * checkpoint are reported rather than silently left behind, because the
   * bridge has no delete primitive; every pre-existing file is restored.
   */
  const rollbackToCheckpoint = useCallback(
    async (id: string): Promise<boolean> => {
      // A machine checkpoint owns an on-disk delta; restoring from the stored
      // buffer copy would silently destroy exactly what the native rewind is
      // meant to reverse. Refuse and point the caller at the timeline instead.
      if (checkpoints.some((entry) => entry.id === id && entry.machine)) {
        setDiskMessage('This checkpoint captured machine state — rewind it from the timeline instead; the buffer rollback was not run.');
        return false;
      }
      const restored = await loadCheckpointFiles(id);
      if (!restored) return false;
      const created = await loadCheckpointCreatedPaths(id);

      const before = filesRef.current;
      const restoredNames = new Set(restored.map((file) => file.name));
      const inBuffersOnly = before
        .map((file) => file.name)
        .filter((name) => !restoredNames.has(name) && !created.includes(name));
      const activeName = before[activeFileIndex]?.name;

      filesRef.current = restored;
      setWorkspace((previous) => (previous ? { ...previous, files: restored } : previous));
      setSelectedFileIndex(restored.findIndex((file) => file.name === activeName));

      const desktop = getDesktopBridge();
      const workspaceId = desktopWorkspaceIdRef.current;
      const leftBehind: string[] = [];
      if (desktop && workspaceId && created.length > 0) {
        for (const path of created) {
          try {
            await desktop.deletePath(workspaceId, path);
          } catch {
            leftBehind.push(path);
          }
        }
      }

      const outcome = restored.length > 0
        ? await saveFilesAtomic(restored.map((file) => file.name))
        : { written: 0, failed: false, message: null };
      const notes = [
        leftBehind.length > 0
          ? ` ${leftBehind.length} file${leftBehind.length === 1 ? '' : 's'} created during the run could not be deleted: ${leftBehind.slice(0, 5).join(', ')}.`
          : created.length > 0
            ? ` ${created.length} file${created.length === 1 ? '' : 's'} created during the run were removed.`
            : '',
        inBuffersOnly.length > 0
          ? ` ${inBuffersOnly.length} unsaved buffer${inBuffersOnly.length === 1 ? '' : 's'} not in the checkpoint were discarded.`
          : ''
      ].join('');
      setDiskMessage(
        outcome.failed
          ? `Rollback could not write every restored file to disk.${notes}`
          : `Restored to the pre-run checkpoint.${notes}`
      );
      return !outcome.failed;
    },
    [activeFileIndex, saveFilesAtomic, checkpoints]
  );

  // Keep the local snapshot in step with the live workspace so "Recently opened"
  // can restore it directly instead of asking the user to pick the folder again.
  useEffect(() => {
    if (!workspace) return;
    const timer = window.setTimeout(() => {
      void saveSnapshot({
        path: workspace.path,
        name: workspace.name,
        kind: workspace.id.startsWith('folder-') ? 'folder' : 'file',
        files: workspace.files
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  // Auto-save is opt-in: it can only write when a permission grant already
  // exists, so it is off by default and never prompts on its own.
  const dirtyKey = dirtyFiles.join('\n');
  useEffect(() => {
    if (!autoSave || !dirtyKey) return;
    const timer = window.setTimeout(() => {
      void saveAll();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirtyKey, saveAll]);

  // Once a workspace falls out of the recent list, its stored data is dead weight.
  useEffect(() => {
    const keep = recents.map((entry) => entry.path);
    void pruneSnapshots(keep);
    void pruneHandles(keep);
  }, [recents]);

  return useMemo(
    () => ({
      directoryPages,
      loadingDirectories,
      loadDirectory,
      openFile,
      closeTab,
      editorGroups,
      activeEditorGroup,
      splitEditor,
      focusEditorGroup,
      closeEditorGroup,
      reorderEditorTabs,
      togglePinnedTab,
      conflicts,
      resolveConflict,
      pendingProposal,
      stageFilePatches,
      applyProposal,
      discardProposal,
      changeRevision,
      workspace,
      files,
      allFiles,
      activeFile,
      activeFileIndex,
      assets,
      recents,
      isBusy,
      statusMessage,
      openFolder,
      openFiles,
      openDropped,
      openRecent,
      removeRecent,
      selectFile,
      closeFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      renameFile,
      createDirectory,
      deleteWorkspaceEntry,
      loadFilesForPatching,
      noteCheckpointCreated,
      revertActiveFile,
      closeWorkspace,
      canWriteToDisk,
      dirtyFiles,
      isSaving,
      diskMessage,
      autoSave,
      setAutoSave,
      saveAll,
      saveFiles: saveFilesToDisk,
      saveFilesAtomic,
      checkpoints,
      markCheckpoint,
      finishMachineCheckpoint,
      inspectMachineCheckpoint,
      exportDeltaReceipt,
      restoreCheckpoint,
      previewCheckpointDiff,
      rollbackToCheckpoint
    }),
    [
      directoryPages,
      loadingDirectories,
      loadDirectory,
      openFile,
      closeTab,
      editorGroups,
      activeEditorGroup,
      splitEditor,
      focusEditorGroup,
      closeEditorGroup,
      reorderEditorTabs,
      togglePinnedTab,
      conflicts,
      resolveConflict,
      pendingProposal,
      stageFilePatches,
      applyProposal,
      discardProposal,
      changeRevision,
      workspace,
      files,
      allFiles,
      activeFile,
      activeFileIndex,
      assets,
      recents,
      isBusy,
      statusMessage,
      openFolder,
      openFiles,
      openDropped,
      openRecent,
      removeRecent,
      selectFile,
      closeFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      renameFile,
      createDirectory,
      deleteWorkspaceEntry,
      loadFilesForPatching,
      noteCheckpointCreated,
      revertActiveFile,
      closeWorkspace,
      canWriteToDisk,
      dirtyFiles,
      isSaving,
      diskMessage,
      autoSave,
      saveAll,
      saveFilesToDisk,
      saveFilesAtomic,
      checkpoints,
      markCheckpoint,
      finishMachineCheckpoint,
      inspectMachineCheckpoint,
      exportDeltaReceipt,
      restoreCheckpoint,
      previewCheckpointDiff,
      rollbackToCheckpoint
    ]
  );
}
