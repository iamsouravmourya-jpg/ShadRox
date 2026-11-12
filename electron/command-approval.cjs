'use strict';

const path = require('node:path');

const { parseVerifyCommand } = require('./verify-allowlist.cjs');

/**
 * Strict default-deny check for the silent verification path, backed by the single
 * allowlist table in verify-allowlist.cjs. Prefix matching is deliberately not used:
 * `tsc --outFile build.js` and `git diff --output patch.txt` start with an
 * allowlisted binary but write files, so they must reach interactive approval.
 * Returns argv when silently allowed, null when approval is required.
 */
function parseVerifyArgv(command) {
  const verdict = parseVerifyCommand(command);
  return verdict.allowed ? verdict.argv : null;
}

function isAllowedVerifyCommand(command) {
  return parseVerifyArgv(command) !== null;
}

async function runWithCommandApproval({
  workspaceId,
  command,
  workspace,
  riskNotice = '',
  showApproval,
  getWorkspace,
  runCommand,
  allowVerifyAllowlist = false
}) {
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    typeof command !== 'string' ||
    !command.trim() ||
    !workspace ||
    workspace.mode !== 'folder' ||
    typeof workspace.root !== 'string' ||
    typeof riskNotice !== 'string' ||
    typeof showApproval !== 'function' ||
    typeof getWorkspace !== 'function' ||
    typeof runCommand !== 'function'
  ) {
    throw new Error('A valid folder workspace, command and approval handlers are required.');
  }

  const cwd = path.resolve(workspace.root);

  // If allowVerifyAllowlist is enabled and command matches the strict default-deny allowlist
  // without any shell metacharacters, allow silent verification. Otherwise require human approval.
  const isAllowlisted = allowVerifyAllowlist && isAllowedVerifyCommand(command);

  let approved = isAllowlisted;
  if (!approved) {
    approved = await showApproval({ workspaceId, command, cwd, riskNotice });
  }

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

module.exports = {
  runWithCommandApproval,
  isAllowedVerifyCommand,
  parseVerifyArgv
};
