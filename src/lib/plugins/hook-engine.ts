/**
 * The hook engine: pure selection, never execution.
 *
 * `selectHooks` answers "which declared actions should fire for this event?".
 * It runs nothing itself — command actions are replayed by the approval-gated
 * command path and prompt actions by the normal chat path, so a plugin can only
 * ask for work the user could already trigger by hand.
 *
 * Globs are matched without a regex. `*` is a wildcard inside one segment and
 * `**` is a whole segment that matches any number of segments (including none),
 * which is all a plugin needs and cannot be turned into catastrophic
 * backtracking.
 */

import {
  MAX_ACTIONS_PER_EVENT,
  type LoadedPlugin,
  type PluginActionRun,
  type PluginEvent,
  type PluginHook,
  type PluginHookContext,
  type ScheduledActionRun
} from './types';

const MAX_GLOB_LENGTH = 512;
const MAX_GLOB_SEGMENTS = 64;
const MAX_PATH_LENGTH = 1024;

/**
 * Normalize a workspace-relative path or glob to segments. Returns null for
 * anything that could escape the workspace: absolute paths, drive letters, UNC
 * paths, NUL bytes, empty segments and `..`.
 */
function normalizeRelative(value: string): string[] | null {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.length > MAX_PATH_LENGTH) return null;
  if (path.includes('\0')) return null;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments;
}

/** True when a glob is workspace-relative and safely matchable. */
export function isSafeGlob(glob: string): boolean {
  if (typeof glob !== 'string') return false;
  if (glob.trim().length > MAX_GLOB_LENGTH) return false;
  const segments = normalizeRelative(glob);
  return segments !== null && segments.length <= MAX_GLOB_SEGMENTS;
}

/** Single-segment wildcard match. `*` matches any run of characters. */
function segmentMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex += 1;
      resumeIndex = valueIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      resumeIndex += 1;
      valueIndex = resumeIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

/** Match a workspace-relative path against a `*` / `**` glob. */
export function matchesGlob(path: string, glob: string): boolean {
  if (!isSafeGlob(glob)) return false;
  const parts = normalizeRelative(path);
  const patterns = normalizeRelative(glob);
  if (!parts || !patterns) return false;

  const width = patterns.length + 1;
  const memo = new Map<number, boolean>();
  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = pathIndex * width + patternIndex;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === patterns.length) {
      result = pathIndex === parts.length;
    } else if (patterns[patternIndex] === '**') {
      result = match(pathIndex, patternIndex + 1) || (pathIndex < parts.length && match(pathIndex + 1, patternIndex));
    } else if (pathIndex === parts.length) {
      result = false;
    } else {
      result = segmentMatches(parts[pathIndex], patterns[patternIndex]) && match(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function comparePlugins(a: LoadedPlugin, b: LoadedPlugin): number {
  if (a.manifest.id < b.manifest.id) return -1;
  if (a.manifest.id > b.manifest.id) return 1;
  return 0;
}

function hookMatches(hook: PluginHook, event: PluginEvent, context: PluginHookContext): boolean {
  if (hook.event !== event) return false;
  switch (event) {
    case 'onSave': {
      const target = context.path;
      if (!target) return false;
      // The no-glob case still goes through the matcher so an absolute or
      // traversal path can never fire a save hook.
      return matchesGlob(target, hook.when?.glob ?? '**');
    }
    case 'onChatSend':
      return true;
    case 'onCommand':
      return typeof context.commandId === 'string' && context.commandId.length > 0 && context.commandId === hook.when?.command;
    case 'onSchedule':
      // Time-based; the app asks `dueScheduledHooks` instead.
      return false;
  }
}

/**
 * Enabled actions matching one event, ordered by plugin id then hook index and
 * capped at the per-event limit. Scheduled hooks are not selected here.
 */
export function selectHooks(
  plugins: readonly LoadedPlugin[],
  event: PluginEvent,
  context: PluginHookContext = {}
): PluginActionRun[] {
  const runs: PluginActionRun[] = [];
  const ordered = [...plugins].sort(comparePlugins);
  for (const plugin of ordered) {
    if (!plugin.enabled) continue;
    plugin.manifest.hooks.forEach((hook, hookIndex) => {
      if (runs.length >= MAX_ACTIONS_PER_EVENT) return;
      if (!hookMatches(hook, event, context)) return;
      runs.push({ pluginId: plugin.manifest.id, hookIndex, event, action: hook.action });
    });
  }
  return runs;
}

/** Key used in the persisted last-run map for one scheduled hook. */
export function scheduledHookKey(pluginId: string, hookIndex: number): string {
  return `${pluginId}#${hookIndex}`;
}

/** Scheduled actions whose interval has elapsed since `lastRunById`. */
export function dueScheduledHooks(
  plugins: readonly LoadedPlugin[],
  lastRunById: Readonly<Record<string, number>>,
  now: number
): ScheduledActionRun[] {
  if (!Number.isFinite(now)) return [];
  const runs: ScheduledActionRun[] = [];
  const ordered = [...plugins].sort(comparePlugins);
  for (const plugin of ordered) {
    if (!plugin.enabled) continue;
    plugin.manifest.hooks.forEach((hook, hookIndex) => {
      if (runs.length >= MAX_ACTIONS_PER_EVENT) return;
      if (hook.event !== 'onSchedule') return;
      const intervalMinutes = hook.when?.intervalMinutes;
      if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes)) return;
      const last = lastRunById[scheduledHookKey(plugin.manifest.id, hookIndex)];
      if (typeof last === 'number' && Number.isFinite(last) && now - last < intervalMinutes * 60_000) return;
      runs.push({
        pluginId: plugin.manifest.id,
        hookIndex,
        event: 'onSchedule',
        action: hook.action,
        intervalMinutes
      });
    });
  }
  return runs;
}
