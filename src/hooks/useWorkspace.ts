import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetMap } from '../lib/assets';
import { detectLanguage } from '../lib/languages';
import type { FilePatch } from '../lib/markdown';
import { loadHandles, pruneHandles, saveHandles } from '../lib/fileHandles';
import { listCheckpoints, loadCheckpointFiles, saveCheckpoint, type CheckpointMeta } from '../lib/history';
import { getSnapshot, pruneSnapshots, saveSnapshot } from '../lib/snapshots';
import { getRecentWorkspaces, pushRecentWorkspace } from '../lib/storage';
import { getDesktopBridge } from '../lib/desktop';
import {
  filesFromFileList,
  hydrateAssets,
  pickDirectory,
  pickFiles,
  supportsDirectoryPicker,
  supportsFilePicker,
  type HandleEntry
} from '../lib/workspace';
import type { RecentEntry, WorkspaceFile, WorkspaceFolder } from '../lib/types';

/** What happened to each file the assistant tried to write. */
export interface ApplyPatchesResult {
  updated: string[];
  created: string[];
  unchanged: string[];
}

interface MountOptions {
  handles?: HandleEntry[];
  directoryHandle?: unknown;
  nativeWorkspaceId?: string;
  /** Binary assets (images, fonts) served to the preview as data URLs. */
  assets?: AssetMap;
}

interface UseWorkspaceResult {
  workspace: WorkspaceFolder | null;
  files: WorkspaceFile[];
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
  selectFile: (index: number) => void;
  /** Leaves the editor and goes back to the file list. */
  closeFile: () => void;
  updateActiveContent: (content: string) => void;
  applyFilePatches: (patches: FilePatch[]) => ApplyPatchesResult;
  createFile: (name: string, content?: string) => void;
  deleteFile: (index: number) => void;
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

  // --- restore timeline ----------------------------------------------------
  checkpoints: CheckpointMeta[];
  /** Snapshots the current files so a later chat turn can be undone. */
  markCheckpoint: (messageId: string, label: string) => Promise<void>;
  restoreCheckpoint: (id: string) => Promise<boolean>;
}

const EMPTY_FILES: WorkspaceFile[] = [];

