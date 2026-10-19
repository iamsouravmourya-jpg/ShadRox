import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetMap } from '../lib/assets';
import { detectLanguage } from '../lib/languages';
import type { FilePatch } from '../lib/markdown';
import { loadHandles, pruneHandles, saveHandles } from '../lib/fileHandles';
import { listCheckpoints, loadCheckpointFiles, saveCheckpoint, type CheckpointMeta } from '../lib/history';
import { getSnapshot, pruneSnapshots, saveSnapshot } from '../lib/snapshots';
import { getRecentWorkspaces, pushRecentWorkspace } from '../lib/storage';
import { getDesktopBridge, type DirectoryPage, type StagedTransaction, type WorkspaceChange } from '../lib/desktop';
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

export interface PatchProposal extends StagedTransaction {
  workspaceId: string;
  base: WorkspaceFile[];
}

interface UseWorkspaceResult {
  directoryPages: Record<string, DirectoryPage>;
  loadingDirectories: string[];
  loadDirectory: (path: string, cursor?: number) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (index: number) => void;
  conflicts: string[];
  resolveConflict: (name: string, action: 'reload' | 'keep') => Promise<void>;
  pendingProposal: PatchProposal | null;
  stageFilePatches: (patches: FilePatch[], base: WorkspaceFile[], workspaceId: string) => Promise<void>;
  applyProposal: () => Promise<void>;
  discardProposal: () => Promise<void>;
  changeRevision: number;
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

async function contentVersion(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
        files: nextFiles
      });
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
        if (getDesktopBridge()) {
          setStatusMessage(`Select ${entry.name} again to read its current files and restore disk access.`);
          if (entry.kind === 'folder') await openFolder();
          else await openFiles();
          return;
        }
        const snapshot = await getSnapshot(entry.path);
        if (snapshot && snapshot.files.length > 0) {
          // Handles live in their own store, so a reopened workspace can still
          // write to disk once the browser re-grants permission — and its
          // images can be read back into the preview.
          const handles = await loadHandles(entry.path);
          mount(snapshot.name, snapshot.path, snapshot.kind, snapshot.files, {
            handles,
            assets: await hydrateAssets(handles)
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

  const openFile = useCallback(async (name: string) => {
    const desktop = getDesktopBridge();
    const id = desktopWorkspaceIdRef.current;
    if (!desktop || !id) return;
    const request = ++fileRequest.current;
    const existing = filesRef.current.findIndex((file) => file.name === name);
    if (existing >= 0) { setActiveFileIndex(existing); return; }
    try {
      const loaded = await desktop.readFile(id, name);
      if (desktopWorkspaceIdRef.current !== id) return;
      const next = [...filesRef.current.filter((file) => file.name !== name), { ...loaded, language: detectLanguage(name) }];
      while (next.length > 48) {
        const removable = next.findIndex((file) => file.name !== name && file.content === baselineRef.current[file.name] && !conflictRef.current.includes(file.name));
        if (removable < 0) break;
        next.splice(removable, 1);
      }
      filesRef.current = next;
      baselineRef.current = { ...baselineRef.current, [name]: loaded.content };
      setDiskBaseline(baselineRef.current);
      setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
      if (request === fileRequest.current) setActiveFileIndex(next.findIndex((file) => file.name === name));
    } catch (error) {
      if (desktopWorkspaceIdRef.current === id) setStatusMessage(`Could not open ${name}: ${String(error)}`);
    }
  }, []);

  const closeTab = useCallback((index: number) => {
    const current = filesRef.current;
    const file = current[index];
    if (!file) return;
    if (file.content !== baselineRef.current[file.name] && !window.confirm(`Discard unsaved changes in ${file.name}?`)) return;
    const next = current.filter((_, i) => i !== index);
    filesRef.current = next;
    setWorkspace((previous) => previous ? { ...previous, files: next } : previous);
    setActiveFileIndex((active) => active === index ? Math.min(index, next.length - 1) : active > index ? active - 1 : active);
    setConflicts((previous) => previous.filter((name) => name !== file.name));
  }, []);

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
      setActiveFileIndex(-1);
      setConflicts((previous) => previous.filter((path) => path !== name));
      deletedPaths.current.delete(name);
      return;
    }
    await refreshDiskFile(name, action);
  }, [refreshDiskFile]);

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
      for (const file of filesRef.current) {
        const change = [...changes].reverse().find((entry) => entry.path === file.name || (entry.kind === 'unlinkDir' && file.name.startsWith(`${entry.path}/`)));
        if (change) {
          if (change.kind === 'unlink' || change.kind === 'unlinkDir') {
            deletedPaths.current.add(file.name);
            setConflicts((previous) => [...new Set([...previous, file.name])]);
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
  }, [workspace?.nativeWorkspaceId, loadDirectory, refreshDiskFile]);

  const selectFile = useCallback((index: number) => { fileRequest.current += 1; setActiveFileIndex(index); }, []);

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
      setActiveFileIndex(next.findIndex((file) => file.name === result.updated[0] || file.name === result.created[0]));
    }
    return result;
  }, [workspace]);

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
      if (!canWriteRef.current || names.length === 0 || savingRef.current) return;
      if (names.some((name) => conflictRef.current.includes(name))) {
        setDiskMessage('Resolve external file changes before saving. No files were written.');
        return;
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
          if (desktopWorkspaceIdRef.current !== nativeWorkspaceId) return;
          const savedFiles = new Set(result.saved);
          written = result.saved.length;
          failed = result.errors.length > 0;
          if (savedFiles.size > 0) {
            const saved = snapshot.filter((file) => savedFiles.has(file.name));
            const versions = new Map(await Promise.all(saved.map(async (file) => [file.name, await contentVersion(file.content)] as const)));
            if (desktopWorkspaceIdRef.current !== nativeWorkspaceId) return;
            baselineRef.current = { ...baselineRef.current, ...Object.fromEntries(saved.map((file) => [file.name, file.content])) };
            setDiskBaseline(baselineRef.current);
            setWorkspace((previous) => previous ? { ...previous, files: previous.files.map((file) => versions.has(file.name) ? { ...file, version: versions.get(file.name) } : file) } : previous);
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
        savingRef.current = false;
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
      setActiveFileIndex(next.findIndex((file) => file.name === proposal.files[0]?.name));
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
        kind: previous?.kind ?? 'file',
        nativeWorkspaceId: previous?.nativeWorkspaceId,
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
    const desktop = getDesktopBridge();
    const currentId = desktopWorkspaceIdRef.current;
    if (desktop && currentId) void desktop.closeWorkspace(currentId);
    setWorkspace(null);
    setActiveFileIndex(-1);
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
      directoryPages,
      loadingDirectories,
      loadDirectory,
      openFile,
      closeTab,
      conflicts,
      resolveConflict,
      pendingProposal,
      stageFilePatches,
      applyProposal,
      discardProposal,
      changeRevision,
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
      directoryPages,
      loadingDirectories,
      loadDirectory,
      openFile,
      closeTab,
      conflicts,
      resolveConflict,
      pendingProposal,
      stageFilePatches,
      applyProposal,
      discardProposal,
      changeRevision,
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
