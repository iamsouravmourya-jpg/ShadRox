'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { applyShellIntegration, isInsideAsar, resolveScriptDir, unpackedSibling } = require('./shell-integration.cjs');

test('PowerShell launches the ShadRox integration script and stays open', () => {
  const plan = applyShellIntegration({
    shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    shellArgs: ['-NoLogo'],
    env: { SystemRoot: 'C:\\Windows' }
  }, {
    scriptDir: 'C:\\scripts',
    existsSync: (candidate) => candidate.endsWith('shadrox.ps1')
  });
  assert.deepEqual(plan.shellArgs.slice(0, 5), ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.match(plan.shellArgs[5], /shadrox\.ps1/);
});

test('bash sources the integration rcfile', () => {
  const plan = applyShellIntegration({
    shellPath: '/bin/bash',
    shellArgs: [],
    env: {}
  }, {
    scriptDir: '/opt/shadrox',
    existsSync: (candidate) => candidate.endsWith('shadrox.sh')
  });
  assert.equal(plan.shellArgs[0], '--rcfile');
  assert.equal(path.basename(plan.shellArgs[1]), 'shadrox.sh');
  assert.equal(plan.shellArgs[2], '-i');
});

test('cmd and plain sh keep their original arguments', () => {
  const cmd = applyShellIntegration({ shellPath: 'cmd.exe', shellArgs: ['/d'], env: {} }, {
    scriptDir: 'C:\\scripts',
    existsSync: () => true
  });
  assert.deepEqual(cmd.shellArgs, ['/d']);
  const sh = applyShellIntegration({ shellPath: '/bin/sh', shellArgs: [], env: { A: '1' } }, {
    scriptDir: 'C:\\scripts',
    existsSync: () => true
  });
  assert.deepEqual(sh.shellArgs, []);
  assert.equal(sh.env.A, '1');
});

test('no readable script copy leaves the shell untouched', () => {
  const plan = applyShellIntegration({
    shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    shellArgs: ['-NoLogo'],
    env: {}
  }, { scriptExists: () => false });
  assert.deepEqual(plan.shellArgs, ['-NoLogo']);
});

test('packaged apps use the real on-disk copy, never the asar path', () => {
  const asarDir = path.join('C:', 'Programs', 'ShadRox', 'resources', 'app.asar', 'electron');
  const unpacked = path.join('C:', 'Programs', 'ShadRox', 'resources', 'app.asar.unpacked', 'electron', 'shell-integration');
  const exists = (candidate) => candidate.startsWith(unpacked);
  const found = resolveScriptDir({ baseDirname: asarDir, scriptExists: exists });
  assert.equal(found, unpacked);
  assert.equal(isInsideAsar(path.join(asarDir, 'shell-integration', 'shadrox.ps1')), true);
  assert.equal(unpackedSibling(path.join(asarDir, 'shell-integration', 'shadrox.ps1')).includes('app.asar\\'), false);
  assert.equal(resolveScriptDir({ baseDirname: asarDir, scriptExists: () => false }), null);
});
