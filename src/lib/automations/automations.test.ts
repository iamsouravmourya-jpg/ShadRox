import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeWebhook,
  constantTimeEqual,
  consumeBudget,
  dayKey,
  dueAutomations,
  evaluateSaveTriggers,
  matchGlob,
  matchWebhook,
  nextRunAt,
  parseAutomations
} from './index';
import type { AutomationDefinition, AutomationState } from './types';

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const SECRET = '0123456789abcdef';

function intervalDef(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly',
    name: 'Nightly',
    enabled: true,
    trigger: { type: 'interval', minutes: 60 },
    action: { type: 'prompt', prompt: 'run the audit' },
    creditsPerRun: 1,
    ...overrides
  };
}

function saveDef(glob: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'on-save',
    name: 'On save',
    enabled: true,
    trigger: { type: 'onSave', glob },
    action: { type: 'command', argv: 'npm run lint' },
    creditsPerRun: 1,
    ...overrides
  };
}

function webhookDef(path = '/hooks/deploy', overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'hook',
    name: 'Hook',
    enabled: true,
    trigger: { type: 'webhook', path, secret: SECRET },
    action: { type: 'prompt', prompt: 'deploy' },
    creditsPerRun: 1,
    ...overrides
  };
}

function state(overrides: Partial<AutomationState> = {}): AutomationState {
  return { id: 'nightly', createdAt: T0, runCount: 0, ...overrides };
}

test('parseAutomations accepts an array, applies defaults and ignores unknown fields', () => {
  const raw = JSON.stringify([
    {
      id: 'nightly-audit',
      name: ' Nightly audit ',
      enabled: true,
      trigger: { type: 'interval', minutes: 1440 },
      action: { type: 'prompt', prompt: 'audit the repo' },
      extra: 'ignored'
    },
    {
      id: 'lint-on-save',
      name: 'Lint on save',
      enabled: true,
      trigger: { type: 'onSave', glob: 'src/**/*.ts' },
      action: { type: 'command', argv: 'npm run lint' },
      maxRunsPerDay: 5,
      creditsPerRun: 0.5
    }
  ]);

  const { definitions, errors } = parseAutomations(raw);
  assert.deepEqual(errors, []);
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].name, 'Nightly audit');
  assert.equal(definitions[0].creditsPerRun, 1);
  assert.equal(definitions[0].maxRunsPerDay, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(definitions[0], 'extra'), false);
  assert.equal(definitions[1].creditsPerRun, 0.5);
  assert.equal(definitions[1].maxRunsPerDay, 5);
});

test('parseAutomations accepts an object with an automations array', () => {
  const raw = JSON.stringify({
    version: 1,
    automations: [
      {
        id: 'hourly',
        name: 'Hourly',
        enabled: false,
        trigger: { type: 'interval', minutes: 60 },
        action: { type: 'prompt', prompt: 'hello' }
      }
    ]
  });
  const { definitions, errors } = parseAutomations(raw);
  assert.deepEqual(errors, []);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].enabled, false);
});

test('parseAutomations never throws on malformed or wrongly shaped JSON', () => {
  const malformed = parseAutomations('{ not json');
  assert.equal(malformed.definitions.length, 0);
  assert.equal(malformed.errors.length, 1);
  assert.match(malformed.errors[0], /^Invalid JSON:/);

  const wrongShape = parseAutomations('{"definitions":[]}');
  assert.equal(wrongShape.definitions.length, 0);
  assert.equal(wrongShape.errors.length, 1);

  const notObjects = parseAutomations('[null, 4, "x"]');
  assert.equal(notObjects.definitions.length, 0);
  assert.equal(notObjects.errors.length, 3);
});

