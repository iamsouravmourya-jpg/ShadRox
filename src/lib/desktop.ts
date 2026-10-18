import type { AssetMap } from './assets';
import type { WorkspaceFile } from './types';

export interface DesktopWorkspace {
  workspaceId: string;
  name: string;
  kind: 'folder' | 'file';
  files: Array<Pick<WorkspaceFile, 'name' | 'content'>>;
  assets: AssetMap;
  warnings: string[];
}

export interface DesktopSaveResult {
  saved: string[];
  errors: Array<{ name: string; message: string }>;
}

export interface DesktopCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShadRoxDesktopAPI {
  openFolder: () => Promise<DesktopWorkspace | null>;
  openFiles: () => Promise<DesktopWorkspace | null>;
  saveFiles: (workspaceId: string, files: Array<Pick<WorkspaceFile, 'name' | 'content'>>) => Promise<DesktopSaveResult>;
  runCommand: (workspaceId: string, command: string) => Promise<DesktopCommandResult>;
}

declare global {
  interface Window {
    shadroxDesktop?: ShadRoxDesktopAPI;
  }
}

export function getDesktopBridge(): ShadRoxDesktopAPI | null {
  return typeof window === 'undefined' ? null : window.shadroxDesktop ?? null;
}
