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
}

/**
 * Always-available baseline tools across every active workspace turn.
 * Matches exact registered names in `TOOL_DEFINITIONS`.
 */
export const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_directory',
  'read_file',
  'find_files',
  'search_text',
  'outline',
  'edit_file',
  'apply_patch',
  'write_file',
  'delete_file',
  'problems',
  'verify',
  'git_state',
  'run_command',
  'memory_read',
  'memory_note',
  'semantic_search',
  'find_references',
  'go_to_definition',
  'rename_symbol',
  'diff_review',
  'ask_user',
  'spawn_subagent',
  'web_search',
  'fetch_url',
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

  if (ALWAYS_ON_TOOL_NAMES.has(toolName)) return true;

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
    checkpointCount: Math.max(0, options.checkpointCount ?? 0)
  };
}
