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

const isNodeRuntime = typeof process !== 'undefined' && Boolean(process.versions?.node);
const fs = isNodeRuntime ? require('node:fs') : null;
const path = isNodeRuntime ? require('node:path') : null;
const childProcess = isNodeRuntime ? require('node:child_process') : null;
const previewRuntime = isNodeRuntime ? require('./preview-runtime.cjs') : null;

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

function detectPythonEntry(names) {
  if (names.has('main.py')) return 'main.py';
  if (names.has('app.py')) return 'app.py';
  return null;
}

function hasPythonSource(names) {
  if (detectPythonEntry(names)) return true;
  for (const name of names) {
    if (/\.py$/i.test(name)) return true;
  }
  return false;
}

/**
 * Check whether an installed system Python interpreter (outside the workspace)
 * has `debugpy` available. Never executes Python scripts inside the workspace.
 */
function probePythonDebugpy(root, runner, resolvePython) {
  if (!isNodeRuntime) {
    return {
      available: false,
      pythonCommand: null,
      reason: 'Python capability probe requires the desktop Node runtime.'
    };
  }
  const resolver = typeof resolvePython === 'function'
    ? resolvePython
    : (previewRuntime && typeof previewRuntime.resolveExecutable === 'function'
        ? (cmd) => previewRuntime.resolveExecutable(cmd, { root })
        : null);
  const pythonCommand = resolver ? (resolver('python3') || resolver('python')) : null;
  if (!pythonCommand) {
    return {
      available: false,
      pythonCommand: null,
      reason: 'Python interpreter not found on PATH.'
    };
  }
  const execProbe = typeof runner === 'function'
    ? runner
    : (cmd, args) => childProcess.spawnSync(cmd, args, {
        timeout: 1500,
        stdio: 'ignore',
        windowsHide: true
      });
  try {
    const result = execProbe(pythonCommand, ['-c', 'import debugpy']);
    if (result && result.status === 0) {
      return { available: true, pythonCommand, reason: null };
    }
  } catch {
    // treat probe failure as unavailable
  }
  return {
    available: false,
    pythonCommand,
    reason: 'The Python "debugpy" module is not installed.'
  };
}

function detectPythonDebugHint(names, pythonProbe) {
  if (!hasPythonSource(names)) return null;
  if (pythonProbe && pythonProbe.available) return null;
  const target = detectPythonEntry(names) || [...names].find((n) => /\.py$/i.test(n)) || 'Python files';
  return `Python files detected (${target}), but "debugpy" is unavailable. Install debugpy (pip install debugpy) or configure adapterCommand in shadrox.debug.json to debug Python.`;
}

/**
 * Pure inference over a file-name set. `fileExists(rel)` lets callers check
 * paths the walk skipped (node_modules binaries, dist entries); `pkg` is the
 * parsed package.json when the caller has it.
 */
function inferLaunchConfigsFromNames(names, fileExists, pkg, options = {}) {
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

  // Python entry point: gated on a real debugpy capability check so we never
  // offer a broken js-debug launch config for .py projects.
  const pythonProgram = detectPythonEntry(names);
  const pythonProbe = options && options.pythonDebugpy ? options.pythonDebugpy : null;
  if (pythonProgram && pythonProbe && pythonProbe.available && pythonProbe.pythonCommand) {
    configs.push({
      name: 'Python Main Script',
      type: 'python',
      request: 'launch',
      program: pythonProgram,
      adapterCommand: pythonProbe.pythonCommand,
      adapterArgs: ['-m', 'debugpy.adapter']
    });
  }

  return configs;
}

/** Filesystem-backed inference with optional capability hint for the main process. */
function inferLaunchResult(root, options = {}) {
  const names = new Set(collectWorkspaceFiles(root));
  const fileExists = (rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const pythonNeeded = hasPythonSource(names);
  const pythonProbe = pythonNeeded
    ? (options.pythonDebugpy ?? probePythonDebugpy(root, options.pythonRunner, options.resolvePython))
    : null;
  const configurations = inferLaunchConfigsFromNames(names, fileExists, readPackageJson(root), {
    pythonDebugpy: pythonProbe
  });
  const hint = detectPythonDebugHint(names, pythonProbe);
  return { configurations, hint };
}

/** Filesystem-backed inference for the main process. */
function inferLaunchConfigs(root, options = {}) {
  return inferLaunchResult(root, options).configurations;
}

module.exports = {
  collectWorkspaceFiles,
  detectPythonDebugHint,
  detectPythonEntry,
  hasPythonSource,
  inferLaunchConfigs,
  inferLaunchConfigsFromNames,
  inferLaunchResult,
  probePythonDebugpy
};
