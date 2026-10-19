import type { AssetMap } from './assets';
import type { WorkspaceFile } from './types';

export interface DesktopWorkspace {
  workspaceId: string;
  name: string;
  kind: 'folder' | 'file';
  files: Array<{ name: string; content: string; version?: string }>;
  assets: AssetMap;
  warnings: string[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export interface DirectoryPage {
  entries: DirectoryEntry[];
  nextCursor: number | null;
}

export interface WorkspaceChange {
  workspaceId: string;
  changes: Array<{ path: string; kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' }>;
}

export interface DesktopWrite {
  name: string;
  content: string;
  expectedVersion?: string | null;
}

export interface StagedTransaction {
  transactionId: string;
  files: Array<{ name: string; before: string | null; after: string }>;
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

export interface TerminalOutput {
  workspaceId: string;
  sessionId: string;
  type: 'data' | 'exit';
  data?: string;
  exitCode?: number;
}

export interface DesktopPreviewOutput {
  workspaceId: string;
  type: 'install' | 'status' | 'stdout' | 'stderr' | 'console' | 'ready' | 'stopped' | 'error';
  message: string;
  level?: 'log' | 'warn' | 'error';
  timestamp?: number;
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

export interface NodePreviewProjectCandidate {
  kind: 'node';
  projectPath: string;
  manifestHash: string;
  packageManager: string;
  scriptName: string;
  scriptCommand: string;
  missingDependencies: string[];
}

export interface StaticPreviewProjectCandidate {
  kind: 'static';
  projectPath: string;
}

export type PreviewProjectCandidate = NodePreviewProjectCandidate | StaticPreviewProjectCandidate;

export type DesktopPreviewStartResult =
  | { status: 'ready'; url: string; script: string }
  | { status: 'approval-required'; approval: PreviewApprovalRequest }
  | { status: 'selection-required'; projects: PreviewProjectCandidate[] };

export type DesktopPreviewState =
  | { status: 'idle'; url: null }
  | { status: 'starting'; url: null }
  | { status: 'ready'; url: string }
  | { status: 'error'; url: null; message: string };

export interface ShadRoxDesktopAPI {
  openFolder: () => Promise<DesktopWorkspace | null>;
  openFiles: () => Promise<DesktopWorkspace | null>;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  listDirectory: (workspaceId: string, path?: string, cursor?: number) => Promise<DirectoryPage>;
  readFile: (workspaceId: string, path: string) => Promise<{ name: string; content: string; version: string }>;
  onWorkspaceChange: (listener: (event: WorkspaceChange) => void) => () => void;
  saveFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<DesktopSaveResult>;
  stageFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<StagedTransaction>;
  commitTransaction: (workspaceId: string, transactionId: string) => Promise<DesktopSaveResult>;
  discardTransaction: (workspaceId: string, transactionId: string) => Promise<void>;
  runCommand: (workspaceId: string, command: string) => Promise<DesktopCommandResult>;
  createTerminal: (workspaceId: string, cols?: number, rows?: number) => Promise<{ sessionId: string; title: string }>;
  writeTerminal: (workspaceId: string, sessionId: string, data: string) => Promise<void>;
  resizeTerminal: (workspaceId: string, sessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (workspaceId: string, sessionId: string) => Promise<void>;
  onTerminalOutput: (listener: (event: TerminalOutput) => void) => () => void;
  startPreview: (workspaceId: string, approval?: { manifestHash?: string; approved?: boolean; projectPath?: string; projectKind?: 'node' | 'static' }) => Promise<DesktopPreviewStartResult>;
  stopPreview: (workspaceId: string) => Promise<boolean>;
  onPreviewOutput: (listener: (output: DesktopPreviewOutput) => void) => () => void;
}

declare global {
  interface Window { shadroxDesktop?: ShadRoxDesktopAPI }
}

export function getDesktopBridge(): ShadRoxDesktopAPI | null {
  return typeof window === 'undefined' ? null : window.shadroxDesktop ?? null;
}
