'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isInsideAsar(candidate) {
  return /[\\/]app\.asar[\\/]/.test(candidate);
}

function unpackedSibling(candidate) {
  return candidate.replace(/[\\/]app\.asar[\\/]/, `${path.sep}app.asar.unpacked${path.sep}`);
}

function defaultExists(candidate) {
  try { return fs.existsSync(candidate); } catch { return false; }
}

/**
 * The scripts are handed to PowerShell and bash, processes outside Electron
 * that cannot see inside app.asar — fs.existsSync answers true for asar paths
 * while the shell itself fails with CommandNotFound. So the directory is
 * resolved to a real on-disk copy (extraResources first, then the
 * app.asar.unpacked sibling that asarUnpack produces) and integration is
 * skipped entirely when no readable copy exists.
 */
function resolveScriptDir(options) {
  if (typeof options.scriptDir === 'string' && options.scriptDir) return options.scriptDir;
  const exists = options.scriptExists || defaultExists;
  const baseDirname = typeof options.baseDirname === 'string' ? options.baseDirname : __dirname;
  const candidates = [];
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'shell-integration'));
  if (isInsideAsar(baseDirname)) candidates.push(unpackedSibling(path.join(baseDirname, 'shell-integration')));
  candidates.push(path.join(baseDirname, 'shell-integration'));
  for (const candidate of candidates) {
    if (exists(path.join(candidate, 'shadrox.ps1')) || exists(path.join(candidate, 'shadrox.sh'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Wraps a resolved terminal plan so the interactive shell emits OSC 133 / 633
 * markers. The renderer parser already understands those markers. Command
 * Prompt and plain /bin/sh stay untouched: they have no safe prompt hook here.
 */
function applyShellIntegration(plan, options = {}) {
  const scriptDir = resolveScriptDir(options);
  const exists = options.existsSync || defaultExists;
  const shellPath = typeof plan.shellPath === 'string' ? plan.shellPath : '';
  const baseArgs = Array.isArray(plan.shellArgs) ? plan.shellArgs : [];
  const env = { ...(plan.env || {}) };

  if (scriptDir === null) return { ...plan, shellArgs: [...baseArgs], env };

  if (/powershell/i.test(shellPath)) {
    const script = path.join(scriptDir, 'shadrox.ps1');
    if (exists(script)) {
      const quoted = script.replace(/'/g, "''");
      return {
        ...plan,
        shellArgs: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${quoted}'`],
        env
      };
    }
  }

  if (/bash/i.test(path.basename(shellPath))) {
    const script = path.join(scriptDir, 'shadrox.sh');
    if (exists(script)) {
      return {
        ...plan,
        shellArgs: ['--rcfile', script, '-i'],
        env
      };
    }
  }

  return { ...plan, shellArgs: [...baseArgs], env };
}

module.exports = { applyShellIntegration, isInsideAsar, resolveScriptDir, unpackedSibling };
