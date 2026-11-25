'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPathInsideDirectory } = require('../desktop-security.cjs');
const { mergePreviewVerdict } = require('../preview-assert.cjs');
const { unwrapErrorMessage } = require('../error-utils.cjs');
const {
  findMissingDependencies,
  findPreviewProjects,
  findStaticPreviewProjects,
  getPackageManager,
  getPreviewScript,
  resolveExecutable
} = require('../preview-runtime.cjs');
const { planDualPreview } = require('../runtime-adapters.cjs');

const PLUGIN_SCAN_MAX_FILES = 50;
const PLUGIN_MANIFEST_MAX_BYTES = 256 * 1024;
const RUNTIME_MANIFEST_NAMES = new Set([
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'composer.json'
]);
const RUNTIME_WALK_IGNORES = new Set([
  '.git', 'node_modules', 'dist', 'dist_staging', 'dist_desktop', 'build', 'out', '.next', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__', '.shadrox'
]);
const RUNTIME_MAX_FILES = 5000;
const RUNTIME_MAX_DIRECTORIES = 2000;
const RUNTIME_MAX_DEPTH = 4;
const RUNTIME_MANIFEST_MAX_BYTES = 256 * 1024;

function truncatePreviewText(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}

function normalizePreviewStartResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.status) return result;
  if (typeof result.url === 'string' && result.url) {
    return { status: 'ready', ...result };
  }
  return result;
}

async function scanWorkspacePlugins(workspace) {
  const files = [];
  const errors = [];
  if (!workspace?.root) {
    errors.push('Plugins require an opened workspace.');
    return { files, errors };
  }
  const root = workspace.root;
  const pluginsRoot = path.join(root, '.shadrox', 'plugins');

  let realPluginsRoot;
  try {
    realPluginsRoot = await fs.promises.realpath(pluginsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { files, errors };
    errors.push(`The plugins folder could not be read: ${unwrapErrorMessage(error)}`);
    return { files, errors };
  }
  if (!isPathInsideDirectory(root, realPluginsRoot)) {
    errors.push('The plugins folder resolves outside the opened workspace.');
    return { files, errors };
  }

  let entries;
  try {
    entries = await fs.promises.readdir(realPluginsRoot, { withFileTypes: true });
  } catch (error) {
    errors.push(`The plugins folder could not be read: ${unwrapErrorMessage(error)}`);
    return { files, errors };
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (directories.length > PLUGIN_SCAN_MAX_FILES) {
    errors.push(`Only the first ${PLUGIN_SCAN_MAX_FILES} plugin folders were scanned.`);
  }

  for (const entry of directories.slice(0, PLUGIN_SCAN_MAX_FILES)) {
    const manifestPath = path.join(realPluginsRoot, entry.name, 'plugin.json');
    const relative = path.relative(root, manifestPath).split(path.sep).join('/');
    try {
      const realManifest = await fs.promises.realpath(manifestPath);
      if (!isPathInsideDirectory(root, realManifest) || !isPathInsideDirectory(realPluginsRoot, realManifest)) {
        errors.push(`${relative}: resolves outside the workspace plugins folder.`);
        continue;
      }
      const stat = await fs.promises.stat(realManifest);
      if (!stat.isFile()) {
        errors.push(`${relative}: plugin.json is not a file.`);
        continue;
      }
      if (stat.size > PLUGIN_MANIFEST_MAX_BYTES) {
        errors.push(`${relative}: plugin.json exceeds the 256 KB limit.`);
        continue;
      }
      files.push({ path: relative, content: await fs.promises.readFile(realManifest, 'utf8') });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      errors.push(`${relative}: ${unwrapErrorMessage(error)}`);
    }
  }

  return { files, errors };
}

async function collectRuntimeWorkspace(root) {
  const files = [];
  const manifests = new Map();
  const errors = [];
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch (error) {
    errors.push(`Workspace root could not be read: ${unwrapErrorMessage(error)}`);
    return { files, manifests, errors };
  }

  const queue = [{ directory: realRoot, depth: 0 }];
  let fileCount = 0;
  let directoryCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
    } catch {
      errors.push(`Could not scan ${path.relative(realRoot, current.directory).split(path.sep).join('/') || '.'}.`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (RUNTIME_WALK_IGNORES.has(entry.name.toLowerCase())) continue;
        if (current.depth >= RUNTIME_MAX_DEPTH) continue;
        if (directoryCount >= RUNTIME_MAX_DIRECTORIES) continue;
        directoryCount += 1;
        queue.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileCount >= RUNTIME_MAX_FILES) break;
      fileCount += 1;
      const relative = path.relative(realRoot, absolute).split(path.sep).join('/');
      files.push(relative);
      if (!RUNTIME_MANIFEST_NAMES.has(entry.name.toLowerCase())) continue;
      try {
        const stat = await fs.promises.stat(absolute);
        if (stat.size > RUNTIME_MANIFEST_MAX_BYTES) {
          errors.push(`${relative} exceeds the 256 KB manifest limit and was skipped.`);
          continue;
        }
        manifests.set(relative, await fs.promises.readFile(absolute, 'utf8'));
      } catch (error) {
        errors.push(`${relative} could not be read: ${unwrapErrorMessage(error)}`);
      }
    }
    if (fileCount >= RUNTIME_MAX_FILES) break;
  }
  if (fileCount >= RUNTIME_MAX_FILES) {
    errors.push(`Runtime detection stopped after scanning ${RUNTIME_MAX_FILES} files. Open the intended project subfolder directly.`);
  }

  return { files, manifests, errors };
}

