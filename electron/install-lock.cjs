'use strict';

const path = require('node:path');

/**
 * Per-workspace mutex serializing package manager installs (`npm`, `pnpm`,
 * `yarn`, `bun`) so preview runtime auto-installs and agent terminal installs
 * cannot corrupt `node_modules` / lockfiles concurrently in the same folder.
 */
const workspaceTailLocks = new Map();

function normalizeLockKey(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return '__global__';
  const resolved = path.resolve(workspaceRoot).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPackageInstallCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Match leading or chained package manager install/add/ci subcommands.
  return /(?:^|[;&|]+\s*)(?:npx\s+)?(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b/i.test(trimmed) ||
    /(?:^|[;&|]+\s*)yarn(?:\s+--[^\s]+)*\s*(?:$|[;&|])/i.test(trimmed);
}

/**
 * Acquires the workspace install mutex and returns a `release()` callback.
 * Waiters queue in strict FIFO order per workspace root.
 */
function acquireInstallLock(workspaceRoot) {
  const key = normalizeLockKey(workspaceRoot);
  const previous = workspaceTailLocks.get(key) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current, () => current);
  workspaceTailLocks.set(key, chained);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (workspaceTailLocks.get(key) === chained) {
      workspaceTailLocks.delete(key);
    }
  };

  return previous.then(() => release, () => release);
}

async function withInstallLock(workspaceRoot, fn) {
  const release = await acquireInstallLock(workspaceRoot);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = {
  acquireInstallLock,
  isPackageInstallCommand,
  withInstallLock
};
