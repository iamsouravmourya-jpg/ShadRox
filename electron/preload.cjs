const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shadroxDesktop', Object.freeze({
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  openFiles: () => ipcRenderer.invoke('workspace:open-files'),
  saveFiles: (workspaceId, files) => ipcRenderer.invoke('workspace:save-files', workspaceId, files),
  runCommand: (workspaceId, command) => ipcRenderer.invoke('terminal:run-command', workspaceId, command),
  startPreview: (workspaceId, approval) => ipcRenderer.invoke('preview:start', workspaceId, approval),
  stopPreview: (workspaceId) => ipcRenderer.invoke('preview:stop', workspaceId),
  onPreviewOutput: (listener) => {
    const handler = (_event, output) => listener(output);
    ipcRenderer.on('preview:output', handler);
    return () => ipcRenderer.removeListener('preview:output', handler);
  }
}));
