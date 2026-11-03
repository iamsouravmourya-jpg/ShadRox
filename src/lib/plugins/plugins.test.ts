import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PLUGIN_HOOKS,
  discoverPluginManifests,
  dueScheduledHooks,
  loadPlugins,
  matchesGlob,
  parsePluginManifest,
  scheduledHookKey,
  selectHooks
} from './index';
import type { LoadedPlugin } from './index';

const SOURCE = '.shadrox/plugins/demo/plugin.json';
const PROMPT_ACTION = { type: 'prompt', prompt: 'Summarize the change.' };

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'demo',
    name: 'Demo plugin',
    version: '0.1.0',
    hooks: [{ event: 'onChatSend', action: PROMPT_ACTION }],
    ...overrides
  });
}

function parse(overrides: Record<string, unknown> = {}, sourcePath: string = SOURCE) {
  return parsePluginManifest(manifestJson(overrides), sourcePath);
}

function hasError(errors: readonly string[], ...needles: string[]): boolean {
  return errors.some((error) => needles.every((needle) => error.includes(needle)));
}

function promptHooks(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => ({ event: 'onChatSend', action: PROMPT_ACTION }));
}

function entry(id: string, hooks: unknown[], extra: Record<string, unknown> = {}) {
  return {
    path: `.shadrox/plugins/${id}/plugin.json`,
    content: JSON.stringify({ id, name: `${id} plugin`, version: '1.0.0', hooks, ...extra })
  };
}

function loadOrFail(entries: Array<{ path: string; content: string }>): LoadedPlugin[] {
  const result = loadPlugins(entries);
  assert.deepEqual(result.errors, []);
  return result.plugins;
}

function plugin(id: string, hooks: unknown[], extra: Record<string, unknown> = {}): LoadedPlugin {
  const loaded = loadOrFail([entry(id, hooks, extra)]);
  assert.equal(loaded.length, 1);
  return loaded[0];
}

function keys(runs: Array<{ pluginId: string; hookIndex: number }>): string[] {
  return runs.map((run) => `${run.pluginId}#${run.hookIndex}`);
}

test('parses a valid manifest and defaults enabled to true', () => {
  const { manifest, errors } = parse();
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  assert.equal(manifest.id, 'demo');
  assert.equal(manifest.name, 'Demo plugin');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.enabled, true);
  assert.equal(manifest.hooks.length, 1);
  assert.deepEqual(manifest.hooks[0].action, PROMPT_ACTION);
});

test('accepts semver prerelease versions and optional metadata', () => {
  const { manifest, errors } = parse({
    version: '1.0.0-beta.1',
    description: 'Adds review prompts',
    author: 'Sourav',
    enabled: false
  });
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  assert.equal(manifest.version, '1.0.0-beta.1');
  assert.equal(manifest.description, 'Adds review prompts');
  assert.equal(manifest.author, 'Sourav');
  assert.equal(manifest.enabled, false);
});

test('rejects empty files, malformed JSON and non-object roots', () => {
  const empty = parsePluginManifest('', SOURCE);
  assert.equal(empty.manifest, null);
  assert.ok(hasError(empty.errors, 'empty'));

  const broken = parsePluginManifest('{ nope', SOURCE);
  assert.equal(broken.manifest, null);
  assert.ok(hasError(broken.errors, 'invalid JSON'));

  const array = parsePluginManifest('[]', SOURCE);
  assert.equal(array.manifest, null);
  assert.ok(hasError(array.errors, 'JSON object'));
});

test('rejects ids that are not lowercase kebab-case', () => {
  for (const id of ['Demo', 'a', 'demo_plugin', '-demo', 'demo plugin']) {
    const { manifest, errors } = parse({ id });
    assert.equal(manifest, null);
    assert.ok(hasError(errors, 'id:', 'must match'), `expected id error for ${id}`);
  }
});

test('rejects an id that does not match its plugin folder', () => {
  const { manifest, errors } = parse({}, '.shadrox/plugins/other/plugin.json');
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'does not match its folder', 'other'));
});

test('derives the folder id from Windows-style absolute source paths', () => {
  const { manifest, errors } = parse({}, 'C:\\work\\repo\\.shadrox\\plugins\\demo\\plugin.json');
  assert.deepEqual(errors, []);
  assert.equal(manifest?.id, 'demo');
});

test('rejects a missing or blank name', () => {
  const missing = parse({ name: undefined });
  assert.equal(missing.manifest, null);
  assert.ok(hasError(missing.errors, 'name:'));

  const blank = parse({ name: '   ' });
  assert.equal(blank.manifest, null);
  assert.ok(hasError(blank.errors, 'name:'));
});

