import { readAssetFile, type AssetMap } from './assets';
import { detectLanguage, isPreviewAsset, shouldSkipDirectory, shouldSkipFile } from './languages';
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
  /** Binary files (images, fonts, media) as data URLs, keyed by workspace path. */
  assets: AssetMap;
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

interface DirectoryScan {
  files: WorkspaceFile[];
  handles: HandleEntry[];
  assets: AssetMap;
}

async function readDirectoryRecursive(
  handle: any,
  prefix = '',
  bucket: DirectoryScan = { files: [], handles: [], assets: {} }
): Promise<DirectoryScan> {
  for await (const entry of handle.values()) {
    if (bucket.files.length >= MAX_FILES) break;

    if (entry.kind === 'file') {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Images, fonts and media never reach the editor, but the preview needs
      // them: they are read once into a data URL instead of being dropped.
      if (!entry.name.startsWith('.') && isPreviewAsset(entry.name)) {
        try {
          const asset = await readAssetFile(await entry.getFile(), path);
          if (asset) {
            bucket.assets[asset.path] = asset.dataUrl;
            bucket.handles.push({ path, handle: entry });
          }
        } catch (error) {
          console.warn(`[shadrox] could not read asset ${entry.name}`, error);
        }
        continue;
      }

      if (shouldSkipFile(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const content = await file.text();
        bucket.files.push({ name: path, content, language: detectLanguage(entry.name) });
        bucket.handles.push({ path, handle: entry });
      } catch (error) {
        console.warn(`[shadrox] could not read ${entry.name}`, error);
      }
    } else if (entry.kind === 'directory' && !shouldSkipDirectory(entry.name)) {
      await readDirectoryRecursive(entry, prefix ? `${prefix}/${entry.name}` : entry.name, bucket);
    }
  }
  return bucket;
}

/**
 * Re-reads remembered asset handles so a workspace reopened from the recent
 * list previews its images again. Missing permission simply yields no assets.
 */
export async function hydrateAssets(handles: HandleEntry[]): Promise<AssetMap> {
  const assets: AssetMap = {};
  await Promise.all(
    handles.map(async (entry) => {
      if (!isPreviewAsset(entry.path)) return;
      try {
        const asset = await readAssetFile(await entry.handle.getFile(), entry.path);
        if (asset) assets[asset.path] = asset.dataUrl;
      } catch {
        // Read permission was not re-granted; the preview falls back to no assets.
      }
    })
  );
  return assets;
}

/** Opens the native folder picker. Returns null when the user cancels. */
export async function pickDirectory(): Promise<MountedDirectory | null> {
  if (!supportsDirectoryPicker()) return null;
  // Asking for readwrite up front means later saves need one fewer prompt.
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  const scan = await readDirectoryRecursive(handle);
  return {
    name: handle.name,
    files: scan.files,
    handles: scan.handles,
    assets: scan.assets,
    directoryHandle: handle
  };
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
 * stay read-only in the editor — a browser rule, not a ShadRox limitation.
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