test('parseAutomations rejects invalid and duplicate ids, keeping the first valid one', () => {
  const entry = {
    name: 'Thing',
    enabled: true,
    trigger: { type: 'interval', minutes: 60 },
    action: { type: 'prompt', prompt: 'go' }
  };
  const raw = JSON.stringify([
    { ...entry, id: 'Bad' },
    { ...entry, id: 'a' },
    { ...entry, id: '-lead' },
    { ...entry, id: 'nightly' },
    { ...entry, id: 'nightly' }
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].id, 'nightly');
  assert.equal(errors.length, 4);
  assert.match(errors[3], /duplicate id/);
});

test('parseAutomations tolerates a UTF-8 BOM and returns no definitions for an empty array', () => {
  const raw = `\uFEFF${JSON.stringify([
    {
      id: 'hourly',
      name: 'Hourly',
      enabled: true,
      trigger: { type: 'interval', minutes: 60 },
      action: { type: 'prompt', prompt: 'go' }
    }
  ])}`;
  const parsed = parseAutomations(raw);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.definitions.length, 1);
  assert.deepEqual(parseAutomations('[]'), { definitions: [], errors: [] });
});

test('parseAutomations requires a name and a boolean enabled flag', () => {
  const raw = JSON.stringify([
    {
      id: 'bad-name',
      name: '   ',
      enabled: 'yes',
      trigger: { type: 'interval', minutes: 60 },
      action: { type: 'prompt', prompt: 'go' }
    }
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.includes('name must be a non-empty string')));
  assert.ok(errors.some((error) => error.includes('enabled must be a boolean')));
});

test('parseAutomations rejects unknown trigger and action types', () => {
  const raw = JSON.stringify([
    {
      id: 'unknown-trigger',
      name: 'Unknown trigger',
      enabled: true,
      trigger: { type: 'cron', minutes: 5 },
      action: { type: 'prompt', prompt: 'go' }
    },
    {
      id: 'unknown-action',
      name: 'Unknown action',
      enabled: true,
      trigger: { type: 'interval', minutes: 5 },
      action: { type: 'shell', argv: 'rm -rf /' }
    }
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.includes('trigger.type must be')));
  assert.ok(errors.some((error) => error.includes('action.type must be')));
});

test('parseAutomations requires exactly one trigger object and one action object', () => {
  const raw = JSON.stringify([
    {
      id: 'arrays',
      name: 'Arrays',
      enabled: true,
      trigger: [{ type: 'interval', minutes: 5 }],
      action: [{ type: 'prompt', prompt: 'go' }]
    },
    {
      id: 'missing',
      name: 'Missing',
      enabled: true
    }
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 0);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((error) => error.includes('trigger must be an object')));
  assert.ok(errors.some((error) => error.includes('action must be an object')));
});

test('parseAutomations enforces the interval range and integer minutes', () => {
  const make = (id: string, minutes: unknown) => ({
    id,
    name: id,
    enabled: true,
    trigger: { type: 'interval', minutes },
    action: { type: 'prompt', prompt: 'go' }
  });
  const raw = JSON.stringify([
    make('interval-zero', 0),
    make('interval-high', 10081),
    make('interval-float', 1.5),
    make('interval-edge', 10080)
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].id, 'interval-edge');
  assert.equal(errors.length, 3);
});

test('parseAutomations rejects unsafe webhook paths and short secrets', () => {
  const make = (id: string, path: string, secret: string) => ({
    id,
    name: id,
    enabled: true,
    trigger: { type: 'webhook', path, secret },
    action: { type: 'prompt', prompt: 'go' }
  });
  const raw = JSON.stringify([
    make('no-slash', 'hooks/build', SECRET),
    make('traversal', '/hooks/../build', SECRET),
    make('short-secret', '/hooks/build', 'too-short'),
    make('valid-hook', '/hooks/build', SECRET)
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].id, 'valid-hook');
  assert.equal(errors.length, 3);
});

test('parseAutomations rejects absolute and traversal globs', () => {
  const make = (id: string, glob: string) => ({
    id,
    name: id,
    enabled: true,
    trigger: { type: 'onSave', glob },
    action: { type: 'command', argv: 'npm test' }
  });
  const raw = JSON.stringify([
    make('absolute-glob', '/etc/passwd.ts'),
    make('parent-glob', '../secret.ts'),
    make('inner-parent', 'src/../secret.ts'),
    make('empty-glob', '   '),
    make('valid-glob', 'src/**/*.ts')
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].id, 'valid-glob');
  assert.equal(errors.length, 4);
});

