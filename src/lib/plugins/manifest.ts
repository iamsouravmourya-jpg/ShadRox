/**
 * The manifest parser.
 *
 * `plugin.json` comes from inside the user's workspace, so it is treated as
 * untrusted data: JSON only, no executable fields, no paths that escape the
 * workspace, no unknown events or action types. Every problem becomes an error
 * string naming the offending field (and hook index). The function never
 * throws, and any error means no manifest is returned, so a partially valid
 * plugin can never load.
 */

import { isSafeGlob } from './hook-engine';
import {
  MAX_PLUGIN_HOOKS,
  MAX_SCHEDULE_MINUTES,
  MIN_SCHEDULE_MINUTES,
  PLUGIN_EVENTS,
  type PluginAction,
  type PluginEvent,
  type PluginHook,
  type PluginHookWhen,
  type PluginManifest
} from './types';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_FIELDS: readonly string[] = ['scripts', 'eval', 'require'];
const WHEN_FIELDS: readonly string[] = ['glob', 'command', 'intervalMinutes'];
const APPLICABLE_WHEN_FIELDS: Readonly<Record<PluginEvent, readonly string[]>> = {
  onSave: ['glob'],
  onChatSend: [],
  onCommand: ['command'],
  onSchedule: ['intervalMinutes']
};
const MAX_SCAN_DEPTH = 12;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function folderIdFromSourcePath(sourcePath: string): string | null {
  if (typeof sourcePath !== 'string') return null;
  const normalized = sourcePath.replace(/\\/g, '/');
  const match = /(?:^|\/)\.shadrox\/plugins\/([^/]+)\/plugin\.json$/.exec(normalized);
  return match && match[1] ? match[1] : null;
}

/** Executable fields are rejected anywhere in the tree, not just at the root. */
function collectForbiddenFields(value: unknown, at: string, errors: string[], depth: number): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenFields(entry, `${at}[${index}]`, errors, depth + 1));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (FORBIDDEN_FIELDS.includes(key)) {
      errors.push(`${at}.${key}: executable fields are not allowed in a plugin manifest`);
      continue;
    }
    if (typeof child === 'object' && child !== null) collectForbiddenFields(child, `${at}.${key}`, errors, depth + 1);
  }
}

function parseAction(raw: unknown, at: string, errors: string[]): PluginAction | null {
  const record = asRecord(raw);
  if (!record) {
    errors.push(`${at}: hook must declare exactly one action`);
    return null;
  }
  const type = record.type;
  if (type !== 'command' && type !== 'prompt') {
    if (type === undefined) {
      const declaresBoth = record.argv !== undefined && record.prompt !== undefined;
      errors.push(
        declaresBoth
          ? `${at}: declares both argv and prompt; exactly one action is allowed`
          : `${at}.type: must be "command" or "prompt"`
      );
    } else {
      errors.push(`${at}.type: unknown action type ${JSON.stringify(type)}`);
    }
    return null;
  }

  const before = errors.length;
  if (type === 'command') {
    if (record.prompt !== undefined) errors.push(`${at}.prompt: a command action cannot also declare a prompt`);
    if (asTrimmedString(record.argv).length === 0) errors.push(`${at}.argv: a command action needs a non-empty argv string`);
  } else {
    if (record.argv !== undefined) errors.push(`${at}.argv: a prompt action cannot also declare argv`);
    if (asTrimmedString(record.prompt).length === 0) errors.push(`${at}.prompt: a prompt action needs a non-empty prompt string`);
  }
  if (errors.length > before) return null;
  return type === 'command'
    ? { type: 'command', argv: asTrimmedString(record.argv) }
    : { type: 'prompt', prompt: asTrimmedString(record.prompt) };
}

