'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  buildGitArgv,
  buildIsolatedGitEnv,
  collectRepoFilterDrivers,
  isPathInsideDirectory,
  resolveGitExecutable
} = require('../desktop-security.cjs');
const { listUnmergedPaths } = require('../git-conflicts.cjs');
const {
  parseGitBranches,
  parseGitStatus,
  sanitizeCommitMessage,
  validateBranchName,
  validateGitPaths
} = require('../git-scm.cjs');

function truncateText(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}

function createGitService({ workspaceAccess }) {
  let gitExecutable = null;
  let gitEnvironment = null;
  let gitSafetyCache = { root: null, context: null };

  function runGit(cwd, args, input) {
    return new Promise((resolve) => {
      if (!gitExecutable || !gitEnvironment) {
        resolve({ ok: false, stdout: '', stderr: 'git is unavailable on a trusted path.' });
        return;
      }
      const child = execFile(gitExecutable, args, {
        cwd,
        env: gitEnvironment,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });
  }

  function locateGitExecutable() {
    gitExecutable = resolveGitExecutable({});
    gitEnvironment = gitExecutable ? buildIsolatedGitEnv({}) : null;
    gitSafetyCache = { root: null, context: null };
    if (!gitExecutable) {
      console.warn('[desktop] no absolute git executable found outside the workspace; commit context is disabled');
    }
  }

  async function gitSafetyContext(workspaceRoot) {
    if (gitSafetyCache.root === workspaceRoot && gitSafetyCache.context) return gitSafetyCache.context;

    const options = { safeDirectories: [workspaceRoot] };
    const probeArgs = buildGitArgv(['rev-parse', '--absolute-git-dir'], options);
    const probe = await runGit(workspaceRoot, probeArgs);
    const gitDir = probe.ok ? probe.stdout.trim() : '';
    let gitDirInsideWorkspace = false;
    if (gitDir && path.isAbsolute(gitDir)) {
      try {
        const realRoot = fs.realpathSync.native(workspaceRoot);
        const realGitDir = fs.realpathSync.native(gitDir);
        gitDirInsideWorkspace = isPathInsideDirectory(realRoot, realGitDir);
      } catch {
        gitDirInsideWorkspace = false;
      }
    }

    let drivers = [];
    let complete = false;
    if (gitDirInsideWorkspace) {
      const collected = await collectRepoFilterDrivers(gitDir);
      drivers = collected.drivers;
      complete = collected.complete;
    }

    const context = {
      complete: complete && gitDirInsideWorkspace,
      gitDirInsideWorkspace,
      filterDrivers: drivers,
      probeArgs: buildGitArgv(['rev-parse', '--is-inside-work-tree'], options),
      statusArgs: buildGitArgv(['status', '--porcelain=v1', '--branch'], { ...options, filterDrivers: drivers }),
      diffArgs: buildGitArgv(['diff', '--no-color', '--unified=2', 'HEAD'], { ...options, filterDrivers: drivers }),
      logArgs: buildGitArgv(['log', '-n', '8', '--pretty=%s'], { ...options, filterDrivers: drivers })
    };
    gitSafetyCache = { root: workspaceRoot, context };
    return context;
  }

  async function requireGitWorkspace(workspaceId) {
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Source control is available only for an opened folder workspace.');
    }
    if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) {
      throw new Error('A trusted Git executable is unavailable.');
    }
    const context = await gitSafetyContext(workspace.root);
    if (!context.gitDirInsideWorkspace) throw new Error('The Git directory resolves outside the opened workspace.');
    const probe = await runGit(workspace.root, context.probeArgs);
    if (!probe.ok || probe.stdout.trim() !== 'true') throw new Error('The opened folder is not a Git repository.');
    return { workspace, context };
  }

  async function runGitOrThrow(cwd, args) {
    const result = await runGit(cwd, args);
    if (!result.ok) throw new Error(result.stderr.trim().slice(0, 2000) || 'Git operation failed.');
    return result.stdout;
  }

  function registerGitHandlers({ handleMachineSensitive, assertTrustedRenderer }) {
    handleMachineSensitive('git:read', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const workspace = workspaceAccess.getWorkspace(workspaceId);
      if (!workspace || workspace.mode !== 'folder') {
        throw new Error('Git info is available only for an opened folder workspace.');
      }

      const unavailable = { isRepo: false, status: '', diff: '', log: '', dirty: 0 };
      if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) return unavailable;

      const context = await gitSafetyContext(workspace.root);
      const probe = await runGit(workspace.root, context.probeArgs);
      if (!probe.ok || probe.stdout.trim() !== 'true') return unavailable;

      const empty = Promise.resolve({ ok: false, stdout: '', stderr: '' });
      const [status, rawDiff, log] = await Promise.all([
        context.complete ? runGit(workspace.root, context.statusArgs) : empty,
        context.complete ? runGit(workspace.root, context.diffArgs) : empty,
        runGit(workspace.root, context.logArgs)
      ]);

      let diffStdout = rawDiff.stdout;
      if (context.complete && !rawDiff.ok && /HEAD|unknown revision|bad revision|ambiguous argument/i.test(rawDiff.stderr || '')) {
        const driverOpts = { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] };
        const [cachedDiff, workingDiff] = await Promise.all([
          runGit(workspace.root, buildGitArgv(['diff', '--cached', '--no-color', '--unified=2'], driverOpts)),
          runGit(workspace.root, buildGitArgv(['diff', '--no-color', '--unified=2'], driverOpts))
        ]);
        diffStdout = [cachedDiff.stdout, workingDiff.stdout].filter(Boolean).join('\n');
      }

      return {
        isRepo: true,
        status: truncateText(status.stdout, 4_000),
        diff: truncateText(diffStdout, 60_000),
        log: truncateText(log.stdout, 2_000),
        dirty: status.stdout.split('\n').filter((line) => line && !line.startsWith('##')).length
      };
    });

    handleMachineSensitive('git:conflicts', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const workspace = workspaceAccess.getWorkspace(workspaceId);
      if (!workspace || workspace.mode !== 'folder') return { isRepo: false, paths: [] };
      if (!gitExecutable || isPathInsideDirectory(workspace.root, gitExecutable)) return { isRepo: false, paths: [] };

      const context = await gitSafetyContext(workspace.root);
      const probe = await runGit(workspace.root, context.probeArgs);
      if (!probe.ok || probe.stdout.trim() !== 'true') return { isRepo: false, paths: [] };

      const runIndex = (argv) =>
        runGit(workspace.root, buildGitArgv(argv, { safeDirectories: [workspace.root] }));
      try {
        return { isRepo: true, paths: await listUnmergedPaths(runIndex) };
      } catch {
        return { isRepo: true, paths: [] };
      }
    });

    handleMachineSensitive('git:scm-read', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) {
        throw new Error('Git filter configuration could not be verified, so working-tree status is unavailable.');
      }
      const options = { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] };
      const [status, branches] = await Promise.all([
        runGitOrThrow(workspace.root, buildGitArgv(
          ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
          { filterDrivers: options.filterDrivers, safeDirectories: options.safeDirectories }
        )),
        runGitOrThrow(workspace.root, buildGitArgv(
          ['branch', '-v', '--no-abbrev', '--no-color'],
          { safeDirectories: options.safeDirectories }
        ))
      ]);
      return {
        ...parseGitStatus(status),
        branches: parseGitBranches(branches)
      };
    });

    handleMachineSensitive('git:stage', async (event, workspaceId, rawPaths) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) throw new Error('Git filter configuration could not be verified; staging is disabled.');
      const paths = validateGitPaths(rawPaths);
      await runGitOrThrow(workspace.root, buildGitArgv(
        ['add', '--', ...paths],
        { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] }
      ));
      return true;
    });

    handleMachineSensitive('git:unstage', async (event, workspaceId, rawPaths) => {
      assertTrustedRenderer(event);
      const { workspace } = await requireGitWorkspace(workspaceId);
      const paths = validateGitPaths(rawPaths);
      const safeDirectories = [workspace.root];
      const head = await runGit(workspace.root, buildGitArgv(['rev-parse', '--verify', 'HEAD'], { safeDirectories }));
      const args = head.ok
        ? ['reset', 'HEAD', '--', ...paths]
        : ['rm', '--cached', '--ignore-unmatch', '--', ...paths];
      await runGitOrThrow(workspace.root, buildGitArgv(args, { safeDirectories }));
      return true;
    });

    handleMachineSensitive('git:commit', async (event, workspaceId, rawMessage) => {
      assertTrustedRenderer(event);
      const { workspace } = await requireGitWorkspace(workspaceId);
      const message = sanitizeCommitMessage(rawMessage);
      const args = buildGitArgv(['commit', '-m', message], { safeDirectories: [workspace.root] });
      const commandIndex = args.indexOf('commit');
      args.splice(commandIndex, 0, '-c', 'commit.gpgsign=false', '-c', 'gpg.program=');
      await runGitOrThrow(workspace.root, args);
      return true;
    });

    handleMachineSensitive('git:branches', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const { workspace } = await requireGitWorkspace(workspaceId);
      const stdout = await runGitOrThrow(workspace.root, buildGitArgv(
        ['branch', '-v', '--no-abbrev', '--no-color'],
        { safeDirectories: [workspace.root] }
      ));
      return parseGitBranches(stdout);
    });

    handleMachineSensitive('git:checkout', async (event, workspaceId, rawBranch) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) throw new Error('Git filter configuration could not be verified; branch switching is disabled.');
      const branch = validateBranchName(rawBranch);
      const safeDirectories = [workspace.root];
      await runGitOrThrow(workspace.root, buildGitArgv(['check-ref-format', '--branch', branch], { safeDirectories }));
      await runGitOrThrow(workspace.root, buildGitArgv(
        ['switch', '--no-guess', branch],
        { filterDrivers: context.filterDrivers, safeDirectories }
      ));
      return true;
    });

    handleMachineSensitive('git:file-diff', async (event, workspaceId, rawPath, staged) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) throw new Error('Git filter configuration could not be verified; file diffs are unavailable.');
      if (typeof staged !== 'boolean') throw new Error('The diff kind must be specified.');
      const [file] = validateGitPaths([rawPath]);
      const args = ['diff', '--no-color', '--unified=3'];
      if (staged) args.push('--cached');
      args.push('--', file);
      const stdout = await runGitOrThrow(workspace.root, buildGitArgv(
        args,
        { filterDrivers: context.filterDrivers, safeDirectories: [workspace.root] }
      ));
      return truncateText(stdout, 80_000);
    });

    handleMachineSensitive('git:push', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      const safeDirectories = [workspace.root];
      const args = buildGitArgv(['push'], {
        filterDrivers: context.filterDrivers,
        safeDirectories
      });
      await runGitOrThrow(workspace.root, args);
      return true;
    });

    handleMachineSensitive('git:pull', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) {
        throw new Error('Git filter configuration could not be verified; pulling is disabled.');
      }
      const safeDirectories = [workspace.root];
      const args = buildGitArgv(['pull', '--ff-only'], {
        filterDrivers: context.filterDrivers,
        safeDirectories
      });
      await runGitOrThrow(workspace.root, args);
      return true;
    });

    handleMachineSensitive('git:sync', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) {
        throw new Error('Git filter configuration could not be verified; sync is disabled.');
      }
      const safeDirectories = [workspace.root];
      await runGitOrThrow(workspace.root, buildGitArgv(['pull', '--ff-only'], {
        filterDrivers: context.filterDrivers,
        safeDirectories
      }));
      await runGitOrThrow(workspace.root, buildGitArgv(['push'], {
        filterDrivers: context.filterDrivers,
        safeDirectories
      }));
      return true;
    });

    handleMachineSensitive('git:discard', async (event, workspaceId, rawPaths) => {
      assertTrustedRenderer(event);
      const { workspace, context } = await requireGitWorkspace(workspaceId);
      if (!context.complete) {
        throw new Error('Git filter configuration could not be verified; discarding changes is disabled.');
      }
      const paths = validateGitPaths(rawPaths);
      const safeDirectories = [workspace.root];
      const statusOut = await runGitOrThrow(workspace.root, buildGitArgv(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths],
        { filterDrivers: context.filterDrivers, safeDirectories }
      ));
      const parsed = parseGitStatus(statusOut);
      const untrackedSet = new Set(parsed.changes.filter((entry) => entry.untracked).map((entry) => entry.path));
      const trackedPaths = paths.filter((entry) => !untrackedSet.has(entry));
      const untrackedPaths = paths.filter((entry) => untrackedSet.has(entry));

      if (trackedPaths.length > 0) {
        const restoreResult = await runGit(workspace.root, buildGitArgv(
          ['restore', '--worktree', '--', ...trackedPaths],
          { filterDrivers: context.filterDrivers, safeDirectories }
        ));
        if (!restoreResult.ok) {
          await runGitOrThrow(workspace.root, buildGitArgv(
            ['checkout', '--', ...trackedPaths],
            { filterDrivers: context.filterDrivers, safeDirectories }
          ));
        }
      }

      if (untrackedPaths.length > 0) {
        const realRoot = await fs.promises.realpath(workspace.root);
        for (const relPath of untrackedPaths) {
          const target = path.resolve(realRoot, relPath);
          if (!isPathInsideDirectory(realRoot, target)) {
            throw new Error(`Refusing to remove "${relPath}" outside the workspace.`);
          }
          const stat = await fs.promises.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (!stat) continue;
          if (stat.isSymbolicLink()) {
            throw new Error(`Symbolic links are not discarded (${relPath}).`);
          }
          if (stat.isDirectory()) {
            await fs.promises.rm(target, { recursive: true, force: false });
          } else {
            await fs.promises.unlink(target);
          }
        }
      }

      return true;
    });
  }

  return {
    runGit,
    locateGitExecutable,
    gitSafetyContext,
    registerGitHandlers
  };
}

module.exports = {
  createGitService,
  truncateText
};