export function useWorkspace(): UseWorkspaceResult {
  const [workspace, setWorkspace] = useState<WorkspaceFolder | null>(null);
  // Nothing is selected on mount: the user sees the file list first and picks.
  const [activeFileIndex, setActiveFileIndex] = useState(-1);
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

  const files = workspace?.files ?? EMPTY_FILES;
  const activeFile = files[activeFileIndex] ?? null;

  const filesRef = useRef<WorkspaceFile[]>(files);
  const baselineRef = useRef<Record<string, string>>(diskBaseline);
  const handlesRef = useRef<Map<string, any>>(new Map());
  const directoryHandleRef = useRef<any>(null);
  const canWriteRef = useRef(false);
  const desktopWorkspaceIdRef = useRef<string | null>(null);
  const desktopWorkspaceIdsRef = useRef(new Map<string, string>());

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
      if (options.nativeWorkspaceId) desktopWorkspaceIdsRef.current.set(path, options.nativeWorkspaceId);
      setAssets(options.assets ?? {});
      const writable = handles.length > 0 || Boolean(options.directoryHandle) || Boolean(options.nativeWorkspaceId);
      canWriteRef.current = writable;
      setCanWriteToDisk(writable);

      // Everything just came off disk, so nothing is dirty yet.
      setDiskBaseline(Object.fromEntries(nextFiles.map((file) => [file.name, file.content])));
      setDiskMessage(writable ? null : 'Dropped files loaded as read-only. File System handles not provided by browser.');

      setWorkspace({ id: `${kind}-${path}`, name, path, files: nextFiles });
      setActiveFileIndex(-1);
      setStatusMessage(null);
      setRecents(pushRecentWorkspace({ name, path, fileCount: nextFiles.length, kind }));
      void saveSnapshot({ path, name, kind, files: nextFiles });
      if (handles.length > 0) void saveHandles(path, handles);
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
        if (opened.files.length === 0) {
          setStatusMessage('No readable code files found in the selected folder.');
          return;
        }
        mount(opened.name, opened.workspaceId, 'folder', opened.files.map((file) => ({
          ...file,
          language: detectLanguage(file.name)
        })), {
          assets: opened.assets,
          nativeWorkspaceId: opened.workspaceId
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
        mount(opened.name, opened.workspaceId, 'file', opened.files.map((file) => ({
          ...file,
          language: detectLanguage(file.name)
        })), {
          assets: opened.assets,
          nativeWorkspaceId: opened.workspaceId
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
        const snapshot = await getSnapshot(entry.path);
        if (snapshot && snapshot.files.length > 0) {
          const nativeWorkspaceId = desktopWorkspaceIdsRef.current.get(entry.path);
          if (getDesktopBridge() && !nativeWorkspaceId) {
            setStatusMessage(`Reopen ${entry.name} from its folder to restore native disk access.`);
            return;
          }
          // Handles live in their own store, so a reopened workspace can still
          // write to disk once the browser re-grants permission — and its
          // images can be read back into the preview.
          const handles = await loadHandles(entry.path);
          mount(snapshot.name, snapshot.path, snapshot.kind, snapshot.files, {
            handles,
            assets: await hydrateAssets(handles),
            nativeWorkspaceId
          });
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

  const selectFile = useCallback((index: number) => setActiveFileIndex(index), []);

  const closeFile = useCallback(() => setActiveFileIndex(-1), []);

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
   * `requestPermission` only works inside a user gesture, so this can succeed
   * from the Save button and fail silently from a debounced auto-save.
   */
  const ensureWritePermission = useCallback(async (handle: any): Promise<boolean> => {
    const descriptor = { mode: 'readwrite' as const };
    try {
      if (typeof handle.queryPermission === 'function' && (await handle.queryPermission(descriptor)) === 'granted') {
        return true;
      }
      if (typeof handle.requestPermission === 'function' && (await handle.requestPermission(descriptor)) === 'granted') {
        return true;
      }
    } catch (error) {
      console.warn('[shadrox] write permission check failed', error);
    }
    return false;
  }, []);

  const writeOne = useCallback(
    async (file: WorkspaceFile): Promise<boolean> => {
      const handle = await resolveHandle(file.name);
      if (!handle) return false;

      if (!(await ensureWritePermission(handle))) {
        setDiskMessage('Write permission denied by browser. Click "Save to disk" to grant write access.');
        return false;
      }

      const writable = await handle.createWritable();
      await writable.write(file.content);
      await writable.close();
      setDiskBaseline((previous) => ({ ...previous, [file.name]: file.content }));
      return true;
    },
    [resolveHandle, ensureWritePermission]
  );

  const saveFilesToDisk = useCallback(
    async (names: string[]): Promise<void> => {
      if (!canWriteRef.current || names.length === 0) return;

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
          const result = await desktop.saveFiles(nativeWorkspaceId, requested);
          const savedFiles = new Set(result.saved);
          written = result.saved.length;
          failed = result.errors.length > 0;
          if (savedFiles.size > 0) {
            setDiskBaseline((previous) => ({
              ...previous,
              ...Object.fromEntries(
                snapshot.filter((file) => savedFiles.has(file.name)).map((file) => [file.name, file.content])
              )
            }));
          }
          if (result.errors.length > 0) {
            setDiskMessage(
              `${written} file${written === 1 ? '' : 's'} saved. ${result.errors
                .map((error) => `${error.name || 'File'}: ${error.message}`)
                .join(' ')}`
            );
          } else if (written > 0) {
            setDiskMessage(`${written} file${written > 1 ? 's' : ''} saved to disk.`);
          }
          return;
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
        setDiskMessage(error instanceof Error ? `Save failed: ${error.message}` : 'Save failed.');
      } finally {
        setIsSaving(false);
      }
    },
    [writeOne]
  );

  const saveAll = useCallback(async () => {
    const baseline = baselineRef.current;
    await saveFilesToDisk(
      filesRef.current.filter((file) => baseline[file.name] !== file.content).map((file) => file.name)
    );
  }, [saveFilesToDisk]);

  // --- assistant edits -------------------------------------------------------

  /**
   * Writes assistant-authored file rewrites into the workspace.
   *
   * Only files that genuinely exist here are updated — a patch lands on the
   * exact name the model named, never on "some file". A path with no match
   * becomes a new file instead of overwriting anything.
   */
  const applyFilePatches = useCallback(
    (patches: FilePatch[]): ApplyPatchesResult => {
      const empty: ApplyPatchesResult = { updated: [], created: [], unchanged: [] };
      if (!workspace || patches.length === 0) return empty;

      const resolveIndex = (target: string): number => {
        const normalized = target.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
        const basename = normalized.split('/').pop() || normalized;

        const exact = workspace.files.findIndex((file) => file.name.toLowerCase() === normalized);
        if (exact !== -1) return exact;
        return workspace.files.findIndex((file) => file.name.toLowerCase() === basename);
      };

      const updated = new Set<string>();
      const created = new Set<string>();
      const unchanged = new Set<string>();
      const nextFiles = [...workspace.files];

      patches.forEach((patch) => {
        const index = resolveIndex(patch.path);

        if (index === -1) {
          const name = patch.path.replace(/\\/g, '/').split('/').pop() || patch.path;
          if (nextFiles.some((file) => file.name.toLowerCase() === name.toLowerCase())) {
            unchanged.add(name);
            return;
          }
          nextFiles.push({ name, content: patch.content, language: detectLanguage(name) });
          created.add(name);
          return;
        }

        if (nextFiles[index].content === patch.content) {
          unchanged.add(nextFiles[index].name);
          return;
        }

        nextFiles[index] = { ...nextFiles[index], content: patch.content };
        updated.add(nextFiles[index].name);
      });

      if (updated.size === 0 && created.size === 0) return empty;

      setWorkspace((previous) => (previous ? { ...previous, files: nextFiles } : previous));

      const focus = nextFiles.findIndex((file) => updated.has(file.name) || created.has(file.name));
      if (focus !== -1) setActiveFileIndex(focus);

      return { updated: [...updated], created: [...created], unchanged: [...unchanged] };
    },
    [workspace]
  );

  const createFile = useCallback((name: string, content = '') => {
    const cleanName = name.trim();
    if (!cleanName) return;
    setWorkspace((previous) => {
      const nextFiles = previous?.files ?? [];
      if (nextFiles.some((file) => file.name === cleanName)) return previous;
      const created: WorkspaceFile = { name: cleanName, content, language: detectLanguage(cleanName) };
      setActiveFileIndex(nextFiles.length);
      return {
        id: previous?.id ?? `file-${cleanName}`,
        name: previous?.name ?? cleanName,
        path: previous?.path ?? `file:${cleanName}`,
        files: [...nextFiles, created]
      };
    });
  }, []);

  const deleteFile = useCallback((index: number) => {
    setWorkspace((previous) => {
      if (!previous || previous.files.length <= 1) return previous;
      const nextFiles = previous.files.filter((_, fileIndex) => fileIndex !== index);
      // -1 means the user is on the file list — deleting must not force a file open.
      setActiveFileIndex((current) => (current === -1 ? -1 : Math.max(0, Math.min(current, nextFiles.length - 1))));
      return { ...previous, files: nextFiles };
    });
  }, []);

  const closeWorkspace = useCallback(() => {
    setWorkspace(null);
    setActiveFileIndex(-1);
    setAssets({});
    setStatusMessage(null);
    setDiskMessage(null);
    setCheckpoints([]);
    handlesRef.current = new Map();
    directoryHandleRef.current = null;
    desktopWorkspaceIdRef.current = null;
    canWriteRef.current = false;
    setCanWriteToDisk(false);
  }, []);

  // --- restore timeline ------------------------------------------------------

  const markCheckpoint = useCallback(
    async (messageId: string, label: string) => {
      const current = filesRef.current;
      if (!workspace || current.length === 0) return;
      const meta = await saveCheckpoint({
        workspacePath: workspace.path,
        messageId,
        label,
        files: current
      });
      if (meta) setCheckpoints((previous) => [meta, ...previous]);
    },
    [workspace]
  );

  const restoreCheckpoint = useCallback(
    async (id: string): Promise<boolean> => {
      const restored = await loadCheckpointFiles(id);
      if (!restored || restored.length === 0) return false;

      const activeName = filesRef.current[activeFileIndex]?.name;
      setWorkspace((previous) =>
        previous ? { ...previous, files: restored } : previous
      );
      const nextIndex = restored.findIndex((file) => file.name === activeName);
      setActiveFileIndex(nextIndex);
      setDiskMessage('Previous version restored. Click "Save to disk" to persist changes to disk.');
      return true;
    },
    [activeFileIndex]
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
      workspace,
      files,
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
      selectFile,
      closeFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      closeWorkspace,
      canWriteToDisk,
      dirtyFiles,
      isSaving,
      diskMessage,
      autoSave,
      setAutoSave,
      saveAll,
      checkpoints,
      markCheckpoint,
      restoreCheckpoint
    }),
    [
      workspace,
      files,
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
      selectFile,
      closeFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      closeWorkspace,
      canWriteToDisk,
      dirtyFiles,
      isSaving,
      diskMessage,
      autoSave,
      saveAll,
      checkpoints,
      markCheckpoint,
      restoreCheckpoint
    ]
  );
}
