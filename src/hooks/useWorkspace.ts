import { useCallback, useEffect, useMemo, useState } from 'react';
import { detectLanguage } from '../lib/languages';
import type { FilePatch } from '../lib/markdown';
import { getSnapshot, pruneSnapshots, saveSnapshot } from '../lib/snapshots';
import { getRecentWorkspaces, pushRecentWorkspace } from '../lib/storage';
import {
  filesFromFileList,
  pickDirectory,
  pickFiles,
  supportsDirectoryPicker,
  supportsFilePicker
} from '../lib/workspace';
import type { RecentEntry, WorkspaceFile, WorkspaceFolder } from '../lib/types';

/** What happened to each file the assistant tried to write. */
export interface ApplyPatchesResult {
  updated: string[];
  created: string[];
  unchanged: string[];
}

interface UseWorkspaceResult {
  workspace: WorkspaceFolder | null;
  files: WorkspaceFile[];
  activeFile: WorkspaceFile | null;
  activeFileIndex: number;
  recents: RecentEntry[];
  isBusy: boolean;
  statusMessage: string | null;
  openFolder: () => Promise<void>;
  openFiles: () => Promise<void>;
  openDropped: (list: FileList) => Promise<void>;
  /** Reopens a remembered workspace straight from its local snapshot. */
  openRecent: (entry: RecentEntry) => Promise<void>;
  selectFile: (index: number) => void;
  updateActiveContent: (content: string) => void;
  applyFilePatches: (patches: FilePatch[]) => ApplyPatchesResult;
  createFile: (name: string) => void;
  deleteFile: (index: number) => void;
  closeWorkspace: () => void;
}

const EMPTY_FILES: WorkspaceFile[] = [];

export function useWorkspace(): UseWorkspaceResult {
  const [workspace, setWorkspace] = useState<WorkspaceFolder | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>(() => getRecentWorkspaces());
  const [isBusy, setIsBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const files = workspace?.files ?? EMPTY_FILES;
  const activeFile = files[activeFileIndex] ?? null;

  const mount = useCallback((name: string, path: string, kind: 'folder' | 'file', nextFiles: WorkspaceFile[]) => {
    setWorkspace({ id: `${kind}-${path}`, name, path, files: nextFiles });
    setActiveFileIndex(0);
    setStatusMessage(null);
    setRecents(pushRecentWorkspace({ name, path, fileCount: nextFiles.length, kind }));
    // Capture the picked content right away so leaving before the debounced
    // save fires still leaves a snapshot behind.
    void saveSnapshot({ path, name, kind, files: nextFiles });
  }, []);

  const openFolder = useCallback(async () => {
    if (!supportsDirectoryPicker()) {
      setStatusMessage('Is browser me folder picker support nahi hai. Chrome ya Edge use karo, ya folder drag karke daalo.');
      return;
    }
    setIsBusy(true);
    try {
      const directory = await pickDirectory();
      if (!directory) return;
      if (directory.files.length === 0) {
        setStatusMessage('Us folder me koi readable code file nahi mili.');
        return;
      }
      mount(directory.name, directory.name, 'folder', directory.files);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setStatusMessage('Folder open nahi ho paya. Dobara try karo.');
    } finally {
      setIsBusy(false);
    }
  }, [mount]);

  const openFiles = useCallback(async () => {
    if (!supportsFilePicker()) {
      setStatusMessage('File picker support nahi hai. Files ko drag karke daalo.');
      return;
    }
    setIsBusy(true);
    try {
      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;
      mount(
        picked.length === 1 ? picked[0].name : `${picked.length} files`,
        `files:${picked.map((file) => file.name).sort().join('|')}`,
        'file',
        picked
      );
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setStatusMessage('Files open nahi ho payin. Dobara try karo.');
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
          setStatusMessage('In files me se koi readable file nahi mili.');
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
          mount(snapshot.name, snapshot.path, snapshot.kind, snapshot.files);
          return;
        }
        // Entries saved before snapshots existed can only be restored by picking again.
        setStatusMessage(
          `${entry.name} ka local copy save nahi tha — ek baar dobara pick karo, uske baad ye seedha khulega.`
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

  const createFile = useCallback((name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    setWorkspace((previous) => {
      const nextFiles = previous?.files ?? [];
      if (nextFiles.some((file) => file.name === cleanName)) return previous;
      const created: WorkspaceFile = { name: cleanName, content: '', language: detectLanguage(cleanName) };
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
      setActiveFileIndex((current) => Math.max(0, Math.min(current, nextFiles.length - 1)));
      return { ...previous, files: nextFiles };
    });
  }, []);

  const closeWorkspace = useCallback(() => {
    setWorkspace(null);
    setActiveFileIndex(0);
    setStatusMessage(null);
  }, []);

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

  // Once a workspace falls out of the recent list, its snapshot is dead weight.
  useEffect(() => {
    void pruneSnapshots(recents.map((entry) => entry.path));
  }, [recents]);

  return useMemo(
    () => ({
      workspace,
      files,
      activeFile,
      activeFileIndex,
      recents,
      isBusy,
      statusMessage,
      openFolder,
      openFiles,
      openDropped,
      openRecent,
      selectFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      closeWorkspace
    }),
    [
      workspace,
      files,
      activeFile,
      activeFileIndex,
      recents,
      isBusy,
      statusMessage,
      openFolder,
      openFiles,
      openDropped,
      openRecent,
      selectFile,
      updateActiveContent,
      applyFilePatches,
      createFile,
      deleteFile,
      closeWorkspace
    ]
  );
}
