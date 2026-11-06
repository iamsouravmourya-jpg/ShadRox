'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { applyShellIntegration } = require('./shell-integration.cjs');

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
    existsSync: () => true
  });
  assert.deepEqual(cmd.shellArgs, ['/d']);
  const sh = applyShellIntegration({ shellPath: '/bin/sh', shellArgs: [], env: { A: '1' } }, {
    existsSync: () => true
  });
  assert.deepEqual(sh.shellArgs, []);
  assert.equal(sh.env.A, '1');
});
