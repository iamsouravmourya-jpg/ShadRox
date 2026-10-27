const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createUpdater } = require('./updater.cjs');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.logger = null;
    this.checks = 0;
    this.installs = 0;
    this.outcome = null;
  }

  async checkForUpdates() {
    this.checks += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

function harness({ isPackaged = true, platform = 'win32', dialogResponse = 1 } = {}) {
  const events = [];
  const dialogs = [];
  const logs = [];
  const fake = new FakeUpdater();
  const updater = createUpdater({
    app: { isPackaged },
    platform,
    autoUpdater: fake,
    broadcast: (payload) => events.push(payload),
    log: (message) => logs.push(message),
    dialog: {
      async showMessageBox(options) {
        dialogs.push(options);
        return { response: dialogResponse };
      }
    }
  });
  return { updater, fake, events, dialogs, logs };
}

test('development and browser builds get no updater at all', () => {
  const dev = harness({ isPackaged: false });
  assert.equal(dev.updater.available, false);
  dev.updater.start();
  assert.equal(dev.fake.checks, 0, 'an unpackaged app must not contact the release feed');

  const linux = harness({ platform: 'linux' });
  assert.equal(linux.updater.available, false);
});

test('a packaged app checks, downloads and reports progress to the renderer', async () => {
  const { updater, fake, events } = harness();
  updater.start();
  updater.dispose();

  fake.outcome = { updateInfo: { version: '0.4.0' } };
  await updater.check();
  assert.equal(fake.autoDownload, true, 'beta testers should not have to fetch the build by hand');
  assert.equal(fake.autoInstallOnAppQuit, true);
  assert.equal(fake.checks, 1);

  fake.emit('update-available', { version: '0.4.0' });
  fake.emit('download-progress', { percent: 42.7 });
  assert.deepEqual(events, [
    { state: 'available', version: '0.4.0' },
    { state: 'downloading', percent: 43 }
  ]);
});

/** The downloaded-update handler resolves through two awaits before it acts. */
async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise(setImmediate);
}

test('a finished download asks for one restart, and "Later" defers it', async () => {
  const deferred = harness();
  deferred.updater.start();
  deferred.updater.dispose();
  deferred.fake.emit('update-downloaded', { version: '0.4.0' });
  await flush();
  assert.equal(deferred.dialogs.length, 1);
  assert.match(deferred.dialogs[0].message, /0\.4\.0/);
  assert.equal(deferred.fake.installs, 0);
  assert.deepEqual(deferred.events, [{ state: 'ready', version: '0.4.0' }]);

  const accepted = harness({ dialogResponse: 0 });
  accepted.updater.start();
  accepted.updater.dispose();
  accepted.fake.emit('update-downloaded', { version: '0.4.0' });
  await flush();
  assert.equal(accepted.fake.installs, 1, 'restart now hands over to the installer');
});

test('a failed check is logged and broadcast, never shown as a dialog', async () => {
  const { updater, fake, dialogs, logs, events } = harness();
  updater.start();
  updater.dispose();
  fake.outcome = new Error('getaddrinfo ENOTFOUND api.github.com');

  await assert.doesNotReject(() => updater.check(true));
  assert.match(logs.join('\n'), /ENOTFOUND/);

  fake.emit('error', new Error('404 Rate limit exceeded'));
  assert.equal(events.at(-1).state, 'error');
  assert.equal(dialogs.length, 0, 'an offline beta tester must not be interrupted');
});
