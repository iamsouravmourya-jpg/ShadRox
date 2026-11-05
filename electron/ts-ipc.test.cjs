const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');

const channels = [
  { channel: 'ts:diagnostics', method: 'diagnostics' },
  { channel: 'ts:definition', method: 'definition' },
  { channel: 'ts:references', method: 'references' },
  { channel: 'ts:exported-contracts', method: 'exportedContracts' },
  { channel: 'ts:outline', method: 'outline' },
  { channel: 'ts:workspace-symbols', method: 'workspaceSymbols' }
];

function handlerBlock(channel) {
  const start = mainSource.indexOf(`'${channel}'`);
  assert.notEqual(start, -1, `${channel} is not registered in main.cjs`);
  const end = mainSource.indexOf('ipcMain.handle(', start + channel.length + 2);
  return mainSource.slice(start, end === -1 ? mainSource.length : end);
}

test('the preload bridge invokes every TypeScript channel', () => {
  assert.match(preloadSource, /Object\.freeze\(/);

  for (const { channel, method } of channels) {
    assert.ok(
      preloadSource.includes(`ipcRenderer.invoke('${channel}'`),
      `preload.cjs must invoke ${channel}`
    );
    assert.match(preloadSource, new RegExp(`\\b${method}:\\s*\\(`), `preload.cjs must expose ${method}`);
  }
});

test('main registers a handler for every TypeScript channel', () => {
  for (const { channel } of channels) {
    assert.ok(
      mainSource.includes(`ipcMain.handle('${channel}'`),
      `main.cjs must register ipcMain.handle for ${channel}`
    );
  }
});

test('every TypeScript handler asserts the trusted renderer first', () => {
  for (const { channel } of channels) {
    const block = handlerBlock(channel);
    assert.match(block, /assertTrustedRenderer\(event\)/, `${channel} must call assertTrustedRenderer`);
  }
});

test('closing a workspace disposes its TypeScript session', () => {
  const start = mainSource.indexOf('function stopWorkspaceServices(');
  assert.notEqual(start, -1, 'stopWorkspaceServices must exist');
  const end = mainSource.indexOf('\n}', start);
  const body = mainSource.slice(start, end === -1 ? mainSource.length : end);
  assert.match(
    body,
    /typeScriptService\.closeWorkspace\(workspaceId\)/,
    'the workspace close path must dispose the TypeScript session'
  );

  const closeBlock = handlerBlock('workspace:close');
  assert.match(
    closeBlock,
    /stopWorkspaceServices\(workspaceId\)/,
    'workspace:close must route through stopWorkspaceServices'
  );
});
