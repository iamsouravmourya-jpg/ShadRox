'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Wraps a resolved terminal plan so the interactive shell emits OSC 133 / 633
 * markers. The renderer parser already understands those markers. Command
 * Prompt and plain /bin/sh stay untouched: they have no safe prompt hook here.
 */
function applyShellIntegration(plan, options = {}) {
  const scriptDir = options.scriptDir || path.join(__dirname, 'shell-integration');
  const exists = options.existsSync || ((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  const shellPath = typeof plan.shellPath === 'string' ? plan.shellPath : '';
  const baseArgs = Array.isArray(plan.shellArgs) ? plan.shellArgs : [];
  const env = { ...(plan.env || {}) };

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

module.exports = { applyShellIntegration };
