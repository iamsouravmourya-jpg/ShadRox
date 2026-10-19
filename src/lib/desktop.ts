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

export interface DesktopPreviewOutput {
  workspaceId: string;
  type: 'install' | 'status' | 'stdout' | 'stderr' | 'console' | 'ready' | 'stopped' | 'error';
  message: string;
}

export interface PreviewApprovalRequest {
  workspaceId: string;
  manifestHash: string;
  projectPath: string;
  packageManager: string;
  scriptName: string;
  scriptCommand: string;
  missingDependencies: string[];
}

export type DesktopPreviewStartResult =
  | { status: 'ready'; url: string; script: string }
  | { status: 'approval-required'; approval: PreviewApprovalRequest };

export type DesktopPreviewState =
  | { status: 'idle'; url: null }
  | { status: 'starting'; url: null }
  | { status: 'ready'; url: string }
  | { status: 'error'; url: null; message: string };

export interface ShadRoxDesktopAPI {
  openFolder: () => Promise<DesktopWorkspace | null>;
  openFiles: () => Promise<DesktopWorkspace | null>;
  saveFiles: (workspaceId: string, files: Array<Pick<WorkspaceFile, 'name' | 'content'>>) => Promise<DesktopSaveResult>;
  runCommand: (workspaceId: string, command: string) => Promise<DesktopCommandResult>;
  startPreview: (
    workspaceId: string,
    approval?: { manifestHash: string; approved: boolean }
  ) => Promise<DesktopPreviewStartResult>;
  stopPreview: (workspaceId: string) => Promise<boolean>;
  onPreviewOutput: (listener: (output: DesktopPreviewOutput) => void) => () => void;
}

declare global {
  interface Window {
    shadroxDesktop?: ShadRoxDesktopAPI;
  }
}

export function getDesktopBridge(): ShadRoxDesktopAPI | null {
  return typeof window === 'undefined' ? null : window.shadroxDesktop ?? null;
}