test('parseAutomations enforces maxRunsPerDay 1..100', () => {
  const make = (id: string, maxRunsPerDay: unknown) => ({
    id,
    name: id,
    enabled: true,
    trigger: { type: 'interval', minutes: 10 },
    action: { type: 'prompt', prompt: 'go' },
    maxRunsPerDay
  });
  const raw = JSON.stringify([
    make('cap-zero', 0),
    make('cap-high', 101),
    make('cap-float', 2.5),
    make('cap-edge', 100)
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].maxRunsPerDay, 100);
  assert.equal(errors.length, 3);
});

test('parseAutomations enforces creditsPerRun 0.1..20 and defaults to 1', () => {
  const make = (id: string, creditsPerRun?: unknown) => ({
    id,
    name: id,
    enabled: true,
    trigger: { type: 'interval', minutes: 10 },
    action: { type: 'prompt', prompt: 'go' },
    ...(creditsPerRun === undefined ? {} : { creditsPerRun })
  });
  const raw = JSON.stringify([
    make('credit-zero', 0),
    make('credit-low', 0.05),
    make('credit-high', 20.1),
    make('credit-min', 0.1),
    make('credit-max', 20)
  ]);
  const { definitions, errors } = parseAutomations(raw);
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].creditsPerRun, 0.1);
  assert.equal(definitions[1].creditsPerRun, 20);
  assert.equal(errors.length, 3);

  const defaults = parseAutomations(JSON.stringify([make('credit-default')]));
  assert.equal(defaults.definitions[0].creditsPerRun, 1);
});

test('dueAutomations does not run an interval before its interval has elapsed', () => {
  const definitions = [intervalDef({ trigger: { type: 'interval', minutes: 60 } })];
  const states = [state({ createdAt: T0 })];
  assert.deepEqual(dueAutomations(definitions, states, T0 + 59 * MINUTE), []);
  assert.equal(dueAutomations(definitions, states, T0 + 60 * MINUTE).length, 1);
});

test('the first interval run is anchored to createdAt, not the epoch', () => {
  const definitions = [intervalDef({ trigger: { type: 'interval', minutes: 30 } })];
  const fresh = [state({ createdAt: T0 })];
  assert.deepEqual(dueAutomations(definitions, fresh, T0 + 29 * MINUTE), []);
  const requests = dueAutomations(definitions, fresh, T0 + 30 * MINUTE);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reason, 'interval');
  assert.equal(requests[0].requestedAt, T0 + 30 * MINUTE);
  assert.equal(requests[0].credits, 1);
});

test('lastRunAt takes precedence over createdAt for interval timing', () => {
  const definitions = [intervalDef({ trigger: { type: 'interval', minutes: 60 } })];
  const recent = [state({ createdAt: T0 - 10 * 24 * 60 * MINUTE, lastRunAt: T0 - 30 * MINUTE })];
  assert.deepEqual(dueAutomations(definitions, recent, T0), []);
  const stale = [state({ createdAt: T0 - 10 * 24 * 60 * MINUTE, lastRunAt: T0 - 61 * MINUTE })];
  assert.equal(dueAutomations(definitions, stale, T0).length, 1);
});

test('disabled definitions, non-interval triggers and uninitialized states are not due', () => {
  const definitions = [
    intervalDef({ id: 'disabled', enabled: false }),
    intervalDef({ id: 'no-state' }),
    webhookDef('/hooks/deploy', { id: 'hook' })
  ];
  const states = [state({ id: 'disabled', createdAt: T0 }), state({ id: 'hook', createdAt: T0 })];
  assert.deepEqual(dueAutomations(definitions, states, T0 + 365 * 24 * 60 * MINUTE), []);
});

