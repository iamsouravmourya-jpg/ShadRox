/**
 * Local plugins: the vocabulary.
 *
 * A plugin is data, never code. `plugin.json` declares metadata and hooks, and
 * each hook points at exactly one action: a shell `command` the app replays
 * later through its existing approval-gated command path, or a chat `prompt`
 * the app sends later through the normal chat path. Nothing in this module set
 * evaluates plugin content, so the plugin system stays inside the same trust
 * boundary as the editor.
 */

export const PLUGIN_EVENTS = ['onSave', 'onChatSend', 'onCommand', 'onSchedule'] as const;

export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

/** Hooks per manifest. A plugin is a convenience, not a scheduler of its own. */
export const MAX_PLUGIN_HOOKS = 24;

/** Actions one event may fire. Keeps a chatty manifest from flooding a save. */
export const MAX_ACTIONS_PER_EVENT = 20;

export const MIN_SCHEDULE_MINUTES = 1;

/** One week. Anything longer is an automation, not a plugin. */
export const MAX_SCHEDULE_MINUTES = 10080;

export interface PluginCommandAction {
  type: 'command';
  /** Shell command line, replayed through the approval-gated command path. */
  argv: string;
}

export interface PluginPromptAction {
  type: 'prompt';
  /** Message handed to the normal chat path. */
  prompt: string;
}

export type PluginAction = PluginCommandAction | PluginPromptAction;

/**
 * Trigger narrowing. Which field applies depends on the hook event:
 * `glob` for onSave, `command` for onCommand, `intervalMinutes` for onSchedule.
 * onChatSend takes no `when`.
 */
export interface PluginHookWhen {
  /** Workspace-relative path glob, supporting `*` and `**` segments only. */
  glob?: string;
  /** Exact command id from the command palette registry. */
  command?: string;
  /** Schedule period in minutes, 1..10080. */
  intervalMinutes?: number;
}

export interface PluginHook {
  event: PluginEvent;
  when?: PluginHookWhen;
  action: PluginAction;
}

export interface PluginManifest {
  /** Lowercase kebab-case id; also the folder name under `.shadrox/plugins`. */
  id: string;
  name: string;
  /** Semver-shaped version, e.g. `0.1.0` or `1.0.0-beta.1`. */
  version: string;
  description?: string;
  author?: string;
  /** Normalized: absent in the file means enabled. */
  enabled: boolean;
  hooks: PluginHook[];
}

/**
 * One reason a manifest was rejected. `parsePluginManifest` flattens these to
 * `at: message` strings because that is what Settings shows; the structured
 * shape stays available for callers that want to link errors to fields.
 */
export interface PluginParseError {
  /** Field path, e.g. `hooks[2].action.argv`. */
  at: string;
  message: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Workspace-relative path the manifest was read from. */
  sourcePath: string;
  /** Mirrors `manifest.enabled`; disabled plugins stay listed but never run. */
  enabled: boolean;
}

export interface PluginLoadError {
  path: string;
  errors: string[];
}

/** Context an event hands the hook engine. Missing fields never match. */
export interface PluginHookContext {
  /** Saved file, workspace-relative. */
  path?: string;
  /** Command palette id being run. */
  commandId?: string;
}

export interface PluginActionRun {
  pluginId: string;
  hookIndex: number;
  event: PluginEvent;
  action: PluginAction;
}

export interface ScheduledActionRun extends PluginActionRun {
  event: 'onSchedule';
  intervalMinutes: number;
}
