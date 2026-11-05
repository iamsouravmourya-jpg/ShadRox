'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { runWithCommandApproval } = require('./command-approval.cjs');

function fixture(overrides = {}) {
  const workspace = { workspaceId: 'workspace-1', mode: 'folder', root: path.resolve('test-workspace') };
  const calls = { approval: [], execution: [] };
  const options = {
    workspaceId: workspace.workspaceId,
    command: 'npm test',
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

test('execution happens only after the native approval callback accepts exact details', async () => {
  const { options, calls, workspace } = fixture();
  const result = await runWithCommandApproval(options);

  assert.deepEqual(calls.approval, [{
    workspaceId: workspace.workspaceId,
    command: options.command,
    cwd: path.resolve(workspace.root)
  }]);
  assert.deepEqual(calls.execution, [{ command: options.command, cwd: path.resolve(workspace.root) }]);
  assert.deepEqual(result, { approved: true, result: { exitCode: 0 } });
});

test('cancelled approval never invokes the command runner', async () => {
  const { options, calls } = fixture({ showApproval: async () => false });
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
