const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');

let serverProcess = null;

function startServer() {
  // Start the Express server (handles API routes)
  const serverScript = path.join(__dirname, 'server.ts');
  
  serverProcess = spawn('npx', ['tsx', serverScript], {
    cwd: __dirname,
    env: { ...process.env, PORT: '3000' },
    shell: true
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server Error: ${data}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#05060A',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  // Load from local server (Express serves both API and static files)
  // Wait a moment for server to start
  setTimeout(() => {
    win.loadURL('http://localhost:3000');
  }, 2000);

  // Open DevTools for debugging
  win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  // Auto-update check
  autoUpdater.checkForUpdatesAndNotify();

  // Update downloaded event handler
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new enterprise-grade update for Devora Studio has been downloaded in the background. Restarting application now to apply updates...',
      buttons: ['Restart and Update']
    }).then(() => {
      autoUpdater.quitAndInstall();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Kill server process when app quits
    if (serverProcess) {
      serverProcess.kill();
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  // Kill server process before app quits
  if (serverProcess) {
    serverProcess.kill();
  }
});
