'use strict';

/**
 * Zero-config debug inference.
 *
 * When a workspace has no `shadrox.debug.json`, the debugger used to dead-end
 * on "add a config file". This module infers ready-to-launch configurations
 * from what the workspace actually contains — a Node/TS entry point, a Vite or
 * Next.js dev server, a Python script — and returns them in the same raw shape
 * `shadrox.debug.json` uses, so `debug-host.cjs` validates them through the
 * exact same `normalizeConfig` path as hand-written configs.
 *
 * Every emitted `program` is existence-checked: a config that cannot resolve
 * to a real file is never offered, because a one-click launch that cannot
 * start is worse than no button at all.
 */

const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.idea',
  '.vscode', 'tmp', 'temp', '.turbo', '.cache'
]);
const MAX_FILES = 4000;
const MAX_DEPTH = 12;

/** Bounded workspace file listing as POSIX-relative paths. */
function collectWorkspaceFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(root, 0);
  return out;
}

function readPackageJson(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pure inference over a file-name set. `fileExists(rel)` lets callers check
 * paths the walk skipped (node_modules binaries, dist entries); `pkg` is the
 * parsed package.json when the caller has it.
 */
function inferLaunchConfigsFromNames(names, fileExists, pkg) {
  const has = (rel) => names.has(rel);
  const exists = typeof fileExists === 'function' ? fileExists : () => false;
  const configs = [];

  // Node / TypeScript entry point. package.json "main" wins when it resolves,
  // then the conventional server/entry candidates. App.tsx-style UI roots are
  // deliberately absent: a JSX tree is not something the node adapter runs.
  const programCandidates = [];
  const mainField = pkg && typeof pkg.main === 'string'
    ? pkg.main.replace(/\\/g, '/').replace(/^\.\//, '')
    : null;
  if (mainField) programCandidates.push(mainField);
  programCandidates.push(
    'server.ts', 'server.js',
    'src/main.ts', 'src/index.ts',
    'src/main.js', 'src/index.js',
    'index.js', 'index.ts',
    'electron/main.cjs'
  );
  const program = programCandidates.find((candidate) => has(candidate) || exists(candidate));
  if (program) {
    configs.push({
      name: 'Node.js / TypeScript App',
      type: 'node',
      request: 'launch',
      program,
      adapterCommand: 'js-debug-adapter'
    });
  }

  // Vite dev server: needs package.json AND the installed binary, because
  // node_modules is never part of the workspace file listing.
  const viteBin = 'node_modules/vite/bin/vite.js';
  if (has('package.json') && (has(viteBin) || exists(viteBin))) {
    configs.push({
      name: 'Vite / Web Dev Server',
      type: 'node',
      request: 'launch',
      program: viteBin,
      args: ['--host', '0.0.0.0', '--port', '3000'],
      adapterCommand: 'js-debug-adapter'
    });
  }

  // Next.js dev server: a next.config.* file or a declared dependency, plus
  // the installed binary.
  const nextBin = 'node_modules/next/dist/bin/next';
  const declaresNext = Boolean(
    pkg &&
      ((pkg.dependencies && pkg.dependencies.next) ||
        (pkg.devDependencies && pkg.devDependencies.next))
  );
  const hasNextConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'].some(has);
  if ((hasNextConfig || declaresNext) && (has(nextBin) || exists(nextBin))) {
    configs.push({
      name: 'Next.js Dev Server',
      type: 'node',
      request: 'launch',
      program: nextBin,
      args: ['dev'],
      adapterCommand: 'js-debug-adapter'
    });
  }

  // Python entry point. The js-debug adapter cannot execute Python itself;
  // the config is still offered because workspaces that install a
  // Python-capable adapterCommand override get a working launch, and without
  // one the session fails with the adapter's own honest error.
  const pythonProgram = has('main.py') ? 'main.py' : has('app.py') ? 'app.py' : null;
  if (pythonProgram) {
    configs.push({
      name: 'Python Main Script',
      type: 'node',
      request: 'launch',
      program: pythonProgram,
      adapterCommand: 'js-debug-adapter'
    });
  }

  return configs;
}

/** Filesystem-backed inference for the main process. */
function inferLaunchConfigs(root) {
  const names = new Set(collectWorkspaceFiles(root));
  const fileExists = (rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  return inferLaunchConfigsFromNames(names, fileExists, readPackageJson(root));
}

module.exports = {
  collectWorkspaceFiles,
  inferLaunchConfigs,
  inferLaunchConfigsFromNames
};
