'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createAutomationWebhook } = require('../automation-webhook.cjs');

const SECURE_KEY_PATTERN = /^shadrox\.[a-z0-9._-]{1,80}$/i;
const AUTH_CALLBACK_PATH = '/auth/callback';
const AUTH_TIMEOUT_MS = 180_000;

function authCallbackPage(heading, detail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ShadRox</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0b0b0f; color: #ececf1;
         font-family: "Segoe UI", system-ui, sans-serif; }
  main { text-align: center; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #a1a1aa; font-size: 14px; }
</style></head><body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`;
}

function registerSecureStoreHandlers({ app, ipcMain, safeStorage, assertTrustedRenderer }) {
  const secureStorePath = () => path.join(app.getPath('userData'), 'secure-store.json');

  const readSecureStore = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(secureStorePath(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeSecureStore = (store) => {
    const file = secureStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  };

  ipcMain.handle('secure:get-all', (event) => {
    assertTrustedRenderer(event);
    if (!safeStorage.isEncryptionAvailable()) return {};
    const store = readSecureStore();
    const result = {};
    for (const [key, value] of Object.entries(store)) {
      if (typeof value !== 'string') continue;
      try {
        result[key] = safeStorage.decryptString(Buffer.from(value, 'base64'));
      } catch {
        // Values encrypted under a different OS profile are simply dropped.
      }
    }
    return result;
  });

  ipcMain.handle('secure:set', (event, key, value) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) throw new Error('Invalid settings key.');
    if (typeof value !== 'string' || value.length > 200_000) throw new Error('Invalid settings value.');
    if (!safeStorage.isEncryptionAvailable()) return false;
    const store = readSecureStore();
    store[key] = safeStorage.encryptString(value).toString('base64');
    writeSecureStore(store);
    return true;
  });

  ipcMain.handle('secure:delete', (event, key) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string' || !(key in readSecureStore())) return false;
    const store = readSecureStore();
    delete store[key];
    writeSecureStore(store);
    return true;
  });
}

function registerAuthHandlers({ app, ipcMain, shell, assertTrustedRenderer, getMainWindow }) {
  let pendingAuthSignIn = null;

  const bringMainWindowForward = () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    app.focus({ steal: true });
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    if (process.platform === 'win32') {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);
    } else {
      mainWindow.focus();
    }
  };

  ipcMain.handle('app:version', (event) => {
    assertTrustedRenderer(event);
    return app.getVersion();
  });

  ipcMain.handle('auth:start-loopback', async (event, authorizeUrl, redirectUri) => {
    assertTrustedRenderer(event);
    if (typeof authorizeUrl !== 'string' || typeof redirectUri !== 'string') {
      throw new Error('Invalid sign-in request.');
    }
    let authorize;
    let redirect;
    try {
      authorize = new URL(authorizeUrl);
      redirect = new URL(redirectUri);
    } catch {
      throw new Error('Invalid sign-in request.');
    }
    if (authorize.protocol !== 'https:') throw new Error('Sign-in must use an https URL.');
    const port = Number(redirect.port);
    if (
      redirect.protocol !== 'http:' ||
      redirect.hostname !== '127.0.0.1' ||
      redirect.pathname !== AUTH_CALLBACK_PATH ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    ) {
      throw new Error('Invalid sign-in redirect.');
    }
    if (pendingAuthSignIn) throw new Error('A sign-in is already in progress.');

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingAuthSignIn = null;
        server.close();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ error: 'Sign-in timed out. Please try again.' }), AUTH_TIMEOUT_MS);
      const server = http.createServer((request, response) => {
        let incoming = null;
        try {
          incoming = new URL(request.url || '/', `http://127.0.0.1:${port}`);
        } catch {
          incoming = null;
        }
        if (!incoming || incoming.pathname !== AUTH_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }
        const params = Object.fromEntries(incoming.searchParams.entries());
        const failed = params.error_description || params.error;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          authCallbackPage(
            failed ? 'Sign-in was not completed' : 'Signed in',
            failed ? 'Return to ShadRox and try again.' : 'ShadRox is opening now. You can close this tab.'
          )
        );
        bringMainWindowForward();
        finish(failed ? { error: String(failed).replace(/\+/g, ' ') } : { params });
      });
      server.on('error', (error) => {
        finish({
          error: error && error.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Close the other sign-in window and try again.`
            : 'Could not start the local sign-in listener.'
        });
      });
      server.listen(port, '127.0.0.1', () => {
        pendingAuthSignIn = { port };
        shell.openExternal(authorizeUrl).catch(() => finish({ error: 'Could not open your browser for sign-in.' }));
      });
    });
  });
}

function registerAppAndAutomationHandlers({
  ipcMain,
  nativeTheme,
  assertTrustedRenderer,
  getMainWindow,
  setRendererDirty,
  getUpdater,
  workspaceAccess,
  TITLE_BAR_HEIGHT
}) {
  let automationWebhook = null;
  let automationWebhookWorkspaceId = null;

  function getAutomationWebhook() {
    if (!automationWebhook) {
      automationWebhook = createAutomationWebhook({
        getRoot: () => {
          const workspace = automationWebhookWorkspaceId
            ? workspaceAccess.getWorkspace(automationWebhookWorkspaceId)
            : null;
          return workspace?.root ?? null;
        },
        onTrigger: (trigger) => {
          getMainWindow()?.webContents.send('automation:trigger', trigger);
        }
      });
    }
    return automationWebhook;
  }

  ipcMain.handle('app:set-dirty', (event, dirty) => {
    assertTrustedRenderer(event);
    setRendererDirty(Boolean(dirty));
  });

  ipcMain.handle('app:set-theme', (event, mode) => {
    assertTrustedRenderer(event);
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    nativeTheme.themeSource = mode;
    const mainWindow = getMainWindow();
    if (mainWindow && process.platform !== 'darwin' && !mainWindow.isDestroyed()) {
      const light = nativeTheme.shouldUseDarkColors === false;
      mainWindow.setTitleBarOverlay({
        color: light ? '#f6f7fb' : '#090a0d',
        symbolColor: light ? '#33353d' : '#d4d4d8',
        height: TITLE_BAR_HEIGHT
      });
    }
  });

  ipcMain.handle('updater:check', async (event) => {
    assertTrustedRenderer(event);
    const updater = getUpdater();
    if (!updater?.available) return { available: false };
    await updater.check(true);
    return { available: true };
  });

  ipcMain.handle('automation:webhook-status', (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Error('A workspace id is required to read the automation webhook status.');
    }
    return getAutomationWebhook().status();
  });

  ipcMain.handle('automation:webhook-start', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace?.root) {
      throw new Error('The automation webhook requires an opened workspace.');
    }
    automationWebhookWorkspaceId = workspaceId;
    return getAutomationWebhook().start();
  });

  ipcMain.handle('automation:webhook-stop', async (event) => {
    assertTrustedRenderer(event);
    automationWebhookWorkspaceId = null;
    if (automationWebhook) await automationWebhook.stop();
  });

  return {
    stopAutomationWebhook() {
      if (automationWebhook) {
        void automationWebhook.stop();
        automationWebhook = null;
      }
      automationWebhookWorkspaceId = null;
    }
  };
}

module.exports = {
  registerSecureStoreHandlers,
  registerAuthHandlers,
  registerAppAndAutomationHandlers
};