async function detectWorkspaceRuntimes(workspace) {
  const collected = await collectRuntimeWorkspace(workspace.root);
  const planned = planDualPreview({
    rootFiles: collected.files,
    manifests: collected.manifests
  });
  return {
    plans: planned.previews,
    errors: [...collected.errors, ...planned.errors]
  };
}

function registerPreviewRuntimeHandlers({
  BrowserWindow,
  dialog,
  ipcMain,
  handleMachineSensitive,
  assertTrustedRenderer,
  workspaceAccess,
  previewRuntime,
  startProtocolPreview,
  runPreviewAssertion,
  getMainWindow
}) {
  const previewStartGenerations = new Map();

  handleMachineSensitive('preview:start', async (event, workspaceId, approval = {}) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Local project preview requires an opened folder workspace.');
    }
    const generation = (previewStartGenerations.get(workspaceId) ?? 0) + 1;
    previewStartGenerations.set(workspaceId, generation);
    const assertCurrentStart = () => {
      if (previewStartGenerations.get(workspaceId) !== generation) {
        throw new Error('Local preview startup was cancelled.');
      }
    };

    const mainWindow = getMainWindow();
    const reportStatus = (message) => {
      mainWindow?.webContents.send('preview:output', { workspaceId, type: 'status', message });
    };
    reportStatus(`Checking ${path.basename(workspace.root)} for a runnable web project...`);

    const discoveredProjects = await findPreviewProjects(workspace.root);
    const projects = Array.isArray(discoveredProjects) ? discoveredProjects : [];
    assertCurrentStart();
    if (projects.length === 0) {
      const discoveredStatic = await findStaticPreviewProjects(workspace.root);
      const staticProjects = Array.isArray(discoveredStatic) ? discoveredStatic : [];
      assertCurrentStart();
      if (approval.projectKind === 'static' && approval.projectPath) {
        const selected = staticProjects.find((candidate) => candidate.relativePath === approval.projectPath);
        if (!selected) throw new Error('The selected static folder no longer contains an index.html file. Scan the workspace again.');
        const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus, selected.root);
        assertCurrentStart();
        return normalizePreviewStartResult(result);
      }
      if (approval.projectPath || approval.approved) throw new Error('The selected project no longer has a supported preview entry. Scan the workspace again before previewing.');
      if (staticProjects.length > 1) {
        reportStatus(`No runnable package script found. Found ${staticProjects.length} static site folders; choose which one to preview.`);
        return { status: 'selection-required', projects: staticProjects.map(({ relativePath }) => ({ kind: 'static', projectPath: relativePath })) };
      }
      if (staticProjects.length === 1) {
        reportStatus('No runnable package script found. Streaming the detected static website through shadrox-preview...');
        const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus, staticProjects[0].root);
        assertCurrentStart();
        return normalizePreviewStartResult(result);
      }
      reportStatus('No runnable package script or nested index.html found. Checking supported static entry folders...');
      const result = await startProtocolPreview(workspaceId, workspace.root, reportStatus);
      assertCurrentStart();
      return normalizePreviewStartResult(result);
    }
    if (approval.projectKind === 'static') throw new Error('The selected static folder is no longer available. Scan the workspace again before previewing.');
    let project = null;
    if (approval.projectPath) {
      project = projects.find((candidate) => candidate.relativePath === approval.projectPath);
      if (!project) throw new Error('The selected project folder is no longer available. Scan the workspace again.');
    } else if (projects.length === 1) {
      project = projects[0];
    } else {
      const rootProject = projects.find((candidate) => candidate.relativePath === '.');
      if (rootProject) {
        project = rootProject;
      } else {
        const choices = await Promise.all(projects.map(async (candidate) => {
          const missing = await findMissingDependencies(candidate.manifest, candidate.root);
          return {
            kind: 'node',
            projectPath: candidate.relativePath,
            manifestHash: candidate.manifestHash,
            packageManager: candidate.packageManager,
            scriptName: candidate.script.name,
            scriptCommand: candidate.script.command,
            missingDependencies: Array.isArray(missing) ? missing : []
          };
        }));
        assertCurrentStart();
        reportStatus(`Found ${choices.length} runnable web project folders. Choose which one to preview.`);
        return { status: 'selection-required', projects: choices };
      }
    }
    const { manifest } = project;
    const script = getPreviewScript(manifest);

    const manager = getPackageManager(manifest, project.root);
    const discoveredMissing = await findMissingDependencies(manifest, project.root);
    const missingDependencies = Array.isArray(discoveredMissing) ? discoveredMissing : [];
    assertCurrentStart();
    const installNotice = missingDependencies.length > 0
      ? `ShadRox will install ${missingDependencies.length} missing package(s) with "${manager} install" before starting the project: ${missingDependencies.slice(0, 12).join(', ')}${missingDependencies.length > 12 ? ', ...' : ''}.`
      : 'Existing project dependencies will be used.';
    const relativeProjectPath = path.relative(workspace.root, project.root) || '.';
    if (!approval?.approved) {
      const request = {
        workspaceId,
        manifestHash: project.manifestHash,
        projectPath: relativeProjectPath,
        packageManager: manager,
        scriptName: script.name,
        scriptCommand: script.command,
        missingDependencies
      };
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Run preview'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Approve project preview',
        message: 'This project preview may install dependencies and run its dev script.',
        detail: `${installNotice}\n\nCommand:\n${script.command}\n\nProject:\n${relativeProjectPath}`
      });
      if (choice.response !== 1) return { status: 'approval-required', approval: request };
      reportStatus(
        `Detected ${relativeProjectPath}: "${manager} run ${script.name}" (${script.command}). ` +
        `${installNotice} Starting after approval.`
      );
      approval = { ...request, approved: true };
    }
    if (approval.manifestHash !== project.manifestHash) {
      throw new Error('The project package.json changed while awaiting approval. Review the detected command and try again.');
    }
    reportStatus(
      `Detected a runnable project in ${path.relative(workspace.root, project.root) || '.'}. ` +
      `Starting "${manager} run ${script.name}". ${installNotice}`
    );
    const started = await previewRuntime.start(workspaceId, project.root, project.manifestHash);
    return normalizePreviewStartResult(started);
  });

  handleMachineSensitive('preview:stop', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    previewStartGenerations.set(workspaceId, (previewStartGenerations.get(workspaceId) ?? 0) + 1);
    return previewRuntime.stop(workspaceId);
  });

  handleMachineSensitive('preview:status', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return { running: false, status: 'idle', url: null, port: null, script: null, hmr: false, backendUrl: null, backendPort: null, lastError: null, recentOutput: '' };
    }
    return previewRuntime.getStatus(workspaceId);
  });

  handleMachineSensitive('preview:assert', async (event, workspaceId, options) => {
    assertTrustedRenderer(event);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return mergePreviewVerdict({ frameFound: false, detail: 'missing-workspace' });
    }
    const selectors = options && typeof options === 'object' ? options.selectors : undefined;
    return runPreviewAssertion(workspaceId, Array.isArray(selectors) ? selectors : undefined);
  });

  handleMachineSensitive('preview:capture-page', async (event, rect) => {
    assertTrustedRenderer(event);
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    if (!win) return { ok: false, error: 'No ShadRox window is open.' };
    let bounds = null;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
      bounds = {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.min(8192, Math.max(1, Math.round(rect.width))),
        height: Math.min(8192, Math.max(1, Math.round(rect.height)))
      };
    }
    try {
      const image = bounds ? await win.capturePage(bounds) : await win.capturePage();
      if (image.isEmpty()) return { ok: false, error: 'Nothing is painting in that area yet.' };
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (error) {
      return { ok: false, error: unwrapErrorMessage(error) };
    }
  });

  handleMachineSensitive('preview:save-screenshot', async (event, dataUrl) => {
    assertTrustedRenderer(event);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('Only a PNG data URL can be saved.');
    }
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (buffer.length === 0 || buffer.length > 32 * 1024 * 1024) throw new Error('That screenshot is not savable.');
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    const choice = await dialog.showSaveDialog({
      window: win ?? undefined,
      title: 'Save preview screenshot',
      defaultPath: `shadrox-preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(choice.filePath, buffer);
    return { ok: true, path: choice.filePath };
  });

  ipcMain.handle('plugins:scan', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return scanWorkspacePlugins(workspaceAccess.getWorkspace(workspaceId));
  });

  ipcMain.handle('runtime:detect', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace?.root) {
      return { plans: [], errors: ['Runtime detection requires an opened workspace.'] };
    }
    return detectWorkspaceRuntimes(workspace);
  });

  handleMachineSensitive('preview:start-backend', async (event, workspaceId, requestedPort) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Backend preview requires an opened folder workspace.');
    }

    const detected = await detectWorkspaceRuntimes(workspace);
    const detectedPlans = Array.isArray(detected?.plans) ? detected.plans : [];
    const detectedErrors = Array.isArray(detected?.errors) ? detected.errors : [];
    const plan = detectedPlans.find((candidate) => candidate && candidate.kind === 'backend');
    if (!plan) {
      throw new Error(detectedErrors.join(' ') || 'No backend runtime was detected for this workspace.');
    }

    const chosenPort = requestedPort === undefined || requestedPort === null ? plan.port : requestedPort;
    if (!Number.isInteger(chosenPort) || chosenPort < 1 || chosenPort > 65535) {
      throw new Error('Backend preview port must be an integer between 1 and 65535.');
    }
    const planArgs = Array.isArray(plan.args) ? plan.args : [];
    const args = chosenPort === plan.port
      ? planArgs
      : planArgs.map((argument) => String(argument).split(String(plan.port)).join(String(chosenPort)));

    const absoluteCwd = path.resolve(workspace.root, plan.cwd === '.' ? '' : String(plan.cwd || ''));
    if (!isPathInsideDirectory(workspace.root, absoluteCwd)) {
      throw new Error('The detected backend project is outside the opened workspace.');
    }
    const cwdStat = await fs.promises.stat(absoluteCwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error('The detected backend project folder no longer exists. Rescan runtimes and try again.');
    }

    const resolvedCommand = resolveExecutable(plan.command, { root: workspace.root, cwd: absoluteCwd });
    if (!resolvedCommand) {
      throw new Error(
        `"${plan.command}" was not found on PATH outside this workspace. Install the runtime, then rescan.`
      );
    }

    const approval = await dialog.showMessageBox(getMainWindow(), {
      type: 'question',
      title: 'Start backend preview?',
      message: `Allow ShadRox to start the detected ${plan.adapter} backend?`,
      detail: truncatePreviewText([
        `Command: ${resolvedCommand}`,
        `Arguments: ${args.join(' ') || '(none)'}`,
        `Directory: ${absoluteCwd}`,
        `Port: ${chosenPort}`,
        `Health check: http://127.0.0.1:${chosenPort}${plan.healthPath || '/'}`,
        '',
        'This starts a local server process that can read and modify files in its directory.'
      ].join('\n'), 4000),
      buttons: ['Cancel', 'Start backend'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (approval.response !== 1) throw new Error('Backend preview cancelled.');

    const started = await previewRuntime.startPlan(
      workspaceId,
      { ...plan, args, cwd: absoluteCwd, port: chosenPort },
      { root: workspace.root }
    );
    return { status: 'ready', url: started.url, script: plan.adapter, hmr: false };
  });

  handleMachineSensitive('preview:stop-backend', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    return previewRuntime.stopBackend(workspaceId);
  });
}

module.exports = {
  scanWorkspacePlugins,
  collectRuntimeWorkspace,
  detectWorkspaceRuntimes,
  registerPreviewRuntimeHandlers
};