function parseWhen(raw: unknown, event: PluginEvent, at: string, errors: string[]): PluginHookWhen | null {
  if (raw === undefined) {
    if (event === 'onCommand') errors.push(`${at}.command: onCommand requires an exact command id`);
    if (event === 'onSchedule') errors.push(`${at}.intervalMinutes: onSchedule requires an interval in minutes`);
    return null;
  }
  const record = asRecord(raw);
  if (!record) {
    errors.push(`${at}: must be an object`);
    return null;
  }
  const keys = Object.keys(record);
  if (event === 'onChatSend') {
    if (keys.length > 0) errors.push(`${at}: onChatSend takes no when`);
    return null;
  }
  for (const key of keys) {
    if (!WHEN_FIELDS.includes(key)) {
      errors.push(`${at}.${key}: unknown when field`);
    } else if (!APPLICABLE_WHEN_FIELDS[event].includes(key)) {
      errors.push(`${at}.${key}: not valid for ${event}`);
    }
  }

  const before = errors.length;
  if (event === 'onSave') {
    if (record.glob === undefined) return null;
    const glob = asTrimmedString(record.glob);
    if (!glob) {
      errors.push(`${at}.glob: must be a non-empty string`);
    } else if (!isSafeGlob(glob)) {
      errors.push(`${at}.glob: "${glob}" must be a workspace-relative glob with no ".." or absolute paths`);
    }
    if (errors.length > before) return null;
    return { glob };
  }

  if (event === 'onCommand') {
    const command = asTrimmedString(record.command);
    if (!COMMAND_ID_PATTERN.test(command)) {
      errors.push(`${at}.command: "${String(record.command)}" is not a command id`);
      return null;
    }
    return { command };
  }

  const interval = record.intervalMinutes;
  if (
    typeof interval !== 'number' ||
    !Number.isInteger(interval) ||
    interval < MIN_SCHEDULE_MINUTES ||
    interval > MAX_SCHEDULE_MINUTES
  ) {
    errors.push(
      `${at}.intervalMinutes: must be an integer between ${MIN_SCHEDULE_MINUTES} and ${MAX_SCHEDULE_MINUTES}`
    );
    return null;
  }
  return { intervalMinutes: interval };
}

function parseHook(raw: unknown, index: number, errors: string[]): PluginHook | null {
  const at = `hooks[${index}]`;
  const record = asRecord(raw);
  if (!record) {
    errors.push(`${at}: must be an object`);
    return null;
  }
  const before = errors.length;
  const eventValue = record.event;
  const event = PLUGIN_EVENTS.includes(eventValue as PluginEvent) ? (eventValue as PluginEvent) : null;
  if (!event) errors.push(`${at}.event: must be one of ${PLUGIN_EVENTS.join(', ')}`);
  const when = event ? parseWhen(record.when, event, `${at}.when`, errors) : null;
  const action = parseAction(record.action, `${at}.action`, errors);
  if (errors.length > before || !event || !action) return null;
  const hook: PluginHook = { event, action };
  if (when) hook.when = when;
  return hook;
}

export function parsePluginManifest(
  raw: string,
  sourcePath: string
): { manifest: PluginManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { manifest: null, errors: ['manifest: file is empty'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unreadable JSON';
    return { manifest: null, errors: [`manifest: invalid JSON (${detail})`] };
  }

  const record = asRecord(parsed);
  if (!record) return { manifest: null, errors: ['manifest: root must be a JSON object'] };

  collectForbiddenFields(record, 'manifest', errors, 0);

  const id = asTrimmedString(record.id);
  if (!ID_PATTERN.test(id)) {
    errors.push(`id: "${id}" must match ${ID_PATTERN.source}`);
  } else {
    const folderId = folderIdFromSourcePath(sourcePath);
    if (folderId && folderId !== id) errors.push(`id: "${id}" does not match its folder "${folderId}"`);
  }

  const name = asTrimmedString(record.name);
  if (!name) errors.push('name: must be a non-empty string');

  const version = asTrimmedString(record.version);
  if (!VERSION_PATTERN.test(version)) errors.push(`version: "${version}" must be a semver value like 1.0.0`);

  let description: string | undefined;
  if (record.description !== undefined) {
    const value = asTrimmedString(record.description);
    if (!value) errors.push('description: must be a non-empty string when present');
    else description = value;
  }

  let author: string | undefined;
  if (record.author !== undefined) {
    const value = asTrimmedString(record.author);
    if (!value) errors.push('author: must be a non-empty string when present');
    else author = value;
  }

  let enabled = true;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') errors.push('enabled: must be a boolean');
    else enabled = record.enabled;
  }

  const hooks: PluginHook[] = [];
  if (!Array.isArray(record.hooks)) {
    errors.push('hooks: must be an array');
  } else if (record.hooks.length === 0) {
    errors.push('hooks: at least one hook is required');
  } else if (record.hooks.length > MAX_PLUGIN_HOOKS) {
    errors.push(`hooks: at most ${MAX_PLUGIN_HOOKS} hooks are allowed`);
  } else {
    record.hooks.forEach((entry, index) => {
      const hook = parseHook(entry, index, errors);
      if (hook) hooks.push(hook);
    });
  }

  if (errors.length > 0) return { manifest: null, errors };

  const manifest: PluginManifest = { id, name, version, enabled, hooks };
  if (description) manifest.description = description;
  if (author) manifest.author = author;
  return { manifest, errors };
}
