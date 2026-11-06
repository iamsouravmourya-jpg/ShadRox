'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { runWithCommandApproval, isAllowedVerifyCommand, parseVerifyArgv } = require('./command-approval.cjs');

function fixture(overrides = {}) {
  const workspace = { workspaceId: 'workspace-1', mode: 'folder', root: path.resolve('test-workspace') };
  const calls = { approval: [], execution: [] };
  const options = {
    workspaceId: workspace.workspaceId,
    command: 'node scripts/custom-task.js',
    workspace,
    showApproval: async (request) => {
      calls.approval.push(request);
      return true;
    },
    getWorkspace: (workspaceId) => workspaceId === workspace.workspaceId ? workspace : null,
    runCommand: async (command, cwd) => {
      calls.execution.push({ command, cwd });
      return { exitCode: 0 };
    },
    ...overrides
  };
  return { options, calls, workspace };
}

test('isAllowedVerifyCommand strictly accepts only safe test/typecheck binaries without shell metachars', () => {
  // Allowlisted
  assert.equal(isAllowedVerifyCommand('npm test'), true);
  assert.equal(isAllowedVerifyCommand('npm run test'), true);
  assert.equal(isAllowedVerifyCommand('npm run typecheck'), true);
  assert.equal(isAllowedVerifyCommand('pytest'), true);
  assert.equal(isAllowedVerifyCommand('pytest tests/unit'), true);
  assert.equal(isAllowedVerifyCommand('tsc'), true);
  assert.equal(isAllowedVerifyCommand('tsc --noEmit'), true);
  assert.equal(isAllowedVerifyCommand('git diff'), true);
  assert.equal(isAllowedVerifyCommand('npx tsc'), true);
  assert.equal(isAllowedVerifyCommand('npx pytest'), true);

  // Denied / Non-allowlisted
  assert.equal(isAllowedVerifyCommand('rm -rf /'), false);
  assert.equal(isAllowedVerifyCommand('curl http://malicious.site'), false);
  assert.equal(isAllowedVerifyCommand('node scripts/build.js'), false);
  assert.equal(isAllowedVerifyCommand('npm install'), false);
  assert.equal(isAllowedVerifyCommand('npm start'), false);
  assert.equal(isAllowedVerifyCommand('git push'), false);
  assert.equal(isAllowedVerifyCommand('bash -c "whoami"'), false);

  // Denied / Shell metacharacters injection attempts
  assert.equal(isAllowedVerifyCommand('npm test; rm -rf /'), false);
  assert.equal(isAllowedVerifyCommand('npm test && curl evil.com'), false);
  assert.equal(isAllowedVerifyCommand('npm test | cat'), false);
  assert.equal(isAllowedVerifyCommand('tsc > output.txt'), false);
  assert.equal(isAllowedVerifyCommand('pytest $(whoami)'), false);
  assert.equal(isAllowedVerifyCommand('git diff `id`'), false);
});

test('allowlisted verification command executes silently without prompting showApproval', async () => {
  const { options, calls, workspace } = fixture({ command: 'npm test' });
  const result = await runWithCommandApproval(options);

  assert.deepEqual(calls.approval, []);
  assert.deepEqual(calls.execution, [{ command: 'npm test', cwd: path.resolve(workspace.root) }]);
  assert.deepEqual(result, { approved: true, result: { exitCode: 0 } });
});

test('non-allowlisted command requires native approval callback before execution', async () => {
  const { options, calls, workspace } = fixture({ command: 'cargo build' });
  const result = await runWithCommandApproval(options);

  assert.deepEqual(calls.approval, [{
    workspaceId: workspace.workspaceId,
    command: 'cargo build',
    cwd: path.resolve(workspace.root)
  }]);
  assert.deepEqual(calls.execution, [{ command: 'cargo build', cwd: path.resolve(workspace.root) }]);
  assert.deepEqual(result, { approved: true, result: { exitCode: 0 } });
});

test('command with shell metacharacters cannot bypass approval even if starting with npm test', async () => {
  const { options, calls, workspace } = fixture({ command: 'npm test; rm -rf /' });
  const result = await runWithCommandApproval(options);

  assert.equal(calls.approval.length, 1);
  assert.equal(calls.approval[0].command, 'npm test; rm -rf /');
});

test('cancelled approval never invokes the command runner for non-allowlisted commands', async () => {
  const { options, calls } = fixture({ command: 'python script.py', showApproval: async () => false });
  const result = await runWithCommandApproval(options);

  assert.equal(result.approved, false);
  assert.match(result.reason, /not approved/);
  assert.deepEqual(calls.execution, []);
});

test('a workspace change while the native dialog is open prevents execution', async () => {
  const { options, calls } = fixture({
    showApproval: async () => {
      options.workspace.root = path.resolve('different-workspace');
      return true;
    }
  });
  const result = await runWithCommandApproval(options);

  assert.equal(result.approved, false);
  assert.match(result.reason, /workspace changed/);
  assert.deepEqual(calls.execution, []);
});

test('approval is denied when the workspace closes before the dialog resolves', async () => {
  const { options, calls } = fixture({
    getWorkspace: () => null
  });
  const result = await runWithCommandApproval(options);

  assert.equal(result.approved, false);
  assert.deepEqual(calls.execution, []);
});

test('renderer-supplied approval flags cannot bypass the main-process decision', async () => {
  const { options, calls } = fixture({
    approved: true,
    showApproval: async () => false
  });
  const result = await runWithCommandApproval(options);

  assert.equal(result.approved, false);
  assert.deepEqual(calls.execution, []);
});

test('invalid input fails explicitly instead of running a fallback command', async () => {
  const { options, calls } = fixture({ command: '  ' });
  await assert.rejects(runWithCommandApproval(options), /valid folder workspace, command/);
  assert.deepEqual(calls.execution, []);
});
