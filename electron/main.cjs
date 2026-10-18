const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const { exec } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWorkspaceAccess } = require('./workspace.cjs');

const workspaceAccess = createWorkspaceAccess();
let mainWindow = null;
let backend = null;
let rendererOrigin = null;

function configurePackagedEsbuild() {
  if (!app.isPackaged) return;
  const unpackedAppPath = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
  const executable = process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  process.env.ESBUILD_BINARY_PATH = path.join(
    unpackedAppPath,
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    executable
  );
}

function assertTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Desktop operation rejected for an untrusted renderer.');
  }
}

async function startPackagedBackend() {
  configurePackagedEsbuild();
  const { register } = await import('tsx/esm/api');
  register();
  const serverUrl = pathToFileURL(path.join(app.getAppPath(), 'server.ts')).href;
  const { startServer } = await import(serverUrl);
  return startServer({
    mode: 'production',
    host: '127.0.0.1',
    port: 0,
    staticDirectory: path.join(app.getAppPath(), 'dist')
  });
}

function executeCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0
      });
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle('workspace:open-folder', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open workspace folder',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return workspaceAccess.openFolder(result.filePaths[0]);
  });

  ipcMain.handle('workspace:open-files', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open code files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Code and text files', extensions: ['*'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return workspaceAccess.openFiles(result.filePaths);
  });

  ipcMain.handle('workspace:save-files', async (event, workspaceId, files) => {
    assertTrustedRenderer(event);
    return workspaceAccess.saveFiles(workspaceId, files);
  });

  ipcMain.handle('terminal:run-command', async (event, workspaceId, command) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Terminal commands are available only for an opened folder workspace.');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > 5000) {
      throw new Error('Enter a command between 1 and 5000 characters.');
    }

    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Confirm terminal command',
      message: 'Allow ShadRox to run this command?',
      detail: `${command}\n\nWorking directory: ${workspace.root}\n\nCommands can modify or delete files and access the network.`,
      buttons: ['Cancel', 'Run command'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) throw new Error('Terminal command cancelled.');
    return executeCommand(command, workspace.root);
  });
}

async function createWindow() {
  if (!rendererOrigin) {
    if (app.isPackaged) {
      backend = await startPackagedBackend();
      rendererOrigin = backend.origin;
    } else {
      rendererOrigin = process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000';
    }
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === mainWindow?.webContents && details.isMainFrame && permission === 'media');
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' };
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(rendererOrigin).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(rendererOrigin);
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  console.error('[desktop] failed to start', error);
  dialog.showErrorBox('ShadRox failed to start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', () => {
  if (backend) {
    void backend.close().catch((error) => console.error('[desktop] backend shutdown failed', error));
    backend = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
