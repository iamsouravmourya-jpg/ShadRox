'use strict';

const path = require('node:path');

async function runWithCommandApproval({
  workspaceId,
  command,
  workspace,
  showApproval,
  getWorkspace,
  runCommand
}) {
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    typeof command !== 'string' ||
    !command.trim() ||
    !workspace ||
    workspace.mode !== 'folder' ||
    typeof workspace.root !== 'string' ||
    typeof showApproval !== 'function' ||
    typeof getWorkspace !== 'function' ||
    typeof runCommand !== 'function'
  ) {
    throw new Error('A valid folder workspace, command and approval handlers are required.');
  }

  const cwd = path.resolve(workspace.root);
  const approved = await showApproval({ workspaceId, command, cwd });
  if (approved !== true) return { approved: false, reason: 'Command was not approved.' };

  const currentWorkspace = getWorkspace(workspaceId);
  if (
    !currentWorkspace ||
    currentWorkspace.mode !== 'folder' ||
    typeof currentWorkspace.root !== 'string' ||
    path.resolve(currentWorkspace.root) !== cwd
  ) {
    return { approved: false, reason: 'The workspace changed while command approval was open.' };
  }

  return {
    approved: true,
    result: await runCommand(command, cwd)
  };
}

module.exports = { runWithCommandApproval };
