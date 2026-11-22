const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net: electronNet, protocol, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkspaceAccess } = require('./workspace.cjs');
const { createWorkspaceConsent } = require('./workspace-consent.cjs');
const {
  buildGitArgv,
  extractFolderArgument,
  isSameOriginAsRenderer,
  isTrustedRendererEvent
} = require('./desktop-security.cjs');
const { createPreviewRuntime } = require('./preview-runtime.cjs');
const { createUpdater } = require('./updater.cjs');
const { createTypeScriptService } = require('./ts-service.cjs');
const { createProofStore } = require('./proof-store.cjs');
const { createProofKeyring } = require('./proof-keyring.cjs');
const { createProofService, PROOF_APP_SCOPE } = require('./proof-service.cjs');
const { createConsoleErrorSink } = require('./preview-assert.cjs');
const { createMachineDelta, LIMITS: MACHINE_LIMITS } = require('./machine-delta.cjs');
const { createMachineGit } = require('./machine-git.cjs');
const { createMachineReceipt } = require('./machine-receipt.cjs');
const { createDebugHost } = require('./debug-host.cjs');

const { PREVIEW_SCHEME, APP_SCHEME, APP_ORIGIN, createPreviewProtocolService } = require('./ipc/previewProtocol.cjs');
const { createCommandProofRecorder, registerProofHandlers, registerDebugHandlers } = require('./ipc/debugProofIpc.cjs');
const { createGitService } = require('./ipc/gitIpc.cjs');
const { registerSecureStoreHandlers, registerAuthHandlers, registerAppAndAutomationHandlers } = require('./ipc/authAppIpc.cjs');
const { registerMcpHandlers } = require('./ipc/mcpIpc.cjs');
const { registerPreviewRuntimeHandlers } = require('./ipc/previewRuntimeIpc.cjs');
const { createWorkspaceService } = require('./ipc/workspaceIpc.cjs');
const { commandJobs, killProcessTree, registerTerminalAndJobHandlers } = require('./ipc/terminalJobsIpc.cjs');

const APP_BACKGROUND = '#090a0d';
const TITLE_BAR_HEIGHT = 48;

app.setAppUserModelId('com.shadrox.desktop');
nativeTheme.themeSource = 'system';

// AMD drivers on Windows can terminate Electron's GPU process with E_INVALIDARG
// (0x80070057). Software compositing keeps the preview surface stable.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const workspaceAccess = createWorkspaceAccess();
const workspaceConsent = createWorkspaceConsent({
  storageFile: path.join(app.getPath('userData'), 'workspace-consent.json')
});
const terminalSessions = new Map();
let activeWorkspaceId = null;
let mainWindow = null;
let updater = null;
let rendererDirty = false;
let allowClose = false;
let backend = null;
let rendererOrigin = null;
let machineSensitiveOperations = 0;

function assertTrustedRenderer(event) {
  if (!isTrustedRendererEvent(event, mainWindow, rendererOrigin)) {
    throw new Error('Desktop operation rejected for an untrusted renderer.');
  }
}

function handleMachineSensitive(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    machineDelta.assertWritable();
    machineSensitiveOperations++;
    try { return await handler(...args); }
    finally { machineSensitiveOperations--; }
  });
}

const previewRuntime = createPreviewRuntime({
  onOutput: (output) => mainWindow?.webContents.send('preview:output', output),
  onBackendOutput: (output) => mainWindow?.webContents.send('preview:backend-output', output),
  orphansFile: path.join(app.getPath('userData'), 'preview-orphans.json')
});
const typeScriptService = createTypeScriptService({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id)
});
const gitService = createGitService({ workspaceAccess });
const machineGit = createMachineGit({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id),
  context: gitService.gitSafetyContext,
  run: (root, args, safety, input) =>
    gitService.runGit(root, buildGitArgv(args, { safeDirectories: [root], filterDrivers: safety.filterDrivers }), input)
});
const machineDelta = createMachineDelta({
  access: workspaceAccess,
  readSystem: async (id) => ({
    git: await machineGit.read(id),
    previews: previewRuntime.ownedPreviews(id),
    terminals: [...terminalSessions].filter(([, info]) => info.workspaceId === id)
      .map(([sessionId, info]) => ({ id: sessionId, mode: info.mode, launchCwd: info.launchCwd })),
    tools: { node: process.versions.node, electron: process.versions.electron, probes: 'External tool version commands were not run.' }
  }),
  prepareGitRestore: machineGit.prepare,
  stopOwnedPreview: (id, identity) => previewRuntime.stopOwnedPreview(id, identity)
});

const proofStore = createProofStore({
  root: path.join(app.getPath('userData'), 'proof-ledgers'),
  safeStorage
});
const proofKeyring = createProofKeyring({
  dir: path.join(app.getPath('userData'), 'proof-keys'),
  safeStorage
});
const proofService = createProofService({ store: proofStore, keyring: proofKeyring });
const recordCommandProof = createCommandProofRecorder({ proofService });

