import type { ToolBundleCategory, TurnIntentKind } from './runPolicy';

/**
 * Dynamic Context-Aware Tool Gatekeeper.
 *
 * Filters tool schemas and system-prompt tool descriptions per turn based on
 * autonomous turn intent (conversational / advisory / execution), intent-triggered
 * bundles, runtime state, and on-demand `unlock_tools` discovery.
 */

export interface WorkspaceToolContext {
  workspaceOpen: boolean;
  filePaths: readonly string[];
  previewActive: boolean;
  activeJobCount: number;
  terminalAwaitingInput: boolean;
  hasActiveTerminal?: boolean;
  checkpointCount: number;
  /** Autonomous turn intent when routed by classifyTurnIntent. */
  turnIntent?: TurnIntentKind;
  /** Tier-2 bundles enabled at turn start from prompt keywords / active state. */
  enabledBundles?: ReadonlySet<string>;
  /** Tier-3 bundles unlocked mid-turn via `unlock_tools`. */
  unlockedBundles?: ReadonlySet<string>;
  /** True when the turn is read-only (Advisory / Plan / Ask); hides mutating tools & verify. */
  isReadOnlyTurn?: boolean;
  /** False when zero files were modified on disk this turn; gates off verify in favor of problems. */
  hasMutatedFiles?: boolean;
  /** Optional list of paths modified so far this turn; an empty array [] gates off verify. */
  touchedFiles?: readonly string[];
  /** True when this turn is editing multiple files; gates apply_patch on. */
  hasMultiFileEdit?: boolean;
  /** True when a git repo is present; gates git_state on in legacy mode. */
  hasGitRepo?: boolean;
  /** True when web access is configured; gates web_search/fetch_url on. */
  webAvailable?: boolean;
}

/**
 * Legacy always-available baseline tools preserved for callers/tests that build
 * WorkspaceToolContext without `turnIntent` or `enabledBundles`.
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

/** Core Tier-1 execution tools sent on normal coding turns (~10-12 tools). */
export const TIER1_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_directory',
  'read_file',
  'find_files',
  'search_text',
  'outline',
  'edit_file',
  'write_file',
  'problems',
  'run_command',
  'update_tasks',
  'finish',
  'unlock_tools'
]);

/** Read-only tools allowed during `'advisory'` turns (explain/plan/explore). */
export const ADVISORY_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'list_directory',
  'read_file',
  'find_files',
  'search_text',
  'outline',
  'problems',
  'finish',
  'unlock_tools'
]);

export const TOOL_CATEGORY_MAP: Record<ToolBundleCategory, readonly string[]> = {
  core: [...TIER1_CORE_TOOL_NAMES, 'verify'],
  apply_patch: ['apply_patch'],
  preview: ['preview_control', 'preview_inspect'],
  git: ['git_state'],
  checkpoints: ['checkpoint', 'list_checkpoints', 'restore'],
  delete: ['delete_file'],
  web: ['web_search', 'fetch_url'],
  memory: ['memory_read', 'memory_note'],
  code_intel: ['semantic_search', 'find_references', 'go_to_definition', 'rename_symbol', 'outline'],
  review: ['diff_review'],
  jobs: ['job_control'],
  terminal: ['terminal_state', 'terminal_answer'],
  interaction: ['ask_user', 'spawn_subagent'],
  mcp: []
};

const MUTATING_OR_EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'run_command',
  'verify',
  'restore',
  'preview_control',
  'terminal_answer',
  'memory_note',
  'rename_symbol',
  'update_tasks'
]);

export function listToolBundleCatalog(): Array<{ category: ToolBundleCategory; tools: readonly string[]; summary: string }> {
  return [
    { category: 'apply_patch', tools: TOOL_CATEGORY_MAP.apply_patch, summary: 'Atomic multi-file patch transactions' },
    { category: 'preview', tools: TOOL_CATEGORY_MAP.preview, summary: 'Start/restart/inspect embedded browser preview (DOM, console, screenshot)' },
    { category: 'git', tools: TOOL_CATEGORY_MAP.git, summary: 'Git working-tree status and diff' },
    { category: 'checkpoints', tools: TOOL_CATEGORY_MAP.checkpoints, summary: 'Create, list, and restore workspace checkpoints' },
    { category: 'delete', tools: TOOL_CATEGORY_MAP.delete, summary: 'Approval-gated file or recursive folder deletion' },
    { category: 'web', tools: TOOL_CATEGORY_MAP.web, summary: 'Public web search and allowlisted documentation fetch' },
    { category: 'memory', tools: TOOL_CATEGORY_MAP.memory, summary: 'Read/append durable workspace project memory' },
    { category: 'code_intel', tools: TOOL_CATEGORY_MAP.code_intel, summary: 'Semantic search, TS/JS references, definitions, symbol rename' },
    { category: 'review', tools: TOOL_CATEGORY_MAP.review, summary: 'Pre-finish git diff review for secrets, TODOs, debug prints' },
    { category: 'jobs', tools: TOOL_CATEGORY_MAP.jobs, summary: 'List, read output, or stop background command jobs' },
    { category: 'terminal', tools: TOOL_CATEGORY_MAP.terminal, summary: 'Read interactive terminal state or submit approval-gated input' },
    { category: 'interaction', tools: TOOL_CATEGORY_MAP.interaction, summary: 'Ask structured user questions or spawn bounded helper subagent' },
    { category: 'mcp', tools: [], summary: 'Discover and invoke user-configured external MCP tools' }
  ];
}

