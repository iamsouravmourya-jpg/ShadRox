'use strict';

/**
 * Automatic updates over GitHub Releases (electron-updater).
 *
 * Update failures are sent to the renderer so beta testers can report them.
 * Unsigned artifacts must never install themselves without an explicit user
 * action.
 */

const STARTUP_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATABLE_PLATFORMS = ['win32', 'darwin'];

function createUpdater({
  app,
  dialog,
  broadcast,
  log = () => {},
  autoUpdater: injected,
  platform = process.platform
}) {
  const inactive = {
    available: false,
    check: async () => ({ skipped: true }),
    start: () => {},
    dispose: () => {}
  };

  if (!app.isPackaged || !UPDATABLE_PLATFORMS.includes(platform)) return inactive;

  const autoUpdater = injected || require('electron-updater').autoUpdater;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: log };

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }));  autoUpdater.on('update-available', (info) => broadcast({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => broadcast({ state: 'up-to-date' }));
  autoUpdater.on('download-progress', (progress) =>
    broadcast({ state: 'downloading', percent: Math.round(progress.percent ?? 0) })
  );
  autoUpdater.on('error', (error) => {
    log(`update check failed: ${error?.message || error}`);
    broadcast({ state: 'error', message: String(error?.message || error) });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    broadcast({ state: 'ready', version: info.version });
    const choice = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'ShadRox update ready',
      message: `ShadRox ${info.version} is ready.`,
      detail: 'Restart to finish the update. Your chat history and API keys stay put.'
    });
    if (choice.response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
  });

  let handles = null;

  async function check(manual = false) {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (manual && !result) broadcast({ state: 'up-to-date' });
      return result || null;
    } catch (error) {
      log(`update check failed: ${error?.message || error}`);
      return null;
    }
  }

  function start() {
    if (handles) return;
    const timeout = setTimeout(() => void check(), STARTUP_DELAY_MS);
    const interval = setInterval(() => void check(), RECHECK_INTERVAL_MS);
    timeout.unref();
    interval.unref();
    handles = { timeout, interval };
  }

  function dispose() {
    if (!handles) return;
    clearTimeout(handles.timeout);
    clearInterval(handles.interval);
    handles = null;
  }

  return {
    available: true,
    check: (manual = false) => check(Boolean(manual)),
    start,
    dispose
  };
}

module.exports = { createUpdater, STARTUP_DELAY_MS, RECHECK_INTERVAL_MS };
