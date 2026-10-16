import { detectLanguage, shouldSkipDirectory, shouldSkipFile } from './languages';
import type { WorkspaceFile } from './types';

export interface MountedDirectory {
  name: string;
  files: WorkspaceFile[];
}

const MAX_FILES = 400;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in (window as any);
}

export function supportsFilePicker(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in (window as any);
}

async function readDirectoryRecursive(handle: any, prefix = '', bucket: WorkspaceFile[] = []): Promise<WorkspaceFile[]> {
  for await (const entry of handle.values()) {
    if (bucket.length >= MAX_FILES) break;

    if (entry.kind === 'file') {
      if (shouldSkipFile(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const content = await file.text();
        bucket.push({
          name: prefix ? `${prefix}/${entry.name}` : entry.name,
          content,
          language: detectLanguage(entry.name)
        });
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
  const handle = await (window as any).showDirectoryPicker();
  const files = await readDirectoryRecursive(handle);
  return { name: handle.name, files };
}

/** Opens the native multi-file picker. Returns null when the user cancels. */
export async function pickFiles(): Promise<WorkspaceFile[] | null> {
  if (!supportsFilePicker()) return null;
  const handles = await (window as any).showOpenFilePicker({
    multiple: true,
    types: [{ description: 'Code & text files', accept: { 'text/*': ['.ts', '.tsx', '.js', '.jsx', '.py', '.html', '.md', '.json', '.css', '.sql', '.yml', '.yaml', '.sh'] } }]
  });

  const files: WorkspaceFile[] = [];
  for (const handle of handles || []) {
    const file = await handle.getFile();
    files.push({
      name: file.name,
      content: await file.text(),
      language: detectLanguage(file.name)
    });
  }
  return files;
}

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
