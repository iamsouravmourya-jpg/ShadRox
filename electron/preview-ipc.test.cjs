const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerPreviewRuntimeHandlers } = require('./ipc/previewRuntimeIpc.cjs');

function createHarness(root) {
  const handlers = new Map();
  const startedProjects = [];
  registerPreviewRuntimeHandlers({
    BrowserWindow: { fromWebContents: () => null },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showSaveDialog: async () => ({ canceled: true })
    },
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn)
    },
    handleMachineSensitive: (channel, fn) => handlers.set(channel, fn),
    assertTrustedRenderer: () => {},
    workspaceAccess: {
      getWorkspace: (workspaceId) => (workspaceId === 'ws' ? { root, mode: 'folder' } : undefined)
    },
    previewRuntime: {
      start: async (_workspaceId, projectRoot, manifestHash) => {
        startedProjects.push({ projectRoot, manifestHash });
        return { status: 'ready', url: 'http://127.0.0.1:4173/', script: 'dev', hmr: true };
      },
      stop: async () => true,
      getStatus: () => ({ running: false, status: 'idle', url: null, port: null, script: null, hmr: false, lastError: null, recentOutput: '' }),
      startPlan: async () => ({ url: 'http://127.0.0.1:3001/' }),
      stopBackend: async () => true
    },
    startProtocolPreview: async () => ({ status: 'ready', url: 'shadrox-preview://root/' }),
    runPreviewAssertion: async () => ({ ok: true }),
    getMainWindow: () => ({ webContents: { send: () => {} } })
  });

  const invokeStart = (approval = {}) => handlers.get('preview:start')({ sender: {} }, 'ws', approval);
  return { invokeStart, startedProjects };
}

test('preview:start automatically prefers root "." when both root and nested runnable package.json exist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-prev-ipc-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root-app', scripts: { dev: 'vite' } }));
    fs.mkdirSync(path.join(root, 'landing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'landing', 'package.json'), JSON.stringify({ name: 'landing', scripts: { dev: 'vite' } }));

    const { invokeStart, startedProjects } = createHarness(root);
    const result = await invokeStart();
    assert.equal(result.status, 'ready');
    assert.equal(startedProjects.length, 1);
    assert.equal(path.resolve(startedProjects[0].projectRoot), path.resolve(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preview:start still returns selection-required when multiple nested projects exist with no root project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-prev-nested-'));
  try {
    fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }));
    fs.writeFileSync(path.join(root, 'apps', 'docs', 'package.json'), JSON.stringify({ name: 'docs', scripts: { dev: 'vite' } }));

    const { invokeStart, startedProjects } = createHarness(root);
    const result = await invokeStart();
    assert.equal(result.status, 'selection-required');
    assert.equal(result.projects.length, 2);
    assert.equal(startedProjects.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
