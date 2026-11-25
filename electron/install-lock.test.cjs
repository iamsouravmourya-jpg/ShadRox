'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireInstallLock,
  isPackageInstallCommand,
  withInstallLock
} = require('./install-lock.cjs');

test('isPackageInstallCommand accurately detects package manager install commands', () => {
  assert.equal(isPackageInstallCommand('npm install'), true);
  assert.equal(isPackageInstallCommand('npm i lucide-react'), true);
  assert.equal(isPackageInstallCommand('pnpm add -D vitest'), true);
  assert.equal(isPackageInstallCommand('bun install'), true);
  assert.equal(isPackageInstallCommand('cd client && npm ci'), true);
  assert.equal(isPackageInstallCommand('yarn'), true);
  assert.equal(isPackageInstallCommand('npm run dev'), false);
  assert.equal(isPackageInstallCommand('node server.js'), false);
});

test('acquireInstallLock serializes concurrent installs on the same workspace in FIFO order', async () => {
  const timeline = [];

  const jobA = withInstallLock('/tmp/ws-shared', async () => {
    timeline.push('A-start');
    await new Promise((r) => setTimeout(r, 25));
    timeline.push('A-end');
  });

  const jobB = withInstallLock('/tmp/ws-shared', async () => {
    timeline.push('B-start');
    await new Promise((r) => setTimeout(r, 10));
    timeline.push('B-end');
  });

  await Promise.all([jobA, jobB]);
  assert.deepEqual(timeline, ['A-start', 'A-end', 'B-start', 'B-end']);
});

test('install locks are independent across different workspace roots', async () => {
  const started = [];
  const release1 = await acquireInstallLock('/tmp/ws-alpha');
  started.push('alpha');
  const release2 = await acquireInstallLock('/tmp/ws-beta');
  started.push('beta');

  assert.deepEqual(started, ['alpha', 'beta']);
  release1();
  release2();
});