test('rejects versions that are not semver-shaped', () => {
  for (const version of ['1.0', 'v1', 'latest', '1.0.0.0']) {
    const { manifest, errors } = parse({ version });
    assert.equal(manifest, null);
    assert.ok(hasError(errors, 'version:'), `expected version error for ${version}`);
  }
});

test('rejects a non-boolean enabled flag', () => {
  const { manifest, errors } = parse({ enabled: 'yes' });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'enabled:'));
});

test('rejects empty and oversized hook lists', () => {
  const empty = parse({ hooks: [] });
  assert.equal(empty.manifest, null);
  assert.ok(hasError(empty.errors, 'hooks:', 'at least one'));

  const tooMany = parse({ hooks: promptHooks(MAX_PLUGIN_HOOKS + 1) });
  assert.equal(tooMany.manifest, null);
  assert.ok(hasError(tooMany.errors, 'hooks:', String(MAX_PLUGIN_HOOKS)));
});

test('rejects unknown hook events', () => {
  const { manifest, errors } = parse({ hooks: [{ event: 'onBuild', action: PROMPT_ACTION }] });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'hooks[0].event'));
});

test('requires an exact command id for onCommand', () => {
  const { manifest, errors } = parse({ hooks: [{ event: 'onCommand', action: PROMPT_ACTION }] });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'hooks[0].when.command'));
});

test('rejects when fields that do not belong to the event', () => {
  const save = parse({
    hooks: [{ event: 'onSave', when: { intervalMinutes: 5 }, action: PROMPT_ACTION }]
  });
  assert.equal(save.manifest, null);
  assert.ok(hasError(save.errors, 'not valid for onSave'));

  const chat = parse({
    hooks: [{ event: 'onChatSend', when: { glob: '*.ts' }, action: PROMPT_ACTION }]
  });
  assert.equal(chat.manifest, null);
  assert.ok(hasError(chat.errors, 'takes no when'));
});

test('validates schedule intervals', () => {
  for (const intervalMinutes of [0, 10081, 1.5, '5']) {
    const { manifest, errors } = parse({
      hooks: [{ event: 'onSchedule', when: { intervalMinutes }, action: PROMPT_ACTION }]
    });
    assert.equal(manifest, null);
    assert.ok(hasError(errors, 'intervalMinutes'), `expected interval error for ${String(intervalMinutes)}`);
  }

  const missing = parse({ hooks: [{ event: 'onSchedule', action: PROMPT_ACTION }] });
  assert.equal(missing.manifest, null);
  assert.ok(hasError(missing.errors, 'intervalMinutes'));

  const valid = parse({
    hooks: [{ event: 'onSchedule', when: { intervalMinutes: 10080 }, action: PROMPT_ACTION }]
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.manifest?.hooks[0].when?.intervalMinutes, 10080);
});

test('keeps a safe onSave glob and matches only workspace-relative paths', () => {
  const { manifest, errors } = parse({
    hooks: [{ event: 'onSave', when: { glob: 'src/**/*.ts' }, action: PROMPT_ACTION }]
  });
  assert.deepEqual(errors, []);
  assert.equal(manifest?.hooks[0].when?.glob, 'src/**/*.ts');
});

test('rejects globs that traverse out of the workspace', () => {
  const { manifest, errors } = parse({
    hooks: [{ event: 'onSave', when: { glob: '../secrets/*.json' }, action: PROMPT_ACTION }]
  });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'hooks[0].when.glob'));
});

test('rejects absolute globs', () => {
  for (const glob of ['/etc/*', 'C:\\secret\\*', '//server/share/*']) {
    const { manifest, errors } = parse({
      hooks: [{ event: 'onSave', when: { glob }, action: PROMPT_ACTION }]
    });
    assert.equal(manifest, null);
    assert.ok(hasError(errors, 'hooks[0].when.glob'), `expected glob error for ${glob}`);
  }
});

test('rejects an action that declares both argv and prompt', () => {
  const { manifest, errors } = parse({
    hooks: [{ event: 'onChatSend', action: { type: 'command', argv: 'npm test', prompt: 'run tests' } }]
  });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'hooks[0].action.prompt'));
});

test('rejects a hook with neither action nor action type', () => {
  const missing = parse({ hooks: [{ event: 'onChatSend' }] });
  assert.equal(missing.manifest, null);
  assert.ok(hasError(missing.errors, 'hooks[0].action', 'exactly one action'));

  const untyped = parse({ hooks: [{ event: 'onChatSend', action: {} }] });
  assert.equal(untyped.manifest, null);
  assert.ok(hasError(untyped.errors, 'hooks[0].action.type'));
});

