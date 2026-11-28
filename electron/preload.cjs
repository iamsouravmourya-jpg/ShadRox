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
  newFile: () => ipcRenderer.invoke('workspace:new-file'),
  createProject: (name) => ipcRenderer.invoke('workspace:new-project', name),
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
  setTheme: (mode) => ipcRenderer.invoke('app:set-theme', mode),
  saveFiles: (id, files) => ipcRenderer.invoke('workspace:save-files', id, files),
  backupFile: (id, path, content) => ipcRenderer.invoke('workspace:backup-file', id, path, content),
  stageFiles: (id, files) => ipcRenderer.invoke('workspace:stage-files', id, files),
  commitTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:commit', id, transactionId),
  discardTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:discard', id, transactionId),
  beginMachineTurn: (id, checkpointId) => ipcRenderer.invoke('machine:begin', id, checkpointId),
  finishMachineTurn: (id, checkpointId) => ipcRenderer.invoke('machine:finish', id, checkpointId),
  inspectMachineTurn: (id, checkpointId) => ipcRenderer.invoke('machine:inspect', id, checkpointId),
  restoreMachineTurn: (id, checkpointId) => ipcRenderer.invoke('machine:restore', id, checkpointId),
  exportMachineReceipt: (id, checkpointId) => ipcRenderer.invoke('machine:export-receipt', id, checkpointId),
  verifyMachineReceipt: (id, receiptId) => ipcRenderer.invoke('machine:verify-receipt', id, receiptId),
  verifyChangeSet: (id, files) => ipcRenderer.invoke('workspace:verify-change-set', id, files),
  readWorkspaceCache: (id, key) => ipcRenderer.invoke('workspace:read-cache', id, key),
  writeWorkspaceCache: (id, key, data) => ipcRenderer.invoke('workspace:write-cache', id, key, data),
  onWorkspaceChange: (listener) => subscribe('workspace:change', listener),
  runCommand: (id, command, riskNotice) => ipcRenderer.invoke('terminal:run-command', id, command, riskNotice),
  jobControl: (id, request) => ipcRenderer.invoke('job:control', id, request),
  assertPreview: (id, options) => ipcRenderer.invoke('preview:assert', id, options),
  previewInspect: (id, request) => ipcRenderer.invoke('preview-inspect:run', id, request),
  gitRead: (id) => ipcRenderer.invoke('git:read', id),
  gitConflicts: (id) => ipcRenderer.invoke('git:conflicts', id),
  gitScmRead: (id) => ipcRenderer.invoke('git:scm-read', id),
  gitStage: (id, paths) => ipcRenderer.invoke('git:stage', id, paths),
  gitUnstage: (id, paths) => ipcRenderer.invoke('git:unstage', id, paths),
  gitCommit: (id, message) => ipcRenderer.invoke('git:commit', id, message),
  gitBranches: (id) => ipcRenderer.invoke('git:branches', id),
  gitCheckout: (id, branch) => ipcRenderer.invoke('git:checkout', id, branch),
  gitFileDiff: (id, path, staged) => ipcRenderer.invoke('git:file-diff', id, path, staged),
  gitPush: (id) => ipcRenderer.invoke('git:push', id),
  gitPull: (id) => ipcRenderer.invoke('git:pull', id),
  gitSync: (id) => ipcRenderer.invoke('git:sync', id),
  gitDiscard: (id, paths) => ipcRenderer.invoke('git:discard', id, paths),
  diagnostics: (id, overrides, files) => ipcRenderer.invoke('ts:diagnostics', id, overrides, files),
  definition: (id, path, line, character, overrides) => ipcRenderer.invoke('ts:definition', id, path, line, character, overrides),
  references: (id, path, line, character, overrides) => ipcRenderer.invoke('ts:references', id, path, line, character, overrides),
  exportedContracts: (id, paths, overrides) => ipcRenderer.invoke('ts:exported-contracts', id, paths, overrides),
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
  onJobOutput: (listener) => subscribe('terminal:job-output', listener),
  onJobEvent: (listener) => subscribe('terminal:job', listener),
  startPreview: (id, approval) => ipcRenderer.invoke('preview:start', id, approval),
  stopPreview: (id) => ipcRenderer.invoke('preview:stop', id),
  getPreviewStatus: (id) => ipcRenderer.invoke('preview:status', id),
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
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  onUpdaterStatus: (listener) => subscribe('updater:status', listener),
  // The signed proof chain. Receipts recorded here are appended to the
  // main-process ledger before the call resolves, and `receipts` replays that
  // ledger after a restart.
  proof: Object.freeze({
    appendReceipt: (receipt, kind) => ipcRenderer.invoke('proof:append-receipt', receipt, kind),
    appendMilestone: (proof) => ipcRenderer.invoke('proof:append-milestone', proof),
    receipts: () => ipcRenderer.invoke('proof:receipts'),
    records: (workspaceId) => ipcRenderer.invoke('proof:records', workspaceId),
    verify: (workspaceId) => ipcRenderer.invoke('proof:verify', workspaceId)
  }),
  secureStore: Object.freeze({
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key)
  }),
  auth: Object.freeze({
    startLoopback: (authorizeUrl, redirectUri) => ipcRenderer.invoke('auth:start-loopback', authorizeUrl, redirectUri),
    appVersion: () => ipcRenderer.invoke('app:version')
  }),
  logs: Object.freeze({
    getRecent: (limit) => ipcRenderer.invoke('logs:getRecent', limit),
    record: (entry) => ipcRenderer.invoke('logs:record', entry)
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