const PREVIEWABLE_FILE_RE = /(?:^|\/)(?:package\.json|index\.html|vite\.config\.[^/]+|next\.config\.[^/]+|src\/[^/]+\.(?:tsx|jsx|ts|js|html))$/i;

export function hasPreviewableFiles(filePaths: readonly string[]): boolean {
  return filePaths.some((file) => PREVIEWABLE_FILE_RE.test(file.replace(/\\/g, '/')));
}

function isVerifyEligible(state: WorkspaceToolContext): boolean {
  if (state.isReadOnlyTurn === true) return false;
  if (state.hasMutatedFiles === false) return false;
  if (state.touchedFiles !== undefined && state.touchedFiles.length === 0) return false;
  return true;
}

function collectActiveBundles(state: WorkspaceToolContext): Set<string> {
  const active = new Set<string>(['core']);
  if (state.enabledBundles) {
    for (const bundle of state.enabledBundles) active.add(bundle);
  }
  if (state.unlockedBundles) {
    for (const bundle of state.unlockedBundles) active.add(bundle);
  }
  return active;
}

function isLegacyToolEnabled(toolName: string, state: WorkspaceToolContext): boolean {
  if (toolName === 'update_tasks' || toolName === 'finish') return true;
  if (!state.workspaceOpen) {
    return toolName === 'web_search' || toolName === 'fetch_url';
  }
  if (toolName === 'unlock_tools') return true;

  if (toolName === 'verify') return isVerifyEligible(state);
  if (ALWAYS_ON_TOOL_NAMES.has(toolName)) return true;
  if (toolName === 'apply_patch') return state.hasMultiFileEdit === true;
  if (toolName === 'git_state') return state.hasGitRepo === true;
  if (toolName === 'web_search' || toolName === 'fetch_url') return state.webAvailable === true;
  if (toolName === 'preview_inspect') return state.previewActive === true;
  if (toolName === 'preview_control') return state.previewActive || hasPreviewableFiles(state.filePaths);
  if (toolName === 'job_control') return state.activeJobCount > 0;
  if (toolName === 'terminal_state' || toolName === 'terminal_answer') {
    return state.terminalAwaitingInput || state.hasActiveTerminal === true;
  }
  if (toolName === 'checkpoint') return state.workspaceOpen;
  if (toolName === 'list_checkpoints' || toolName === 'restore') return state.checkpointCount > 0;
  return true;
}