test('rejects unknown action types', () => {
  const { manifest, errors } = parse({
    hooks: [{ event: 'onChatSend', action: { type: 'shell', argv: 'npm test' } }]
  });
  assert.equal(manifest, null);
  assert.ok(hasError(errors, 'unknown action type', 'shell'));
});

test('rejects executable fields anywhere in the manifest', () => {
  const scripts = parse({ scripts: { postinstall: 'node evil.js' } });
  assert.equal(scripts.manifest, null);
  assert.ok(hasError(scripts.errors, 'manifest.scripts'));

  const nested = parse({
    hooks: [{ event: 'onChatSend', action: { type: 'prompt', prompt: 'hi', require: './evil.js' } }]
  });
  assert.equal(nested.manifest, null);
  assert.ok(hasError(nested.errors, 'hooks[0].action.require'));
});

test('discovers manifests only at the plugin root, sorted and unique', () => {
  const files = [
    'src/index.ts',
    '.shadrox/plugins/zed/plugin.json',
    '.shadrox\\plugins\\alpha\\plugin.json',
    '.shadrox/plugins/alpha/plugin.json',
    './.shadrox/plugins/mid/plugin.json',
    '.shadrox/plugins/nested/deep/plugin.json',
    '.shadrox/plugin.json',
    'other/.shadrox/plugins/prefixed/plugin.json',
    '/abs/.shadrox/plugins/absolute/plugin.json'
  ];
  assert.deepEqual(discoverPluginManifests(files), [
    '.shadrox/plugins/alpha/plugin.json',
    '.shadrox/plugins/mid/plugin.json',
    '.shadrox/plugins/zed/plugin.json'
  ]);
});

test('loads plugins and keeps disabled ones listed but not enabled', () => {
  const { plugins, errors } = loadPlugins([
    entry('quiet', promptHooks(1), { enabled: false }),
    entry('active', promptHooks(1))
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    plugins.map((loaded) => [loaded.manifest.id, loaded.enabled]),
    [
      ['active', true],
      ['quiet', false]
    ]
  );
  assert.equal(plugins[1].enabled, false);
  assert.equal(plugins[1].manifest.enabled, false);
});

test('reports an id collision as an error and keeps the first plugin', () => {
  const content = entry('beta', promptHooks(1)).content;
  const { plugins, errors } = loadPlugins([
    { path: '.shadrox/plugins/beta/plugin.json', content },
    { path: '.shadrox\\plugins\\beta\\plugin.json', content }
  ]);
  assert.equal(plugins.length, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].errors.some((error) => error.includes('already declared')));
});

test('reports parse failures with the manifest path', () => {
  const path = '.shadrox/plugins/broken/plugin.json';
  const { plugins, errors } = loadPlugins([{ path, content: '{' }]);
  assert.deepEqual(plugins, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, path);
  assert.ok(errors[0].errors.some((error) => error.includes('invalid JSON')));
});

test('selectHooks orders by plugin id then hook index', () => {
  const plugins = [
    plugin('zeta', [{ event: 'onChatSend', action: PROMPT_ACTION }, { event: 'onChatSend', action: PROMPT_ACTION }]),
    plugin('alpha', [{ event: 'onChatSend', action: PROMPT_ACTION }])
  ];
  assert.deepEqual(keys(selectHooks(plugins, 'onChatSend', {})), ['alpha#0', 'zeta#0', 'zeta#1']);
});

test('selectHooks skips disabled plugins and non-matching events', () => {
  const plugins = [
    plugin('off', promptHooks(1), { enabled: false }),
    plugin('on', promptHooks(1))
  ];
  assert.deepEqual(keys(selectHooks(plugins, 'onChatSend', {})), ['on#0']);
  assert.deepEqual(selectHooks(plugins, 'onSave', { path: 'src/a.ts' }), []);
});

test('selectHooks caps actions per event at 20', () => {
  const plugins = [plugin('aa', promptHooks(12)), plugin('bb', promptHooks(12))];
  const runs = selectHooks(plugins, 'onChatSend', {});
  assert.equal(runs.length, 20);
  assert.equal(keys(runs)[0], 'aa#0');
  assert.equal(keys(runs)[19], 'bb#7');
});

