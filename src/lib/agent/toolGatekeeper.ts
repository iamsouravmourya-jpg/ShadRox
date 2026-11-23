/**
 * Dynamic Context-Aware Tool Gatekeeper.
 *
 * Filters tool schemas and system-prompt tool descriptions per turn based on
 * live workspace, debugger, preview, background-job, terminal, and checkpoint
 * state so inactive tools never waste prompt tokens or confuse small models.
 */

export interface DebuggerToolContext {
  isRunning: boolean;
  isPaused: boolean;
}

export interface WorkspaceToolContext {
  workspaceOpen: boolean;
  filePaths: readonly string[];
  debuggerState: DebuggerToolContext;
  previewActive: boolean;
  activeJobCount: number;
  terminalAwaitingInput: boolean;
  hasActiveTerminal?: boolean;
  checkpointCount: number;
  /** True when the turn is read-only (Ask/Plan mode or read_only milestone); hides verify. */
  isReadOnlyTurn?: boolean;
  /** False when zero files were modified on disk this turn; gates off verify in favor of problems. */
  hasMutatedFiles?: boolean;
  /** Optional list of paths modified so far this turn; an empty array [] gates off verify. */
  touchedFiles?: readonly string[];
  /** True when this turn is editing multiple files; gates apply_patch on. */
  hasMultiFileEdit?: boolean;
  /** True when a git repo is present; gates git_state on. */
  hasGitRepo?: boolean;
  /** True when web access is configured; gates web_search/fetch_url on. */
  webAvailable?: boolean;
}

/**
 * Always-available baseline tools across every active workspace turn.
 * Core set: read, search, edit, write, delete, problems, plan, finish.
 * Everything else is gated behind context so small models aren't drowned
 * in schemas they can't use.
 */
export const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_directory',
  'read_file',
  'find_files',
  'search_text',
  'outline',
  'edit_file',
  'write_file',
  'delete_file',
  'problems',
  'run_command',
  'update_tasks',
  'finish'
]);

/** Debugger inspection/stepping tools that require a paused debug session. */
export const PAUSED_DEBUG_TOOL_NAMES: ReadonlySet<string> = new Set([
  'debugger_state',
  'debug_get_call_stack',
  'debug_inspect_variables',
  'debug_evaluate_expression',
  'debug_step_execution'
]);

const DEBUGGABLE_EXT_RE = /\.(?:[cm]?[jt]sx?|py)$/i;
const PREVIEWABLE_FILE_RE = /(?:^|\/)(?:package\.json|index\.html|vite\.config\.[^/]+|next\.config\.[^/]+|src\/[^/]+\.(?:tsx|jsx|ts|js|html))$/i;

export function hasDebuggableScriptFiles(filePaths: readonly string[]): boolean {
  return filePaths.some((file) => DEBUGGABLE_EXT_RE.test(file));
}

export function hasPreviewableFiles(filePaths: readonly string[]): boolean {
  return filePaths.some((file) => PREVIEWABLE_FILE_RE.test(file.replace(/\\/g, '/')));
}

export function isToolEnabledInContext(toolName: string, state: WorkspaceToolContext): boolean {
  if (toolName === 'update_tasks' || toolName === 'finish') return true;
  if (!state.workspaceOpen) {
    return toolName === 'web_search' || toolName === 'fetch_url';
  }

  if (toolName === 'verify') {
    if (state.isReadOnlyTurn === true) return false;
    if (state.hasMutatedFiles === false) return false;
    if (state.touchedFiles !== undefined && state.touchedFiles.length === 0) return false;
    return true;
  }

  if (ALWAYS_ON_TOOL_NAMES.has(toolName)) return true;

  // apply_patch is for coordinated multi-file edits only — keeps the surface
  // small so small models don't reach for it instead of edit_file.
  if (toolName === 'apply_patch') {
    return state.hasMultiFileEdit === true;
  }

  if (toolName === 'git_state') {
    return state.hasGitRepo === true;
  }

  if (toolName === 'web_search' || toolName === 'fetch_url') {
    return state.webAvailable === true;
  }

  if (toolName === 'debug_set_breakpoint') {
    return hasDebuggableScriptFiles(state.filePaths);
  }

  if (PAUSED_DEBUG_TOOL_NAMES.has(toolName)) {
    return state.debuggerState.isPaused === true;
  }

  if (toolName === 'preview_inspect') {
    return state.previewActive === true;
  }

  if (toolName === 'preview_control') {
    return state.previewActive || hasPreviewableFiles(state.filePaths);
  }

  if (toolName === 'job_control') {
    return state.activeJobCount > 0;
  }

  if (toolName === 'terminal_state' || toolName === 'terminal_answer') {
    return state.terminalAwaitingInput || state.hasActiveTerminal === true;
  }

  if (toolName === 'checkpoint') {
    return state.workspaceOpen;
  }

  if (toolName === 'list_checkpoints' || toolName === 'restore') {
    return state.checkpointCount > 0;
  }

  // Allow any uncategorized or custom extension tools to pass unless gated above.
  return true;
}

export function resolveActiveTools<T extends { name: string }>(
  state: WorkspaceToolContext,
  allTools: readonly T[]
): T[] {
  return allTools.filter((tool) => isToolEnabledInContext(tool.name, state));
}

export function buildWorkspaceToolContext(options: {
  workspaceOpen: boolean;
  filePaths?: readonly string[];
  debugStatus?: string;
  previewStatus?: string;
  activeJobCount?: number;
  terminalAwaitingInput?: boolean;
  hasActiveTerminal?: boolean;
  checkpointCount?: number;
  isReadOnlyTurn?: boolean;
  hasMutatedFiles?: boolean;
  touchedFiles?: readonly string[];
  hasMultiFileEdit?: boolean;
  hasGitRepo?: boolean;
  webAvailable?: boolean;
}): WorkspaceToolContext {
  const status = options.debugStatus ?? 'idle';
  const preview = options.previewStatus ?? 'idle';
  return {
    workspaceOpen: options.workspaceOpen,
    filePaths: options.filePaths ?? [],
    debuggerState: {
      isRunning: status === 'running' || status === 'stopped' || status === 'starting',
      isPaused: status === 'stopped'
    },
    previewActive: preview === 'ready' || preview === 'starting',
    activeJobCount: Math.max(0, options.activeJobCount ?? 0),
    terminalAwaitingInput: Boolean(options.terminalAwaitingInput),
    hasActiveTerminal: Boolean(options.hasActiveTerminal),
    checkpointCount: Math.max(0, options.checkpointCount ?? 0),
    ...(options.isReadOnlyTurn !== undefined ? { isReadOnlyTurn: options.isReadOnlyTurn } : {}),
    ...(options.hasMutatedFiles !== undefined ? { hasMutatedFiles: options.hasMutatedFiles } : {}),
    ...(options.touchedFiles !== undefined ? { touchedFiles: options.touchedFiles } : {}),
    ...(options.hasMultiFileEdit !== undefined ? { hasMultiFileEdit: options.hasMultiFileEdit } : {}),
    ...(options.hasGitRepo !== undefined ? { hasGitRepo: options.hasGitRepo } : {}),
    ...(options.webAvailable !== undefined ? { webAvailable: options.webAvailable } : {})
  };
}