export function isToolEnabledInContext(toolName: string, state: WorkspaceToolContext): boolean {
  // Conversational fast-path: zero tools attached.
  if (state.turnIntent === 'conversational') return false;

  // Backward-compatible path for unit tests / legacy callers without bundle routing.
  if (
    state.turnIntent === undefined &&
    state.enabledBundles === undefined &&
    state.unlockedBundles === undefined
  ) {
    return isLegacyToolEnabled(toolName, state);
  }

  const activeBundles = collectActiveBundles(state);

  if (!state.workspaceOpen) {
    if (toolName === 'finish') return true;
    if (toolName === 'update_tasks') return state.turnIntent !== 'advisory';
    if (toolName === 'web_search' || toolName === 'fetch_url') {
      return state.webAvailable !== false && activeBundles.has('web');
    }
    return false;
  }

  // Advisory turns are strictly read-only even if the model unlocks extra bundles.
  if (state.turnIntent === 'advisory') {
    if (MUTATING_OR_EXECUTE_TOOLS.has(toolName)) return false;
    if (ADVISORY_READ_ONLY_TOOLS.has(toolName)) return true;
    if (toolName === 'git_state') return activeBundles.has('git');
    if (toolName === 'list_checkpoints') return activeBundles.has('checkpoints') && state.checkpointCount > 0;
    if (toolName === 'memory_read') return activeBundles.has('memory');
    if (toolName === 'web_search' || toolName === 'fetch_url') {
      return activeBundles.has('web') && state.webAvailable !== false;
    }
    if (toolName === 'preview_inspect') return state.previewActive && activeBundles.has('preview');
    if (toolName === 'semantic_search' || toolName === 'find_references' || toolName === 'go_to_definition') {
      return activeBundles.has('code_intel');
    }
    if (toolName === 'diff_review') return activeBundles.has('review');
    if (toolName === 'job_control') return state.activeJobCount > 0 || activeBundles.has('jobs');
    if (toolName === 'terminal_state') return state.hasActiveTerminal === true || state.terminalAwaitingInput || activeBundles.has('terminal');
    if (toolName === 'ask_user' || toolName === 'spawn_subagent') return activeBundles.has('interaction');
    return false;
  }

  // Execution turn: Tier-1 core + dynamic state essentials + Tier-2/Tier-3 bundles.
  if (toolName === 'verify') return isVerifyEligible(state);
  if (TIER1_CORE_TOOL_NAMES.has(toolName)) return true;

  if (toolName === 'apply_patch') {
    return activeBundles.has('apply_patch');
  }
  if (toolName === 'preview_control') {
    return activeBundles.has('preview') || state.previewActive || hasPreviewableFiles(state.filePaths);
  }
  if (toolName === 'preview_inspect') {
    return state.previewActive || activeBundles.has('preview');
  }
  if (toolName === 'job_control') {
    return state.activeJobCount > 0 || activeBundles.has('jobs');
  }
  if (toolName === 'terminal_state' || toolName === 'terminal_answer') {
    return state.terminalAwaitingInput || activeBundles.has('terminal');
  }
  if (toolName === 'git_state') {
    return activeBundles.has('git');
  }
  if (toolName === 'checkpoint') {
    return activeBundles.has('checkpoints');
  }
  if (toolName === 'list_checkpoints' || toolName === 'restore') {
    return activeBundles.has('checkpoints') && state.checkpointCount > 0;
  }
  if (toolName === 'delete_file') {
    return activeBundles.has('delete');
  }
  if (toolName === 'web_search' || toolName === 'fetch_url') {
    return activeBundles.has('web') && state.webAvailable !== false;
  }
  if (toolName === 'memory_read' || toolName === 'memory_note') {
    return activeBundles.has('memory');
  }
  if (
    toolName === 'semantic_search' ||
    toolName === 'find_references' ||
    toolName === 'go_to_definition' ||
    toolName === 'rename_symbol'
  ) {
    return activeBundles.has('code_intel');
  }
  if (toolName === 'diff_review') {
    return activeBundles.has('review');
  }
  if (toolName === 'ask_user' || toolName === 'spawn_subagent') {
    return activeBundles.has('interaction');
  }

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
  previewStatus?: string;
  activeJobCount?: number;
  terminalAwaitingInput?: boolean;
  hasActiveTerminal?: boolean;
  checkpointCount?: number;
  turnIntent?: TurnIntentKind;
  enabledBundles?: ReadonlySet<string>;
  unlockedBundles?: ReadonlySet<string>;
  isReadOnlyTurn?: boolean;
  hasMutatedFiles?: boolean;
  touchedFiles?: readonly string[];
  hasMultiFileEdit?: boolean;
  hasGitRepo?: boolean;
  webAvailable?: boolean;
}): WorkspaceToolContext {
  const preview = options.previewStatus ?? 'idle';
  return {
    workspaceOpen: options.workspaceOpen,
    filePaths: options.filePaths ?? [],
    previewActive: preview === 'ready' || preview === 'starting',
    activeJobCount: Math.max(0, options.activeJobCount ?? 0),
    terminalAwaitingInput: Boolean(options.terminalAwaitingInput),
    hasActiveTerminal: Boolean(options.hasActiveTerminal),
    checkpointCount: Math.max(0, options.checkpointCount ?? 0),
    ...(options.turnIntent !== undefined ? { turnIntent: options.turnIntent } : {}),
    ...(options.enabledBundles !== undefined ? { enabledBundles: options.enabledBundles } : {}),
    ...(options.unlockedBundles !== undefined ? { unlockedBundles: options.unlockedBundles } : {}),
    ...(options.isReadOnlyTurn !== undefined ? { isReadOnlyTurn: options.isReadOnlyTurn } : {}),
    ...(options.hasMutatedFiles !== undefined ? { hasMutatedFiles: options.hasMutatedFiles } : {}),
    ...(options.touchedFiles !== undefined ? { touchedFiles: options.touchedFiles } : {}),
    ...(options.hasMultiFileEdit !== undefined ? { hasMultiFileEdit: options.hasMultiFileEdit } : {}),
    ...(options.hasGitRepo !== undefined ? { hasGitRepo: options.hasGitRepo } : {}),
    ...(options.webAvailable !== undefined ? { webAvailable: options.webAvailable } : {})
  };
}