test('selectHooks matches onCommand by exact command id', () => {
  const plugins = [
    plugin('palette', [
      { event: 'onCommand', when: { command: 'file.save' }, action: { type: 'command', argv: 'npm test' } },
      { event: 'onCommand', when: { command: 'file.saveAll' }, action: PROMPT_ACTION }
    ])
  ];
  assert.deepEqual(keys(selectHooks(plugins, 'onCommand', { commandId: 'file.save' })), ['palette#0']);
  assert.deepEqual(keys(selectHooks(plugins, 'onCommand', { commandId: 'file.saveAll' })), ['palette#1']);
  assert.deepEqual(selectHooks(plugins, 'onCommand', { commandId: 'file.save' + 'x' }), []);
  assert.deepEqual(selectHooks(plugins, 'onCommand', {}), []);
});

test('selectHooks applies onSave globs and ignores unsafe paths', () => {
  const plugins = [
    plugin('typescript', [{ event: 'onSave', when: { glob: 'src/**/*.ts' }, action: PROMPT_ACTION }]),
    plugin('docs', [{ event: 'onSave', when: { glob: '**/*.md' }, action: PROMPT_ACTION }]),
    plugin('any', [{ event: 'onSave', action: PROMPT_ACTION }])
  ];
  assert.deepEqual(keys(selectHooks(plugins, 'onSave', { path: 'src/lib/a.ts' })), ['any#0', 'typescript#0']);
  assert.deepEqual(keys(selectHooks(plugins, 'onSave', { path: 'README.md' })), ['any#0', 'docs#0']);
  assert.deepEqual(selectHooks(plugins, 'onSave', { path: '/etc/passwd' }), []);
  assert.deepEqual(selectHooks(plugins, 'onSave', { path: 'src/../../etc/passwd' }), []);
  assert.deepEqual(selectHooks(plugins, 'onSave', {}), []);
});

test('selectHooks never returns scheduled hooks', () => {
  const ticker = plugin('ticker', [
    { event: 'onSchedule', when: { intervalMinutes: 5 }, action: { type: 'command', argv: 'npm run lint' } }
  ]);
  assert.deepEqual(selectHooks([ticker], 'onSchedule', {}), []);
});

test('dueScheduledHooks respects the interval and the last-run map', () => {
  const ticker = plugin('ticker', [
    { event: 'onSchedule', when: { intervalMinutes: 5 }, action: { type: 'command', argv: 'npm run lint' } }
  ]);
  const key = scheduledHookKey('ticker', 0);
  const now = 1_000_000_000;

  const first = dueScheduledHooks([ticker], {}, now);
  assert.equal(first.length, 1);
  assert.equal(first[0].intervalMinutes, 5);
  assert.deepEqual(first[0].action, { type: 'command', argv: 'npm run lint' });

  assert.equal(dueScheduledHooks([ticker], { [key]: now - 60_000 }, now).length, 0);
  assert.equal(dueScheduledHooks([ticker], { [key]: now - 5 * 60_000 }, now).length, 1);
});

test('dueScheduledHooks skips disabled plugins and invalid clocks', () => {
  const ticker = plugin(
    'ticker',
    [{ event: 'onSchedule', when: { intervalMinutes: 5 }, action: PROMPT_ACTION }],
    { enabled: false }
  );
  assert.deepEqual(dueScheduledHooks([ticker], {}, 1_000_000), []);
  assert.deepEqual(dueScheduledHooks([plugin('ticker', [
    { event: 'onSchedule', when: { intervalMinutes: 5 }, action: PROMPT_ACTION }
  ])], {}, Number.NaN), []);
});

test('matchesGlob supports star segments without escaping the workspace', () => {
  assert.equal(matchesGlob('src/lib/a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/lib/a.ts', 'src/**/*.ts'), true);
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('a.ts', '**/*.ts'), true);
  assert.equal(matchesGlob('src/a.ts', '*.ts'), false);
  assert.equal(matchesGlob('src\\lib\\a.ts', 'src/**/*.ts'), true);
  assert.equal(matchesGlob('../secret', '*'), false);
  assert.equal(matchesGlob('/etc/passwd', '**'), false);
  assert.equal(matchesGlob('src/a.ts', 'src/../*.ts'), false);
  assert.equal(matchesGlob('src/a.ts', 'C:/x/*.ts'), false);
});

test('matchesGlob stays linear on pathological star patterns', () => {
  const stars = Array.from({ length: 40 }, () => '**').join('/');
  const started = Date.now();
  assert.equal(matchesGlob('a/b/c/d/e/f/g/h/i/j/k', stars), true);
  assert.equal(matchesGlob('a/b/c/d/e/f/g/h/i/j/k', `${stars}/x`), false);
  assert.ok(Date.now() - started < 1000);
});