const bundledDebugRoots = [
  path.join(__dirname, 'vendor', 'js-debug'),
  path.join(app.getAppPath(), 'electron', 'vendor', 'js-debug'),
  ...(typeof process.resourcesPath === 'string' && process.resourcesPath
    ? [path.join(process.resourcesPath, 'js-debug'), process.resourcesPath]
    : [])
];

const debugHost = createDebugHost({
  getWorkspace: (id) => workspaceAccess.getWorkspace(id),
  bundledRoots: bundledDebugRoots,
  broadcast: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('debug:event', event);
    }
  }
});
const previewConsoleErrors = createConsoleErrorSink();
const machineReceipt = createMachineReceipt({
  access: workspaceAccess,
  receiptsDir: path.join(app.getPath('userData'), 'machine-receipts'),
  getReport: (id, checkpointId) => machineDelta.inspect(id, checkpointId),
  limits: MACHINE_LIMITS
});

const previewProtocol = createPreviewProtocolService({
  app,
  electronNet,
  protocol,
  session,
  workspaceAccess,
  previewRuntime,
  previewConsoleErrors,
  getMainWindow: () => mainWindow,
  getRendererOrigin: () => rendererOrigin,
  getBackend: () => backend
});

const workspaceService = createWorkspaceService({
  app,
  dialog,
  ipcMain,
  workspaceAccess,
  workspaceConsent,
  previewRuntime,
  debugHost,
  typeScriptService,
  machineDelta,
  machineReceipt,
  terminalSessions,
  commandJobs,
  killProcessTree,
  assertTrustedRenderer,
  handleMachineSensitive,
  getMainWindow: () => mainWindow,
  getActiveWorkspaceId: () => activeWorkspaceId,
  setActiveWorkspaceId: (id) => { activeWorkspaceId = id; },
  getRendererDirty: () => rendererDirty,
  getMachineSensitiveOperations: () => machineSensitiveOperations
});

let mcpController = null;
let appAutomationController = null;

function runtimeConfigPath() {
  return path.join(app.getPath('userData'), 'runtime.json');
}

function readStoredPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath(), 'utf8'));
    const port = Number(parsed?.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function storePort(port) {
  try {
    fs.mkdirSync(path.dirname(runtimeConfigPath()), { recursive: true });
    fs.writeFileSync(runtimeConfigPath(), JSON.stringify({ port }), 'utf8');
  } catch (error) {
    console.warn('[runtime] could not persist local port', error);
  }
}

async function startPackagedBackend() {
  require('bytenode');
  const appPath = app.getAppPath();
  const { startServer } = require(path.join(appPath, 'server.jsc'));
  const options = {
    mode: 'production',
    host: '127.0.0.1',
    staticDirectory: path.join(appPath, 'dist')
  };

  const storedPort = readStoredPort();
  const candidates = [...new Set([storedPort, 43121, 43122, 43123].filter((port) => Number.isInteger(port) && port > 0))];

  for (const port of candidates) {
    try {
      const serverBackend = await startServer({ ...options, port });
      const actualPort = Number(new URL(serverBackend.origin).port);
      if (actualPort !== storedPort) storePort(actualPort);
      return serverBackend;
    } catch (error) {
      console.warn(`[runtime] local port ${port} unavailable, trying next`, error instanceof Error ? error.message : error);
    }
  }

  const serverBackend = await startServer({ ...options, port: 0 });
  storePort(Number(new URL(serverBackend.origin).port));
  return serverBackend;
}

async function handleSecondInstanceLaunch(argv, workingDirectory) {
  if (!mainWindow) {
    await createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }

  const folder = extractFolderArgument(argv, {
    workingDirectory,
    applicationDirectory: path.dirname(app.getPath('exe'))
  });
  if (!folder) return;
  if (activeWorkspaceId) {
    if (workspaceAccess.getWorkspace(activeWorkspaceId)?.root === folder) return;
    mainWindow?.webContents.send('preview:output', {
      workspaceId: activeWorkspaceId,
      type: 'status',
      message: `Another ShadRox asked to open ${folder}. Open it from Recents to switch workspaces.`
    });
    return;
  }
  try {
    await workspaceService.openFolderWorkspace(folder);
  } catch (error) {
    console.warn('[desktop] second-instance folder could not be opened', error);
  }
}

async function createWindow() {
  if (!rendererOrigin) {
    if (app.isPackaged) {
      backend = await startPackagedBackend();
      rendererOrigin = APP_ORIGIN;
    } else {
      rendererOrigin = process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000';
    }
  }

  const appIcon = path.join(__dirname, '..', 'assets', 'icon.png');
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'ShadRox',
    backgroundColor: APP_BACKGROUND,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(fs.existsSync(appIcon) ? { icon: appIcon } : {}),
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 15 } }
      : {
          titleBarOverlay: {
            color: APP_BACKGROUND,
            symbolColor: '#d4d4d8',
            height: TITLE_BAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowed = permission === 'media' || permission === 'clipboard-sanitized-write';
    return Boolean(
      allowed &&
      webContents === mainWindow?.webContents &&
      isSameOriginAsRenderer(requestingOrigin, rendererOrigin)
    );
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = permission === 'media' || permission === 'clipboard-sanitized-write';
    callback(webContents === mainWindow?.webContents && details.isMainFrame && allowed);
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (allowClose || !rendererDirty || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Unsaved changes',
      message: 'You have unsaved changes in ShadRox.',
      detail: 'Save your files before closing, or close and lose those edits.'
    });
    if (choice === 1) {
      allowClose = true;
      return;
    }
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      };
    }
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameOriginAsRenderer(url, rendererOrigin)) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.error('[renderer] failed to load', { errorCode, errorDescription, validatedURL });
    }
  });
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error('[renderer] console error', details.message);
    }
    const workspaceId = previewProtocol.getPreviewWorkspaceIdForUrl(details.frame?.url || '');
    if (!workspaceId || typeof details.message !== 'string') return;
    const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : 'log';
    if (level === 'error') previewConsoleErrors.record(workspaceId, details.message);
    mainWindow?.webContents.send('preview:output', {
      workspaceId,
      type: 'console',
      message: `[preview ${level}] ${details.message}`
    });
  });
  mainWindow.on('closed', () => {
    debugHost.disposeAll();
    mainWindow = null;
  });

  await mainWindow.loadURL(rendererOrigin);
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void handleSecondInstanceLaunch(argv, workingDirectory).catch((error) => {
      console.warn('[desktop] second-instance request failed', error);
    });
  });
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  previewProtocol.allowLoopbackPreviewCertificates();
  previewProtocol.installPreviewRequestGuard();
  previewProtocol.installRendererCsp();
  protocol.handle(PREVIEW_SCHEME, previewProtocol.handlePreviewRequest);
  previewProtocol.installAppProtocol();

  gitService.locateGitExecutable();
  workspaceService.registerWorkspaceHandlers();
  registerTerminalAndJobHandlers({
    dialog,
    shell,
    handleMachineSensitive,
    assertTrustedRenderer,
    workspaceAccess,
    terminalSessions,
    getMainWindow: () => mainWindow,
    recordCommandProof
  });
  gitService.registerGitHandlers({ handleMachineSensitive, assertTrustedRenderer });
  registerSecureStoreHandlers({ app, ipcMain, safeStorage, assertTrustedRenderer });
  registerProofHandlers({
    ipcMain,
    assertTrustedRenderer,
    proofService,
    workspaceAccess,
    getActiveWorkspaceId: () => activeWorkspaceId,
    PROOF_APP_SCOPE
  });
  registerDebugHandlers({
    ipcMain,
    assertTrustedRenderer,
    debugHost,
    dialog,
    app,
    bundledDebugRoots,
    getMainWindow: () => mainWindow
  });
  registerAuthHandlers({
    app,
    ipcMain,
    shell,
    assertTrustedRenderer,
    getMainWindow: () => mainWindow
  });
  appAutomationController = registerAppAndAutomationHandlers({
    ipcMain,
    nativeTheme,
    assertTrustedRenderer,
    getMainWindow: () => mainWindow,
    setRendererDirty: (dirty) => { rendererDirty = dirty; },
    getUpdater: () => updater,
    workspaceAccess,
    TITLE_BAR_HEIGHT
  });
  mcpController = registerMcpHandlers({
    app,
    dialog,
    ipcMain,
    safeStorage,
    assertTrustedRenderer,
    getMainWindow: () => mainWindow
  });
  registerPreviewRuntimeHandlers({
    BrowserWindow,
    dialog,
    ipcMain,
    handleMachineSensitive,
    assertTrustedRenderer,
    workspaceAccess,
    previewRuntime,
    startProtocolPreview: previewProtocol.startProtocolPreview,
    runPreviewAssertion: previewProtocol.runPreviewAssertion,
    getMainWindow: () => mainWindow
  });

  await createWindow();
  updater = createUpdater({
    app,
    dialog,
    broadcast: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status', payload);
      }
    },
    log: (message) => console.warn('[updater]', message)
  });
  updater.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  console.error('[desktop] failed to start', error);
  dialog.showErrorBox('ShadRox failed to start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', () => {
  debugHost.disposeAll();
  void previewRuntime.stopAll();
  appAutomationController?.stopAutomationWebhook();
  mcpController?.closeAll();
  workspaceService.stopAllWatchers();
  if (backend) {
    void backend.close().catch((error) => console.error('[desktop] backend shutdown failed', error));
    backend = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