test('dueAutomations is ordered by id regardless of definition or state order', () => {
  const definitions = [
    intervalDef({ id: 'zulu' }),
    intervalDef({ id: 'alpha' }),
    intervalDef({ id: 'mike' })
  ];
  const states = [
    state({ id: 'mike', createdAt: T0 - 120 * MINUTE }),
    state({ id: 'zulu', createdAt: T0 - 120 * MINUTE }),
    state({ id: 'alpha', createdAt: T0 - 120 * MINUTE })
  ];
  const ids = dueAutomations(definitions, states, T0).map((request) => request.automationId);
  assert.deepEqual(ids, ['alpha', 'mike', 'zulu']);

  const stateMap = Object.fromEntries(states.map((entry) => [entry.id, entry]));
  const mapped = dueAutomations(definitions, stateMap, T0).map((request) => request.automationId);
  assert.deepEqual(mapped, ids);
});

test('nextRunAt reports the interval boundary and null for other triggers', () => {
  const definition = intervalDef({ trigger: { type: 'interval', minutes: 90 } });
  assert.equal(nextRunAt(definition, state({ createdAt: T0 })), T0 + 90 * MINUTE);
  assert.equal(
    nextRunAt(definition, state({ createdAt: T0, lastRunAt: T0 + 10 * MINUTE })),
    T0 + 100 * MINUTE
  );
  assert.equal(nextRunAt(webhookDef(), state()), null);
  assert.equal(nextRunAt(saveDef('*.ts'), state()), null);
});

test('evaluateSaveTriggers matches relative globs, including nested and Windows-style paths', () => {
  const definitions = [saveDef('src/**/*.ts', { id: 'src-ts' })];
  assert.equal(evaluateSaveTriggers(definitions, 'src/a.ts').length, 1);
  assert.equal(evaluateSaveTriggers(definitions, 'src/lib/a.ts').length, 1);
  assert.equal(evaluateSaveTriggers(definitions, 'src\\lib\\a.ts').length, 1);
  assert.equal(evaluateSaveTriggers(definitions, 'README.md').length, 0);
  assert.equal(evaluateSaveTriggers(definitions, '../outside.ts').length, 0);
  assert.equal(evaluateSaveTriggers(definitions, '/abs/src/a.ts').length, 0);

  const shallow = [saveDef('*.ts', { id: 'root-ts' })];
  assert.equal(evaluateSaveTriggers(shallow, 'a.ts').length, 1);
  assert.equal(evaluateSaveTriggers(shallow, 'src/a.ts').length, 0);
});

test('evaluateSaveTriggers ignores disabled definitions and orders matches by id', () => {
  const definitions = [
    saveDef('**/*.ts', { id: 'zulu' }),
    saveDef('**/*.ts', { id: 'alpha' }),
    saveDef('**/*.ts', { id: 'off', enabled: false })
  ];
  const ids = evaluateSaveTriggers(definitions, 'src/a.ts').map((request) => request.automationId);
  assert.deepEqual(ids, ['alpha', 'zulu']);
});

test('matchGlob supports * and ** without crossing path segments', () => {
  assert.equal(matchGlob('*.ts', 'a.ts'), true);
  assert.equal(matchGlob('*.ts', 'src/a.ts'), false);
  assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('src/*.ts', 'src/lib/a.ts'), false);
  assert.equal(matchGlob('src/**/*.ts', 'src/lib/deep/a.ts'), true);
  assert.equal(matchGlob('**/*.test.ts', 'a.test.ts'), true);
  assert.equal(matchGlob('src/**', 'src/lib/a.ts'), true);
  assert.equal(matchGlob('../*.ts', 'a.ts'), false);
});

