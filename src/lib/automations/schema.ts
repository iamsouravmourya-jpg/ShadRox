/**
 * Validation for `.shadrox/automations.json`.
 *
 * The file is user-edited, so parsing is total: it never throws, keeps every
 * valid definition, and reports one explicit message per rejected definition.
 * Unknown fields are ignored so the format can grow without breaking old
 * workspaces.
 */

import { isSafeGlob } from './scheduler';
import type {
  AutomationAction,
  AutomationDefinition,
  AutomationTrigger,
  ParseAutomationsResult
} from './types';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080;
const MIN_RUNS_PER_DAY = 1;
const MAX_RUNS_PER_DAY = 100;
const MIN_CREDITS_PER_RUN = 0.1;
const MAX_CREDITS_PER_RUN = 20;
const MIN_SECRET_LENGTH = 16;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isSafeWebhookPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) return false;
  if (trimmed.includes('..')) return false;
  if (trimmed.includes('?') || trimmed.includes('#')) return false;
  return !/[\s\u0000-\u001f]/.test(trimmed);
}

function parseTrigger(value: unknown): { trigger?: AutomationTrigger; errors: string[] } {
  if (!isRecord(value)) {
    return { errors: ['trigger must be an object with a type.'] };
  }
  switch (value.type) {
    case 'interval': {
      const minutes = value.minutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < MIN_INTERVAL_MINUTES ||
        minutes > MAX_INTERVAL_MINUTES
      ) {
        return {
          errors: [
            `trigger.minutes must be an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`
          ]
        };
      }
      return { trigger: { type: 'interval', minutes }, errors: [] };
    }
    case 'onSave': {
      if (typeof value.glob !== 'string' || !isSafeGlob(value.glob)) {
        return {
          errors: ['trigger.glob must be a relative glob without ".." or an absolute path.']
        };
      }
      return { trigger: { type: 'onSave', glob: value.glob.trim() }, errors: [] };
    }
    case 'webhook': {
      const errors: string[] = [];
      let path = '';
      let secret = '';
      if (typeof value.path !== 'string' || !isSafeWebhookPath(value.path)) {
        errors.push('trigger.path must start with "/" and contain no "..", query, or fragment.');
      } else {
        path = value.path.trim();
      }
      if (typeof value.secret !== 'string' || value.secret.length < MIN_SECRET_LENGTH) {
        errors.push(`trigger.secret must be a string of at least ${MIN_SECRET_LENGTH} characters.`);
      } else {
        secret = value.secret;
      }
      if (errors.length > 0) return { errors };
      return { trigger: { type: 'webhook', path, secret }, errors: [] };
    }
    default:
      return {
        errors: [
          `trigger.type must be "interval", "onSave", or "webhook" (got ${describe(value.type)}).`
        ]
      };
  }
}

function parseAction(value: unknown): { action?: AutomationAction; errors: string[] } {
  if (!isRecord(value)) {
    return { errors: ['action must be an object with a type.'] };
  }
  switch (value.type) {
    case 'prompt': {
      if (typeof value.prompt !== 'string' || value.prompt.trim() === '') {
        return { errors: ['action.prompt must be a non-empty string.'] };
      }
      return { action: { type: 'prompt', prompt: value.prompt }, errors: [] };
    }
    case 'command': {
      if (typeof value.argv !== 'string' || value.argv.trim() === '') {
        return { errors: ['action.argv must be a non-empty argv string.'] };
      }
      return { action: { type: 'command', argv: value.argv }, errors: [] };
    }
    default:
      return {
        errors: [`action.type must be "prompt" or "command" (got ${describe(value.type)}).`]
      };
  }
}

function parseDefinition(entry: UnknownRecord, prefix: string): {
  definition?: AutomationDefinition;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof entry.name !== 'string' || entry.name.trim() === '') {
    errors.push('name must be a non-empty string.');
  }

  if (typeof entry.enabled !== 'boolean') {
    errors.push('enabled must be a boolean.');
  }

  const trigger = parseTrigger(entry.trigger);
  errors.push(...trigger.errors);

  const action = parseAction(entry.action);
  errors.push(...action.errors);

  let maxRunsPerDay: number | undefined;
  if (entry.maxRunsPerDay !== undefined) {
    if (
      typeof entry.maxRunsPerDay !== 'number' ||
      !Number.isInteger(entry.maxRunsPerDay) ||
      entry.maxRunsPerDay < MIN_RUNS_PER_DAY ||
      entry.maxRunsPerDay > MAX_RUNS_PER_DAY
    ) {
      errors.push(
        `maxRunsPerDay must be an integer from ${MIN_RUNS_PER_DAY} to ${MAX_RUNS_PER_DAY}.`
      );
    } else {
      maxRunsPerDay = entry.maxRunsPerDay;
    }
  }

  let creditsPerRun = 1;
  if (entry.creditsPerRun !== undefined) {
    if (
      typeof entry.creditsPerRun !== 'number' ||
      !Number.isFinite(entry.creditsPerRun) ||
      entry.creditsPerRun < MIN_CREDITS_PER_RUN ||
      entry.creditsPerRun > MAX_CREDITS_PER_RUN
    ) {
      errors.push(
        `creditsPerRun must be a number from ${MIN_CREDITS_PER_RUN} to ${MAX_CREDITS_PER_RUN}.`
      );
    } else {
      creditsPerRun = entry.creditsPerRun;
    }
  }

  if (errors.length > 0 || !trigger.trigger || !action.action) {
    return { errors: errors.map((error) => `${prefix}: ${error}`) };
  }

  return {
    definition: {
      id: entry.id as string,
      name: (entry.name as string).trim(),
      enabled: entry.enabled as boolean,
      trigger: trigger.trigger,
      action: action.action,
      ...(maxRunsPerDay === undefined ? {} : { maxRunsPerDay }),
      creditsPerRun
    },
    errors: []
  };
}

export function parseAutomations(raw: string): ParseAutomationsResult {
  if (typeof raw !== 'string') {
    return { definitions: [], errors: ['Automations must be a JSON string.'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown parse error';
    return { definitions: [], errors: [`Invalid JSON: ${detail}`] };
  }

  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.automations)) {
    entries = parsed.automations;
  } else {
    return {
      definitions: [],
      errors: [
        'Expected a JSON array of automations or an object with an "automations" array.'
      ]
    };
  }

  const definitions: AutomationDefinition[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  entries.forEach((entry, index) => {
    const indexPrefix = `automations[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${indexPrefix}: expected an object.`);
      return;
    }
    const id = entry.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(
        `${indexPrefix}: id must match ${ID_PATTERN.source} (lowercase letters, digits, hyphens; 2-64 characters).`
      );
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${indexPrefix} (${id}): duplicate id.`);
      return;
    }
    seenIds.add(id);

    const result = parseDefinition(entry, `${indexPrefix} (${id})`);
    if (result.definition) definitions.push(result.definition);
    errors.push(...result.errors);
  });

  return { definitions, errors };
}
