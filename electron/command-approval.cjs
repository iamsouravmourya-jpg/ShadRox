'use strict';

const path = require('node:path');

const SHELL_METACHARS_REGEX = /[&|;><`$()\\\n\r]/;

/**
 * Parses and verifies whether a command string is an authorized verification command
 * under the strict default-deny allowlist policy (npm test, pytest, tsc, git diff).
 * Returns array of [binary, ...args] if strictly allowed, or null if denied.
 */
function parseVerifyArgv(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Strict check 1: Reject any shell control, redirection, chaining, or expansion characters
  if (SHELL_METACHARS_REGEX.test(trimmed)) {
    return null;
  }

  // Split into argv elements safely
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const bin = parts[0];

  // Rule 1: npm test, npm run test, npm run typecheck
  if (bin === 'npm') {
    if (parts[1] === 'test') {
      return parts;
    }
    if (parts[1] === 'run' && (parts[2] === 'test' || parts[2] === 'typecheck')) {
      return parts;
    }
    return null;
  }

  // Rule 2: npx tsc, npx pytest
  if (bin === 'npx') {
    if (parts[1] === 'tsc' || parts[1] === 'pytest') {
      return parts;
    }
    return null;
  }

  // Rule 3: pytest
  if (bin === 'pytest') {
    return parts;
  }

  // Rule 4: tsc
  if (bin === 'tsc') {
    return parts;
  }

  // Rule 5: git diff
  if (bin === 'git' && parts[1] === 'diff') {
    return parts;
  }

  return null;
}

function isAllowedVerifyCommand(command) {
  return parseVerifyArgv(command) !== null;
}

async function runWithCommandApproval({
  workspaceId,
  command,
  workspace,
  showApproval,
  getWorkspace,
  runCommand,
  allowVerifyAllowlist = true
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

  // If allowVerifyAllowlist is enabled and command matches the strict default-deny allowlist
  // without any shell metacharacters, allow silent verification. Otherwise require human approval.
  const isAllowlisted = allowVerifyAllowlist && isAllowedVerifyCommand(command);

  let approved = isAllowlisted;
  if (!approved) {
    approved = await showApproval({ workspaceId, command, cwd });
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