test('consumeBudget enforces the daily cap and rolls over at the next UTC day', () => {
  const definition = intervalDef({ maxRunsPerDay: 2 });
  const today = dayKey(T0);
  const full = state({ dayKey: today, runCount: 2, lastRunAt: T0 - MINUTE });

  const refused = consumeBudget(full, definition, T0);
  assert.equal(refused.allowed, false);
  assert.deepEqual(refused.state, full);
  assert.match(refused.reason ?? '', /daily cap/);

  const nextDay = T0 + 24 * 60 * MINUTE;
  const allowed = consumeBudget(full, definition, nextDay);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.state.runCount, 1);
  assert.equal(allowed.state.dayKey, dayKey(nextDay));
  assert.equal(allowed.state.lastRunAt, nextDay);
});

test('consumeBudget increments without a cap and stops at the cap when provided', () => {
  const uncapped = consumeBudget(
    state({ dayKey: dayKey(T0), runCount: 7 }),
    intervalDef(),
    T0
  );
  assert.equal(uncapped.allowed, true);
  assert.equal(uncapped.state.runCount, 8);

  const capped = consumeBudget(
    state({ dayKey: dayKey(T0), runCount: 1 }),
    intervalDef({ maxRunsPerDay: 2 }),
    T0
  );
  assert.equal(capped.allowed, true);
  assert.equal(capped.state.runCount, 2);

  const blocked = consumeBudget(capped.state, intervalDef({ maxRunsPerDay: 2 }), T0 + 1);
  assert.equal(blocked.allowed, false);
});

test('a due request carries the definition credits and does not pre-spend the budget', () => {
  const definition = intervalDef({
    trigger: { type: 'interval', minutes: 60 },
    creditsPerRun: 20,
    maxRunsPerDay: 1
  });
  const states = [state({ createdAt: T0 })];
  const requests = dueAutomations([definition], states, T0 + 60 * MINUTE);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].credits, 20);
  assert.equal(states[0].runCount, 0);
  assert.equal(states[0].lastRunAt, undefined);
});

test('matchWebhook accepts POST and an exact path, and ignores other methods, paths and disabled hooks', () => {
  const definition = webhookDef('/hooks/deploy');
  assert.equal(matchWebhook([definition], 'POST', '/hooks/deploy'), definition);
  assert.equal(matchWebhook([definition], 'post', '/hooks/deploy'), definition);
  assert.equal(matchWebhook([definition], 'GET', '/hooks/deploy'), null);
  assert.equal(matchWebhook([definition], 'PUT', '/hooks/deploy'), null);
  assert.equal(matchWebhook([definition], 'POST', '/hooks/deploy/'), null);
  assert.equal(matchWebhook([definition], 'POST', '/hooks/deploy?x=1'), null);
  assert.equal(matchWebhook([definition], 'POST', '/hooks/other'), null);
  assert.equal(matchWebhook([webhookDef('/hooks/deploy', { enabled: false })], 'POST', '/hooks/deploy'), null);
  assert.equal(matchWebhook([intervalDef()], 'POST', '/hooks/deploy'), null);
});

test('matchWebhook resolves duplicate paths deterministically by id', () => {
  const zulu = webhookDef('/hooks/deploy', { id: 'zulu' });
  const alpha = webhookDef('/hooks/deploy', { id: 'alpha' });
  assert.equal(matchWebhook([zulu, alpha], 'POST', '/hooks/deploy')?.id, 'alpha');
});

test('authorizeWebhook accepts the exact secret and rejects wrong or wrong-length secrets', () => {
  const definition = webhookDef('/hooks/deploy');
  assert.equal(authorizeWebhook(definition, SECRET), true);
  assert.equal(authorizeWebhook(definition, 'fedcba9876543210'), false);
  assert.equal(authorizeWebhook(definition, SECRET.slice(0, 15)), false);
  assert.equal(authorizeWebhook(definition, `${SECRET}x`), false);
  assert.equal(authorizeWebhook(definition, ''), false);
  assert.equal(authorizeWebhook(intervalDef(), SECRET), false);
});

test('constantTimeEqual compares equal strings and rejects length mismatches without throwing', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'sane'), false);
  assert.equal(constantTimeEqual('same', 'sam'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('a'.repeat(64), `a${'b'.repeat(63)}`), false);
});
