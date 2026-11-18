'use strict';

const path = require('node:path');

const { parseVerifyCommand } = require('./verify-allowlist.cjs');
const { classifyCommand, AUTO_TIERS } = require('./command-risk.cjs');

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

/**
 * Risk-tiered approval gate (owner decisions 2026-11-18):
 * - READ / BUILD_TEST / INSTALL auto-run with no dialog (still streamed to the
 *   terminal dock and logged by the executor).
 * - MUTATE / NETWORK require the native approval dialog.
 * - DANGEROUS always requires the dialog and can never be pre-approved by any
 *   scope, including the verify allowlist.
 * - Parse failures classify as MUTATE, so an unparseable line always asks.
 */
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
  const risk = classifyCommand(command, { cwd, root: cwd });

  const autoTier = AUTO_TIERS.has(risk.tier);
  // The verify allowlist may silence approval for its strict forms, but never
  // for a DANGEROUS classification — no scope pre-approves destruction.
  const isAllowlisted = allowVerifyAllowlist && risk.tier !== 'DANGEROUS' && isAllowedVerifyCommand(command);

  let approved = autoTier || isAllowlisted;
  if (!approved) {
    approved = await showApproval({ workspaceId, command, cwd, riskNotice, tier: risk.tier, risk });
  }

  if (approved !== true) return { approved: false, reason: 'Command was not approved.', tier: risk.tier };

  const currentWorkspace = getWorkspace(workspaceId);
  if (
    !currentWorkspace ||
    currentWorkspace.mode !== 'folder' ||
    typeof currentWorkspace.root !== 'string' ||
    path.resolve(currentWorkspace.root) !== cwd
  ) {
    return { approved: false, reason: 'The workspace changed while command approval was open.', tier: risk.tier };
  }

  return {
    approved: true,
    tier: risk.tier,
    result: await runCommand(command, cwd, { workspaceId, risk, autoApproved: autoTier || isAllowlisted })
  };
}

module.exports = {
  runWithCommandApproval,
  isAllowedVerifyCommand,
  parseVerifyArgv
};
