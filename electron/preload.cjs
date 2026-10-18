const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shadroxDesktop', Object.freeze({
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  openFiles: () => ipcRenderer.invoke('workspace:open-files'),
  saveFiles: (workspaceId, files) => ipcRenderer.invoke('workspace:save-files', workspaceId, files),
  runCommand: (workspaceId, command) => ipcRenderer.invoke('terminal:run-command', workspaceId, command)
}));
