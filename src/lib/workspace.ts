import { detectLanguage, shouldSkipDirectory, shouldSkipFile } from './languages';
import type { WorkspaceFile } from './types';

/**
 * A live File System Access handle tied to a workspace-relative path.
 *
 * These are what make real write-back possible: reading a folder gives us a
 * handle per file, and that handle is the only way to change the file on disk.
 */
export interface HandleEntry {
  path: string;
  handle: any;
}

export interface MountedDirectory {
  name: string;
  files: WorkspaceFile[];
  handles: HandleEntry[];
  /** Folder mounts keep the directory handle so new files can be created on disk. */
  directoryHandle?: any;
}

export interface PickedFiles {
  files: WorkspaceFile[];
  handles: HandleEntry[];
}

const MAX_FILES = 400;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in (window as any);
}

export function supportsFilePicker(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in (window as any);
}

/** True when this browser can write edits back to the user's real files. */
export function supportsDiskWrite(): boolean {
  return supportsDirectoryPicker() || supportsFilePicker();
}

interface DirectoryScan {
  files: WorkspaceFile[];
  handles: HandleEntry[];
}

async function readDirectoryRecursive(
  handle: any,
  prefix = '',
  bucket: DirectoryScan = { files: [], handles: [] }
): Promise<DirectoryScan> {
  for await (const entry of handle.values()) {
    if (bucket.files.length >= MAX_FILES) break;

    if (entry.kind === 'file') {
      if (shouldSkipFile(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const content = await file.text();
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        bucket.files.push({ name: path, content, language: detectLanguage(entry.name) });
        bucket.handles.push({ path, handle: entry });
      } catch (error) {
        console.warn(`[devora] could not read ${entry.name}`, error);
      }
    } else if (entry.kind === 'directory' && !shouldSkipDirectory(entry.name)) {
      await readDirectoryRecursive(entry, prefix ? `${prefix}/${entry.name}` : entry.name, bucket);
    }
  }
  return bucket;
}

/** Opens the native folder picker. Returns null when the user cancels. */
export async function pickDirectory(): Promise<MountedDirectory | null> {
  if (!supportsDirectoryPicker()) return null;
  // Asking for readwrite up front means later saves need one fewer prompt.
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  const scan = await readDirectoryRecursive(handle);
  return { name: handle.name, files: scan.files, handles: scan.handles, directoryHandle: handle };
}

/** Opens the native multi-file picker. Returns null when the user cancels. */
export async function pickFiles(): Promise<PickedFiles | null> {
  if (!supportsFilePicker()) return null;
  const handles: any[] = await (window as any).showOpenFilePicker({
    multiple: true,
    types: [
      {
        description: 'Code & text files',
        accept: {
          'text/*': ['.ts', '.tsx', '.js', '.jsx', '.py', '.html', '.md', '.json', '.css', '.sql', '.yml', '.yaml', '.sh']
        }
      }
    ]
  });

  const files: WorkspaceFile[] = [];
  const entries: HandleEntry[] = [];
  for (const handle of handles || []) {
    const file = await handle.getFile();
    files.push({ name: file.name, content: await file.text(), language: detectLanguage(file.name) });
    entries.push({ path: file.name, handle });
  }
  return { files, handles: entries };
}

/**
 * Files that came in through drag-and-drop expose no handle at all, so they
 * stay read-only in the editor — a browser rule, not a Devora limitation.
 */
export async function filesFromFileList(list: FileList | null): Promise<WorkspaceFile[]> {
  if (!list || list.length === 0) return [];
  return Promise.all(
    Array.from(list)
      .filter((file) => !shouldSkipFile(file.name))
      .map(async (file) => ({
        name: file.name,
        content: await file.text(),
        language: detectLanguage(file.name)
      }))
  );
}

export async function filesFromDataTransfer(transfer: DataTransfer): Promise<WorkspaceFile[]> {
  return filesFromFileList(transfer.files);
}
