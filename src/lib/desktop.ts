import type { AssetMap } from './assets';
import type { WorkspaceFile } from './types';

export interface DesktopWorkspace {
  workspaceId: string;
  /** Absolute filesystem location, safe to persist for one-click reopen. */
  rootPath: string;
  /** Absolute paths of the individual files opened in single-file mode. */
  filePaths?: string[];
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

export interface WorkspaceSearchHit {
  name: string;
  line: number;
  column: number;
  preview: string;
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

/** Read-only snapshot of the workspace's git state, from the main process. */
export interface GitReadResult {
  isRepo: boolean;
  status: string;
  diff: string;
  log: string;
  dirty: number;
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
  | { status: 'ready'; url: string; script: string; hmr?: boolean }
  | { status: 'approval-required'; approval: PreviewApprovalRequest }
  | { status: 'selection-required'; projects: PreviewProjectCandidate[] };

export type DesktopPreviewState =
  | { status: 'idle'; url: null }
  | { status: 'starting'; url: null }
  | { status: 'ready'; url: string; /** `static` previews reload on file changes; `dev` servers may use their own HMR. */ mode?: 'dev' | 'static'; hmr?: boolean }
  | { status: 'error'; url: null; message: string };

export type UpdaterStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'up-to-date' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface DesktopAuthResult {
  params?: Record<string, string>;
  error?: string;
}

export interface ShadRoxDesktopAPI {
  platform: string;
  openFolder: () => Promise<DesktopWorkspace | null>;
  openFiles: () => Promise<DesktopWorkspace | null>;
  reopenWorkspace: (target: { kind: 'folder' | 'file'; path: string; filePaths?: string[] }) => Promise<DesktopWorkspace | null>;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  listDirectory: (workspaceId: string, path?: string, cursor?: number) => Promise<DirectoryPage>;
  readFile: (workspaceId: string, path: string) => Promise<{ name: string; content: string; version: string }>;
  renameFile: (workspaceId: string, fromPath: string, toPath: string) => Promise<{ name: string; content: string | null; version: string | null }>;
  searchFiles: (workspaceId: string, query: string, limit?: number) => Promise<WorkspaceSearchHit[]>;
  setDirty: (dirty: boolean) => Promise<void>;
  onWorkspaceChange: (listener: (event: WorkspaceChange) => void) => () => void;
  saveFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<DesktopSaveResult>;
  stageFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<StagedTransaction>;
  commitTransaction: (workspaceId: string, transactionId: string) => Promise<DesktopSaveResult>;
  discardTransaction: (workspaceId: string, transactionId: string) => Promise<void>;
  runCommand: (workspaceId: string, command: string) => Promise<DesktopCommandResult>;
  /** Read-only git status/diff/log for AI commit messages. */
  gitRead: (workspaceId: string) => Promise<GitReadResult>;
  createTerminal: (workspaceId: string, cols?: number, rows?: number) => Promise<{ sessionId: string; title: string }>;
  writeTerminal: (workspaceId: string, sessionId: string, data: string) => Promise<void>;
  resizeTerminal: (workspaceId: string, sessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (workspaceId: string, sessionId: string) => Promise<void>;
  onTerminalOutput: (listener: (event: TerminalOutput) => void) => () => void;
  startPreview: (workspaceId: string, approval?: { manifestHash?: string; approved?: boolean; projectPath?: string; projectKind?: 'node' | 'static' }) => Promise<DesktopPreviewStartResult>;
  stopPreview: (workspaceId: string) => Promise<boolean>;
  onPreviewOutput: (listener: (output: DesktopPreviewOutput) => void) => () => void;
  /** Runs an update check; `{ available: false }` in dev and on unsupported platforms. */
  checkForUpdates: () => Promise<{ available: boolean }>;
  onUpdaterStatus: (listener: (status: UpdaterStatus) => void) => () => void;
  secureStore: {
    getAll: () => Promise<Record<string, string>>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  auth: {
    /** Opens the system browser and resolves with the loopback callback's query params. */
    startLoopback: (authorizeUrl: string, redirectUri: string) => Promise<DesktopAuthResult>;
    appVersion: () => Promise<string>;
  };
}

declare global {
  interface Window { shadroxDesktop?: ShadRoxDesktopAPI }
}

export function getDesktopBridge(): ShadRoxDesktopAPI | null {
  return typeof window === 'undefined' ? null : window.shadroxDesktop ?? null;
}
