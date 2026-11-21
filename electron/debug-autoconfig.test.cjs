'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectWorkspaceFiles, inferLaunchConfigs, inferLaunchConfigsFromNames } = require('./debug-autoconfig.cjs');
const { readLaunchConfigs } = require('./debug-host.cjs');

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-dbg-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? '');
  }
  return root;
}

/** A workspace that can actually pass normalizeConfig: program + js-debug adapter installed. */
function debuggableWorkspace(extraFiles = {}) {
  return makeWorkspace({
    'src/index.js': 'console.log("hi");\n',
    'node_modules/@vscode/js-debug/src/dapDebugServer.js': '// adapter\n',
    ...extraFiles
  });
}

test('inferLaunchConfigs finds the Node entry point in a plain JS workspace', () => {
  const root = makeWorkspace({ 'src/index.js': 'x' });
  const configs = inferLaunchConfigs(root);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].name, 'Node.js / TypeScript App');
  assert.equal(configs[0].program, 'src/index.js');
  assert.equal(configs[0].type, 'node');
  assert.equal(configs[0].request, 'launch');
});

test('inferLaunchConfigs prefers package.json main and server entries', () => {
  const root = makeWorkspace({
    'package.json': JSON.stringify({ name: 'x', main: 'src/server.ts' }),
    'src/server.ts': 'x',
    'index.js': 'x'
  });
  const configs = inferLaunchConfigs(root);
  assert.equal(configs[0].program, 'src/server.ts');
});

test('inferLaunchConfigs offers Vite only when the binary is actually installed', () => {
  const withoutVite = makeWorkspace({ 'package.json': '{"name":"x"}' });
  assert.equal(inferLaunchConfigs(withoutVite).some((c) => c.name === 'Vite / Web Dev Server'), false);

  const withVite = makeWorkspace({
    'package.json': '{"name":"x"}',
    'node_modules/vite/bin/vite.js': 'x'
  });
  const configs = inferLaunchConfigs(withVite);
  const vite = configs.find((c) => c.name === 'Vite / Web Dev Server');
  assert.ok(vite, 'vite binary present means the config is offered');
  assert.equal(vite.program, 'node_modules/vite/bin/vite.js');
});

test('inferLaunchConfigs detects Next.js via config file or dependency', () => {
  const byConfig = makeWorkspace({
    'next.config.mjs': 'x',
    'node_modules/next/dist/bin/next': 'x'
  });
  assert.ok(inferLaunchConfigs(byConfig).some((c) => c.name === 'Next.js Dev Server'));

  const byDep = makeWorkspace({
    'package.json': JSON.stringify({ dependencies: { next: '^15.0.0' } }),
    'node_modules/next/dist/bin/next': 'x'
  });
  assert.ok(inferLaunchConfigs(byDep).some((c) => c.name === 'Next.js Dev Server'));
});

test('inferLaunchConfigs gates Python entries on debugpy availability and emits hint when unavailable', () => {
  const py = makeWorkspace({ 'main.py': 'print(1)\n' });
  const withoutDebugpy = inferLaunchConfigs(py, {
    resolvePython: () => null
  });
  assert.deepEqual(withoutDebugpy, []);

  const readWithoutDebugpy = readLaunchConfigs(py, []);
  if (readWithoutDebugpy.configurations.length === 0) {
    assert.equal(readWithoutDebugpy.found, false);
    assert.match(readWithoutDebugpy.hint ?? '', /debugpy/i);
    assert.match(readWithoutDebugpy.hint ?? '', /shadrox\.debug\.json/i);
  }

  const withDebugpy = inferLaunchConfigs(py, {
    resolvePython: (cmd) => (cmd === 'python3' ? '/usr/bin/python3' : null),
    pythonRunner: () => ({ status: 0 })
  });
  assert.equal(withDebugpy.length, 1);
  assert.equal(withDebugpy[0].name, 'Python Main Script');
  assert.equal(withDebugpy[0].type, 'python');
  assert.equal(withDebugpy[0].program, 'main.py');
  assert.equal(withDebugpy[0].adapterCommand, '/usr/bin/python3');
  assert.deepEqual(withDebugpy[0].adapterArgs, ['-m', 'debugpy.adapter']);

  const empty = makeWorkspace({ 'README.md': 'nothing here' });
  assert.deepEqual(inferLaunchConfigs(empty), []);
});

test('collectWorkspaceFiles skips dependency and build directories', () => {
  const root = makeWorkspace({
    'src/a.ts': 'x',
    'node_modules/pkg/index.js': 'x',
    'dist/bundle.js': 'x',
    '.git/config': 'x'
  });
  const files = collectWorkspaceFiles(root);
  assert.ok(files.includes('src/a.ts'));
  assert.ok(!files.some((f) => f.startsWith('node_modules/')));
  assert.ok(!files.some((f) => f.startsWith('dist/')));
  assert.ok(!files.some((f) => f.startsWith('.git/')));
});

test('inferLaunchConfigsFromNames works without a filesystem for renderer use', () => {
  const names = new Set(['server.ts', 'package.json']);
  const configs = inferLaunchConfigsFromNames(names, () => false, null);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].program, 'server.ts');
});

test('readLaunchConfigs infers configurations when shadrox.debug.json is absent', () => {
  const root = debuggableWorkspace();
  const result = readLaunchConfigs(root);
  assert.equal(result.found, true, 'inferred configs count as a found configuration');
  assert.equal(result.inferred, true);
  assert.equal(result.error, null);
  assert.equal(result.configurations.length, 1);
  assert.equal(result.configurations[0].name, 'Node.js / TypeScript App');
  assert.equal(result.configurations[0].program, 'src/index.js');
  assert.equal(result.resolved.length, 1, 'resolved entries exist so start() can launch them');
});

test('readLaunchConfigs resolves bundled @vscode/js-debug out of the box when workspace has no node_modules adapter', () => {
  const root = makeWorkspace({ 'src/index.js': 'x' });
  const result = readLaunchConfigs(root);
  assert.equal(result.found, true);
  assert.equal(result.inferred, true);
  assert.equal(result.error, null);
  assert.equal(result.configurations.length, 1);
  assert.equal(result.resolved.length, 1);
  assert.match(result.resolved[0].resolvedAdapterCommand, /dapDebugServer\.js$/);
});

test('readLaunchConfigs reports the adapter install hint when no workspace or bundled adapter exists', () => {
  // Program exists, no workspace adapter, and bundledRoots disabled.
  const root = makeWorkspace({ 'src/index.js': 'x' });
  const result = readLaunchConfigs(root, []);
  assert.equal(result.found, true);
  assert.equal(result.inferred, true);
  assert.equal(result.configurations.length, 0);
  assert.match(result.error, /js-debug|adapter/i);
});

test('readLaunchConfigs still prefers the real shadrox.debug.json over inference', () => {
  const root = debuggableWorkspace({
    'shadrox.debug.json': JSON.stringify({
      configurations: [{
        name: 'Custom', type: 'node', request: 'launch',
        program: 'src/index.js', adapterCommand: 'js-debug-adapter'
      }]
    })
  });
  const result = readLaunchConfigs(root);
  assert.equal(result.found, true);
  assert.equal(result.inferred, false);
  assert.equal(result.configurations[0].name, 'Custom');
});

test('readLaunchConfigs keeps the honest empty state when nothing is inferrable', () => {
  const root = makeWorkspace({ 'README.md': 'x' });
  const result = readLaunchConfigs(root);
  assert.equal(result.found, false);
  assert.equal(result.inferred, false);
  assert.deepEqual(result.configurations, []);
});
