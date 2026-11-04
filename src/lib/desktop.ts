import type { AssetMap } from './assets';
import type { WorkspaceFile, WorkspaceFileEntry } from './types';

export interface DesktopWorkspace {
  workspaceId: string;
  /** Absolute filesystem location, safe to persist for one-click reopen. */
  rootPath: string;
  /** Absolute paths of the individual files opened in single-file mode. */
  filePaths?: string[];
  name: string;
  kind: 'folder' | 'file';
  files: Array<{ name: string; content: string; version?: string }>;
  /** Explorer-visible file count for folder workspaces (capped at 5000). */
  fileCount?: number;
  fileCountTruncated?: boolean;
  /** Paths + sizes for every explorer-visible file; contents are not read. */
  fileTree?: WorkspaceFileEntry[];
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

export interface ContentSearchOptions {
  query: string;
  /** Glob or substring patterns matched against workspace-relative paths. */
  include?: string | string[];
  regex?: boolean;
  /** Match file paths instead of file contents. */
  namesOnly?: boolean;
  limit?: number;
}

export interface ContentSearchResult {
  matches: Array<{ path: string; line: number; column: number; preview: string }>;
  truncated: boolean;
  filesScanned: number;
  error: string | null;
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
  /** A partially written transaction was restored to its pre-commit contents. */
  rolledBack?: boolean;
  rollbackErrors?: Array<{ name: string; message: string }>;
}

export interface VerifyChangeFile {
  path: string;
  content: string;
}

export interface VerifyChangeIssue {
  path: string;
  /** 0-based, matching editor diagnostics. */
  line: number;
  character: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface VerifyChangeResult {
  ok: boolean;
  checked: number;
  issues: VerifyChangeIssue[];
  skipped: string[];
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

export interface GitChange {
  status: string;
  path: string;
  oldPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  lastCommit: string;
  message: string;
}

export interface GitScmResult {
  branch: string;
  changes: GitChange[];
  branches: GitBranch[];
}

/** One open editor buffer, sent with every language-service request. `path` is workspace-relative. */
export interface TsFileOverride {
  path: string;
  content: string;
}

/** 0-based line/character positions, matching CodeMirror. `file` is absolute. */
export interface DesktopDiagnostic {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface DiagnosticsResult {
  diagnostics: DesktopDiagnostic[];
  truncated: boolean;
  projectFiles: number;
  configPath: string | null;
}

export interface DefinitionLocation {
  file: string;
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface ReferenceLocation {
  file: string;
  isDefinition: boolean;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface OutlineSymbol {
  name: string;
  kind: string;
  depth: number;
  line: number;
  character: number;
}

export interface WorkspaceSymbol {
  file: string;
  name: string;
  kind: string;
  container: string;
  line: number;
  character: number;
}

/**
 * One textual replacement, absolute-path keyed, produced by a rename or a code
 * action. Positions are 0-based line/character pairs so the renderer can apply
 * them to a CodeMirror document without converting offsets.
 */
export interface WorkspaceTextEdit {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

/**
 * `edits` is empty when `canRename` is false, so a caller can apply the whole
 * list without checking the flag again; `reason` carries the service's message.
 */
export interface RenameResult {
  canRename: boolean;
  reason: string | null;
  displayName: string;
  edits: WorkspaceTextEdit[];
}

export interface CodeAction {
  /** Stable fix identifier, e.g. `fixConvertConstToLet`; used as the React key. */
  name: string;
  description: string;
  changes: WorkspaceTextEdit[];
}

export interface SemanticToken {
  type: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

/**
 * `system` is the user's own shell with the full environment. `agent` is the
 * shell the assistant drives; the desktop scrubs credential variables from it.
 */
export type TerminalMode = 'agent' | 'system';

export interface TerminalSessionInfo {
  sessionId: string;
  mode: TerminalMode;
  /** Human-readable shell name chosen by the desktop, e.g. `PowerShell`. */
  label: string;
  title: string;
  cwd: string;
}

/**
 * Emitted for every byte of shell output, tagged with the session key the
 * renderer passed to `createTerminal` (or the desktop's own id for a caller that
 * passed none).
 */
export interface TerminalOutput {
  workspaceId: string;
  sessionId: string;
  type: 'data' | 'exit';
  data?: string;
  exitCode?: number;
}

/** A one-shot command the app ran for the assistant, a plugin or an automation. */
export interface TerminalRun {
  workspaceId: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
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
  | { status: 'ready'; url: string; script: string; hmr?: boolean; port?: number }
  | { status: 'approval-required'; approval: PreviewApprovalRequest }
  | { status: 'selection-required'; projects: PreviewProjectCandidate[] };

export type DesktopPreviewState =
  | { status: 'idle'; url: null }
  | { status: 'starting'; url: null }
  | { status: 'ready'; url: string; /** `static` previews reload on file changes; `dev` servers may use their own HMR. */ mode?: 'dev' | 'static'; hmr?: boolean }
  | { status: 'error'; url: null; message: string };

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpToolInfo {
  serverId: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  content: unknown;
}

/** One data-only runtime adapter plan, produced in main from the workspace manifests. */
export interface RuntimePreviewPlan {
  kind: 'frontend' | 'backend';
  adapter: string;
  command: string | null;
  args: string[];
  cwd: string;
  port: number;
  healthPath: string;
  entry: string;
}

export interface AutomationWebhookStatus {
  running: boolean;
  port: number | null;
  error: string | null;
}

export interface AutomationTriggerEvent {
  automationId: string;
  receivedAt: number;
  payload: unknown;
}

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
  /** Batch read used before patching: files a folder owns but no tab has opened yet. */
  loadFiles: (
    workspaceId: string,
    paths: string[],
    options?: { maxBytesPerFile?: number; maxTotalBytes?: number }
  ) => Promise<{ files: Array<{ name: string; content: string; version: string }>; missing: Array<{ path: string; reason: string }> }>;
  /** Rule and skill documents the explorer hides (`.shadrox/**`, `AGENTS.md`, `.cursorrules`). */
  projectDocs: (workspaceId: string) => Promise<Array<{ path: string; size: number }>>;
  renameFile: (workspaceId: string, fromPath: string, toPath: string) => Promise<{ name: string; content: string | null; version: string | null }>;
  /** Explorer "New Folder"; refuses dot-names and generated directories. */
  createDirectory: (workspaceId: string, path: string) => Promise<{ path: string }>;
  /** Unlinks one file, or removes an empty folder. Non-empty folders are refused. */
  deletePath: (workspaceId: string, path: string) => Promise<{ path: string; kind: 'file' | 'directory' }>;
  searchFiles: (workspaceId: string, query: string, limit?: number) => Promise<WorkspaceSearchHit[]>;
  searchContent: (workspaceId: string, options: ContentSearchOptions) => Promise<ContentSearchResult>;
  setDirty: (dirty: boolean) => Promise<void>;
  onWorkspaceChange: (listener: (event: WorkspaceChange) => void) => () => void;
  saveFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<DesktopSaveResult>;
  stageFiles: (workspaceId: string, files: DesktopWrite[]) => Promise<StagedTransaction>;
  commitTransaction: (workspaceId: string, transactionId: string) => Promise<DesktopSaveResult>;
  discardTransaction: (workspaceId: string, transactionId: string) => Promise<void>;
  /** Static pre-apply check of proposed file contents (syntax, JSON, markup). */
  verifyChangeSet: (workspaceId: string, files: VerifyChangeFile[]) => Promise<VerifyChangeResult>;
  runCommand: (workspaceId: string, command: string) => Promise<DesktopCommandResult>;
  /** Read-only git status/diff/log for AI commit messages. */
  gitRead: (workspaceId: string) => Promise<GitReadResult>;
  /** Unmerged index paths, read-only, for the conflict banner. */
  gitConflicts: (workspaceId: string) => Promise<{ isRepo: boolean; paths: string[] }>;
  gitScmRead: (workspaceId: string) => Promise<GitScmResult>;
  gitStage: (workspaceId: string, paths: string[]) => Promise<boolean>;
  gitUnstage: (workspaceId: string, paths: string[]) => Promise<boolean>;
  gitCommit: (workspaceId: string, message: string) => Promise<boolean>;
  gitBranches: (workspaceId: string) => Promise<GitBranch[]>;
  gitCheckout: (workspaceId: string, branch: string) => Promise<boolean>;
  gitFileDiff: (workspaceId: string, path: string, staged: boolean) => Promise<string>;
  /**
   * TypeScript project diagnostics. Pass `files` (workspace-relative) to check
   * only the files being edited; omit it to scan the whole project.
   */
  diagnostics: (workspaceId: string, overrides?: TsFileOverride[], files?: string[]) => Promise<DiagnosticsResult>;
  /** Definitions at a 0-based position in a workspace-relative file. */
  definition: (
    workspaceId: string,
    path: string,
    line: number,
    character: number,
    overrides?: TsFileOverride[]
  ) => Promise<DefinitionLocation[]>;
  references: (
    workspaceId: string,
    path: string,
    line: number,
    character: number,
    overrides?: TsFileOverride[]
  ) => Promise<ReferenceLocation[]>;
  /** Renames a symbol and every reference the language service can reach. */
  rename: (
    workspaceId: string,
    path: string,
    line: number,
    character: number,
    newName: string,
    overrides?: TsFileOverride[]
  ) => Promise<RenameResult>;
  /** Quick fixes for the diagnostics that overlap a 0-based selection range. */
  codeActions: (
    workspaceId: string,
    path: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    overrides?: TsFileOverride[]
  ) => Promise<CodeAction[]>;
  /** Semantic classification for one file; empty for non-TypeScript files. */
  semanticTokens: (
    workspaceId: string,
    path: string,
    overrides?: TsFileOverride[]
  ) => Promise<SemanticToken[]>;
  /** Document outline for one file, in document order. */
  outline: (workspaceId: string, path: string, overrides?: TsFileOverride[]) => Promise<OutlineSymbol[]>;
  /** Project-wide symbol search for the quick-open `#` mode. */
  workspaceSymbols: (
    workspaceId: string,
    query: string,
    overrides?: TsFileOverride[]
  ) => Promise<WorkspaceSymbol[]>;
  /**
   * `sessionKey` is the renderer's terminal tab id. Passing it lets one workspace
   * hold several shells and makes a re-mount reattach instead of re-spawning; a
   * second create with the same key returns the shell that already exists.
   */
  createTerminal: (
    workspaceId: string,
    cols?: number,
    rows?: number,
    mode?: TerminalMode,
    sessionKey?: string
  ) => Promise<TerminalSessionInfo>;
  writeTerminal: (workspaceId: string, sessionId: string, data: string) => Promise<void>;
  resizeTerminal: (workspaceId: string, sessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (workspaceId: string, sessionId: string) => Promise<void>;
  /** Shells the desktop still holds for this workspace, for the tab strip. */
  listTerminalSessions: (workspaceId: string) => Promise<TerminalSessionInfo[]>;
  /** One command the app ran, echoed so the terminal dock can show the transcript. */
  onTerminalRun: (listener: (event: TerminalRun) => void) => () => void;
  /** Opens a link printed in the terminal in the system browser; refuses non-http(s). */
  openTerminalLink: (url: string) => Promise<boolean>;
  onTerminalOutput: (listener: (event: TerminalOutput) => void) => () => void;
  startPreview: (workspaceId: string, approval?: { manifestHash?: string; approved?: boolean; projectPath?: string; projectKind?: 'node' | 'static' }) => Promise<DesktopPreviewStartResult>;
  stopPreview: (workspaceId: string) => Promise<boolean>;
  onPreviewOutput: (listener: (output: DesktopPreviewOutput) => void) => () => void;
  listMcpServers: () => Promise<McpServerConfig[]>;
  saveMcpServer: (server: McpServerConfig) => Promise<McpServerConfig[]>;
  deleteMcpServer: (id: string) => Promise<McpServerConfig[]>;
  connectMcpServer: (id: string) => Promise<McpToolInfo[]>;
  listMcpTools: (serverId: string) => Promise<McpToolInfo[]>;
  callMcpTool: (serverId: string, name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  disconnectMcpServer: (id: string) => Promise<boolean>;
  scanPlugins: (workspaceId: string) => Promise<{ files: Array<{ path: string; content: string }>; errors: string[] }>;
  detectRuntimes: (workspaceId: string) => Promise<{ plans: RuntimePreviewPlan[]; errors: string[] }>;
  startBackendPreview: (workspaceId: string, port?: number) => Promise<DesktopPreviewStartResult>;
  stopBackendPreview: (workspaceId: string) => Promise<boolean>;
  onBackendPreviewOutput: (listener: (output: DesktopPreviewOutput) => void) => () => void;
  automationWebhookStatus: (workspaceId: string) => Promise<AutomationWebhookStatus>;
  startAutomationWebhook: (workspaceId: string) => Promise<AutomationWebhookStatus>;
  stopAutomationWebhook: () => Promise<void>;
  onAutomationTrigger: (listener: (event: AutomationTriggerEvent) => void) => () => void;
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
