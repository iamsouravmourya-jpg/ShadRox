const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('shadroxDesktop', Object.freeze({
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  openFiles: () => ipcRenderer.invoke('workspace:open-files'),
  reopenWorkspace: (target) => ipcRenderer.invoke('workspace:reopen', target),
  closeWorkspace: (id) => ipcRenderer.invoke('workspace:close', id),
  listDirectory: (id, path, cursor) => ipcRenderer.invoke('workspace:list-directory', id, path, cursor),
  readFile: (id, path) => ipcRenderer.invoke('workspace:read-file', id, path),
  renameFile: (id, fromPath, toPath) => ipcRenderer.invoke('workspace:rename-file', id, fromPath, toPath),
  searchFiles: (id, query, limit) => ipcRenderer.invoke('workspace:search-files', id, query, limit),
  setDirty: (dirty) => ipcRenderer.invoke('app:set-dirty', dirty),
  saveFiles: (id, files) => ipcRenderer.invoke('workspace:save-files', id, files),
  stageFiles: (id, files) => ipcRenderer.invoke('workspace:stage-files', id, files),
  commitTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:commit', id, transactionId),
  discardTransaction: (id, transactionId) => ipcRenderer.invoke('workspace:discard', id, transactionId),
  onWorkspaceChange: (listener) => subscribe('workspace:change', listener),
  runCommand: (id, command) => ipcRenderer.invoke('terminal:run-command', id, command),
  gitRead: (id) => ipcRenderer.invoke('git:read', id),
  createTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:create', id, cols, rows),
  writeTerminal: (id, sessionId, data) => ipcRenderer.invoke('terminal:write', id, sessionId, data),
  resizeTerminal: (id, sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', id, sessionId, cols, rows),
  closeTerminal: (id, sessionId) => ipcRenderer.invoke('terminal:close', id, sessionId),
  onTerminalOutput: (listener) => subscribe('terminal:output', listener),
  startPreview: (id, approval) => ipcRenderer.invoke('preview:start', id, approval),
  stopPreview: (id) => ipcRenderer.invoke('preview:stop', id),
  onPreviewOutput: (listener) => subscribe('preview:output', listener),
  secureStore: Object.freeze({
    getAll: () => ipcRenderer.invoke('secure:get-all'),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key) => ipcRenderer.invoke('secure:delete', key)
  })
}));
