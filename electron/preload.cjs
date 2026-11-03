const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const shadroxDesktop = Object.freeze({
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  openFiles: () => ipcRenderer.invoke('workspace:open-files'),
  reopenWorkspace: (target) => ipcRenderer.invoke('workspace:reopen', target),
  closeWorkspace: (id) => ipcRenderer.invoke('workspace:close', id),
  listDirectory: (id, path, cursor) => ipcRenderer.invoke('workspace:list-directory', id, path, cursor),
  readFile: (id, path) => ipcRenderer.invoke('workspace:read-file', id, path),
  loadFiles: (id, paths, options) => ipcRenderer.invoke('workspace:load-files', id, paths, options),
  projectDocs: (id) => ipcRenderer.invoke('workspace:project-docs', id),
  renameFile: (id, fromPath, toPath) => ipcRenderer.invoke('workspace:rename-file', id, fromPath, toPath),
  createDirectory: (id, path) => ipcRenderer.invoke('workspace:create-directory', id, path),
  deletePath: (id, path) => ipcRenderer.invoke('workspace:delete-path', id, path),
  searchFiles: (id, query, limit) => ipcRenderer.invoke('workspace:search-files', id, query, limit),
  searchContent: (id, options) => ipcRenderer.invoke('workspace:search-content', id, options),
  setDirty: (dirty) => ipcRenderer.invoke('app:set-dirty', dirty),
  saveFiles: (id, files) => ipcRenderer.invoke('workspace:save-files', id, files),
  stageFiles: (id, files) => ipcRenderer.invoke('workspace:stage-files', id, files),
  commitTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:commit', id, transactionId),
  discardTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:discard', id, transactionId),
  verifyChangeSet: (id, files) => ipcRenderer.invoke('workspace:verify-change-set', id, files),
  onWorkspaceChange: (listener) => subscribe('workspace:change', listener),
  runCommand: (id, command) => ipcRenderer.invoke('terminal:run-command', id, command),
  gitRead: (id) => ipcRenderer.invoke('git:read', id),
  gitConflicts: (id) => ipcRenderer.invoke('git:conflicts', id),
  gitScmRead: (id) => ipcRenderer.invoke('git:scm-read', id),
  gitStage: (id, paths) => ipcRenderer.invoke('git:stage', id, paths),
  gitUnstage: (id, paths) => ipcRenderer.invoke('git:unstage', id, paths),
  gitCommit: (id, message) => ipcRenderer.invoke('git:commit', id, message),
  gitBranches: (id) => ipcRenderer.invoke('git:branches', id),
  gitCheckout: (id, branch) => ipcRenderer.invoke('git:checkout', id, branch),
  gitFileDiff: (id, path, staged) => ipcRenderer.invoke('git:file-diff', id, path, staged),
  diagnostics: (id, overrides, files) => ipcRenderer.invoke('ts:diagnostics', id, overrides, files),
  definition: (id, path, line, character, overrides) => ipcRenderer.invoke('ts:definition', id, path, line, character, overrides),
  references: (id, path, line, character, overrides) => ipcRenderer.invoke('ts:references', id, path, line, character, overrides),
  rename: (id, path, line, character, newName, overrides) => ipcRenderer.invoke('ts:rename', id, path, line, character, newName, overrides),
  codeActions: (id, path, startLine, startCharacter, endLine, endCharacter, overrides) =>
    ipcRenderer.invoke('ts:code-actions', id, path, startLine, startCharacter, endLine, endCharacter, overrides),
  semanticTokens: (id, path, overrides) => ipcRenderer.invoke('ts:semantic-tokens', id, path, overrides),
  outline: (id, path, overrides) => ipcRenderer.invoke('ts:outline', id, path, overrides),
  workspaceSymbols: (id, query, overrides) => ipcRenderer.invoke('ts:workspace-symbols', id, query, overrides),
  createTerminal: (id, cols, rows, mode, sessionKey) => ipcRenderer.invoke('terminal:create', id, cols, rows, mode, sessionKey),
  writeTerminal: (id, sessionId, data) => ipcRenderer.invoke('terminal:write', id, sessionId, data),
  resizeTerminal: (id, sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', id, sessionId, cols, rows),
  closeTerminal: (id, sessionId) => ipcRenderer.invoke('terminal:close', id, sessionId),
  listTerminalSessions: (id) => ipcRenderer.invoke('terminal:list-sessions', id),
  openTerminalLink: (url) => ipcRenderer.invoke('terminal:open-link', url),
  onTerminalOutput: (listener) => subscribe('terminal:output', listener),
  onTerminalRun: (listener) => subscribe('terminal:run', listener),
  startPreview: (id, approval) => ipcRenderer.invoke('preview:start', id, approval),
  stopPreview: (id) => ipcRenderer.invoke('preview:stop', id),
  capturePreviewPage: (rect) => ipcRenderer.invoke('preview:capture-page', rect),
  savePreviewScreenshot: (dataUrl) => ipcRenderer.invoke('preview:save-screenshot', dataUrl),
  onPreviewOutput: (listener) => subscribe('preview:output', listener),
  listMcpServers: () => ipcRenderer.invoke('mcp:list-servers'),
  saveMcpServer: (server) => ipcRenderer.invoke('mcp:save-server', server),
  deleteMcpServer: (id) => ipcRenderer.invoke('mcp:delete-server', id),
  connectMcpServer: (id) => ipcRenderer.invoke('mcp:connect', id),
  listMcpTools: (serverId) => ipcRenderer.invoke('mcp:list-tools', serverId),
  callMcpTool: (serverId, name, args) => ipcRenderer.invoke('mcp:call-tool', serverId, name, args),
  disconnectMcpServer: (id) => ipcRenderer.invoke('mcp:disconnect', id),
  scanPlugins: (id) => ipcRenderer.invoke('plugins:scan', id),
  detectRuntimes: (id) => ipcRenderer.invoke('runtime:detect', id),
  startBackendPreview: (id, port) => ipcRenderer.invoke('preview:start-backend', id, port),
  stopBackendPreview: (id) => ipcRenderer.invoke('preview:stop-backend', id),
  onBackendPreviewOutput: (listener) => subscribe('preview:backend-output', listener),
  automationWebhookStatus: (id) => ipcRenderer.invoke('automation:webhook-status', id),
  startAutomationWebhook: (id) => ipcRenderer.invoke('automation:webhook-start', id),
  stopAutomationWebhook: () => ipcRenderer.invoke('automation:webhook-stop'),
  onAutomationTrigger: (listener) => subscribe('automation:trigger', listener),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  onUpdaterStatus: (listener) => subscribe('updater:status', listener),
  secureStore: Object.freeze({
    getAll: () => ipcRenderer.invoke('secure:get-all'),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key)
  }),
  auth: Object.freeze({
    startLoopback: (authorizeUrl, redirectUri) => ipcRenderer.invoke('auth:start-loopback', authorizeUrl, redirectUri),
    appVersion: () => ipcRenderer.invoke('app:version')
  })
});

// Electron injects this script into every frame of the webContents, and the
// preview iframes render workspace-authored code, so exposing the bridge there
// would hand the terminal, the decrypted key store and the folder picker to the
// opened folder. Only ShadRox's own top-level document gets it; main.cjs
// re-checks frame identity and origin on every call as a second layer.
const isTopFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

if (isTopFrame) {
  contextBridge.exposeInMainWorld('shadroxDesktop', shadroxDesktop);
}
