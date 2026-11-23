'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const chokidar = require('chokidar');
const { sanitizeProjectName } = require('../project-scaffold.cjs');
const { resolveFileReopen, resolveFolderReopen } = require('../workspace-consent.cjs');
const { verifyChangeSet } = require('../change-verify.cjs');
const { getDefaultBetaLogger } = require('../beta-logger.cjs');

function createWorkspaceService({
  app,
  dialog,
  ipcMain,
  workspaceAccess,
  workspaceConsent,
  previewRuntime,
  debugHost,
  typeScriptService,
  machineDelta,
  machineReceipt,
  terminalSessions,
  commandJobs,
  killProcessTree,
  assertTrustedRenderer,
  handleMachineSensitive,
  getMainWindow,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  getRendererDirty,
  getMachineSensitiveOperations
}) {
  const workspaceWatchers = new Map();

  function stopWorkspaceServices(workspaceId) {
    debugHost.stopWorkspace(workspaceId);
    typeScriptService.closeWorkspace(workspaceId);
    const watcher = workspaceWatchers.get(workspaceId);
    if (watcher) {
      workspaceWatchers.delete(workspaceId);
      void watcher.close();
    }
    for (const [sessionId, sessionInfo] of terminalSessions) {
      if (sessionInfo.workspaceId !== workspaceId) continue;
      terminalSessions.delete(sessionId);
      try { sessionInfo.forwarder?.dispose(); } catch { /* forwarder already settled */ }
      try { sessionInfo.terminal.kill(); } catch { /* process already exited */ }
    }
    for (const job of commandJobs.list(workspaceId)) {
      if (job.status !== 'running') continue;
      const prevReason = job.killedReason;
      job.killedReason = 'user';
      void killProcessTree(job.child).then((killed) => {
        if (!killed && job.status === 'running') {
          job.killedReason = prevReason;
          console.error('[jobs] failed to terminate workspace job during close', { jobId: job.id, pid: job.child?.pid });
        }
      }).catch((error) => {
        if (job.status === 'running') job.killedReason = prevReason;
        console.error('[jobs] workspace job termination errored', error);
      });
    }
  }

  function watchWorkspace(workspaceId, root) {
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (value) => {
        const relative = path.relative(root, value);
        return relative.split(path.sep).some((part) => part.startsWith('.') || ['node_modules', 'dist', 'build', '.next', 'out', 'coverage', 'vendor', 'shadrox-backups'].includes(part));
      },
      awaitWriteFinish: { stabilityThreshold: 220, pollInterval: 60 }
    });
    const changes = new Map();
    let timer;
    const flush = () => {
      timer = null;
      if (!changes.size) return;
      getMainWindow()?.webContents.send('workspace:change', {
        workspaceId,
        changes: [...changes.values()]
      });
      changes.clear();
    };
    watcher.on('all', (event, absolutePath) => {
      if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
      const relative = path.relative(root, absolutePath).split(path.sep).join('/');
      if (!relative || relative.startsWith('../')) return;
      changes.set(relative, { path: relative, kind: event });
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    });
    watcher.on('error', (error) => console.warn('[workspace] watcher error', error));
    workspaceWatchers.set(workspaceId, watcher);
  }

  async function openFolderWorkspace(rootPath) {
    const opened = await workspaceAccess.openFolder(rootPath);
    try {
      await workspaceConsent.grantFolder(opened.rootPath);
      await previewRuntime.stopAll();
    } catch (error) {
      workspaceAccess.closeWorkspace(opened.workspaceId);
      throw error;
    }
    const previousWorkspaceId = getActiveWorkspaceId();
    if (previousWorkspaceId) {
      stopWorkspaceServices(previousWorkspaceId);
      workspaceAccess.closeWorkspace(previousWorkspaceId);
    }
    setActiveWorkspaceId(opened.workspaceId);
    watchWorkspace(opened.workspaceId, workspaceAccess.getWorkspace(opened.workspaceId).root);
    return opened;
  }

  async function openFilesWorkspace(filePaths) {
    const previousWorkspaceId = getActiveWorkspaceId();
    const opened = await workspaceAccess.openFiles(filePaths);
    if (!opened) return null;
    try {
      await workspaceConsent.grantFiles(opened.filePaths);
      await previewRuntime.stopAll();
    } catch (error) {
      workspaceAccess.closeWorkspace(opened.workspaceId);
      throw error;
    }
    if (previousWorkspaceId) {
      stopWorkspaceServices(previousWorkspaceId);
      workspaceAccess.closeWorkspace(previousWorkspaceId);
    }
    setActiveWorkspaceId(opened.workspaceId);
    return opened;
  }

  function registerWorkspaceHandlers() {
    handleMachineSensitive('workspace:open-folder', async (event) => {
      assertTrustedRenderer(event);
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Open workspace folder',
        properties: ['openDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return openFolderWorkspace(result.filePaths[0]);
    });

    handleMachineSensitive('workspace:open-files', async (event) => {
      assertTrustedRenderer(event);
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Open code files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Code and text files', extensions: ['*'] }]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return openFilesWorkspace(result.filePaths);
    });

    handleMachineSensitive('workspace:new-file', async (event) => {
      assertTrustedRenderer(event);
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Create a new file',
        defaultPath: 'untitled.md',
        filters: [{ name: 'All files', extensions: ['*'] }]
      });
      if (result.canceled || !result.filePath) return null;
      await fs.promises.mkdir(path.dirname(result.filePath), { recursive: true });
      await fs.promises.writeFile(result.filePath, '', 'utf8');
      return openFilesWorkspace([result.filePath]);
    });

    handleMachineSensitive('workspace:new-project', async (event, rawName) => {
      assertTrustedRenderer(event);
      const name = sanitizeProjectName(rawName);
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: `Choose where to create "${name}"`,
        buttonLabel: 'Create project here',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const root = path.join(result.filePaths[0], name);
      const existing = await fs.promises.readdir(root).catch(() => null);
      if (existing && existing.length > 0) {
        throw new Error(`"${name}" already exists at that location and is not empty. Choose another location or name — nothing was overwritten.`);
      }
      await fs.promises.mkdir(root, { recursive: true });
      return openFolderWorkspace(root);
    });

    handleMachineSensitive('workspace:reopen', async (event, target) => {
      assertTrustedRenderer(event);
      if (!target || typeof target !== 'object') throw new Error('Invalid recent workspace.');

      if (target.kind === 'folder') {
        if (typeof target.path !== 'string' || target.path.length === 0) {
          throw new Error('This recent folder has no stored location.');
        }
        const selectedPath = await resolveFolderReopen(target.path, workspaceConsent, () =>
          dialog.showOpenDialog(getMainWindow(), {
            title: 'Select a workspace folder to reopen',
            properties: ['openDirectory']
          })
        );
        if (!selectedPath) return null;
        return openFolderWorkspace(selectedPath);
      }

      if (target.kind === 'file') {
        const filePaths = Array.isArray(target.filePaths)
          ? target.filePaths.filter((entry) => typeof entry === 'string' && entry.length > 0)
          : [];
        if (filePaths.length === 0) throw new Error('This recent entry has no stored file paths.');
        const selectedPaths = await resolveFileReopen(filePaths, workspaceConsent, () =>
          dialog.showOpenDialog(getMainWindow(), {
            title: 'Select code files to reopen',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Code and text files', extensions: ['*'] }]
          })
        );
        if (!selectedPaths) return null;
        for (const filePath of selectedPaths) {
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (!stat?.isFile()) throw new Error(`${path.basename(filePath)} no longer exists.`);
        }
        const opened = await openFilesWorkspace(selectedPaths);
        if (!opened) throw new Error('Those files could not be reopened.');
        return opened;
      }

      throw new Error('Unknown recent workspace type.');
    });

    handleMachineSensitive('workspace:close', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      if (workspaceAccess.getWorkspace(workspaceId)) {
        await previewRuntime.stop(workspaceId);
        stopWorkspaceServices(workspaceId);
        workspaceAccess.closeWorkspace(workspaceId);
      }
      if (getActiveWorkspaceId() === workspaceId) setActiveWorkspaceId(null);
    });

    ipcMain.handle('machine:begin', async (event, workspaceId, checkpointId) => {
      assertTrustedRenderer(event);
      return machineDelta.begin(workspaceId, checkpointId);
    });
    ipcMain.handle('machine:finish', async (event, workspaceId, checkpointId) => {
      assertTrustedRenderer(event);
      return machineDelta.finish(workspaceId, checkpointId);
    });
    ipcMain.handle('machine:inspect', (event, workspaceId, checkpointId) => {
      assertTrustedRenderer(event);
      return machineDelta.inspect(workspaceId, checkpointId);
    });
    handleMachineSensitive('machine:export-receipt', async (event, workspaceId, checkpointId) => {
      assertTrustedRenderer(event);
      return machineReceipt.exportReceipt(workspaceId, checkpointId);
    });
    handleMachineSensitive('machine:verify-receipt', async (event, workspaceId, receiptId) => {
      assertTrustedRenderer(event);
      return machineReceipt.verifyReceipt(workspaceId, receiptId);
    });
    ipcMain.handle('machine:restore', async (event, workspaceId, checkpointId) => {
      assertTrustedRenderer(event);
      if (getRendererDirty()) throw new Error('Save or discard unsaved editor changes before machine rewind.');
      if (getMachineSensitiveOperations()) throw new Error('Wait for workspace commands and operations to finish before rewind.');
      try {
        return await machineDelta.restore(workspaceId, checkpointId, async (report) => {
          const answer = await dialog.showMessageBox(getMainWindow(), {
            type: 'warning', title: 'Rewind captured machine changes?',
            message: `Restore ${report.files.length} captured files${report.git.positionChanged ? ', rewind the local Git ref/index' : ''} and stop ${report.previews.started.length} ShadRox-owned previews?`,
            detail: 'This is not a full-machine restore. Installed packages, running terminals, stopped processes and remote effects are not undone. Stop other commands that may write to these files before continuing.',
            buttons: ['Cancel', 'Rewind captured changes'], defaultId: 0, cancelId: 0, noLink: true
          });
          if (getRendererDirty()) throw new Error('Unsaved editor changes appeared; nothing was restored.');
          return answer.response === 1;
        });
      } catch (error) {
        getDefaultBetaLogger().record({
          level: 'error',
          source: 'ipc',
          event: 'machine:restore_failed',
          message: error instanceof Error ? error.message : String(error),
          meta: { checkpointId }
        });
        throw error;
      }
    });

    handleMachineSensitive('workspace:list-directory', async (event, workspaceId, relativePath, cursor) => {
      assertTrustedRenderer(event);
      return workspaceAccess.listDirectory(workspaceId, relativePath, cursor);
    });

    handleMachineSensitive('workspace:read-file', async (event, workspaceId, relativePath) => {
      assertTrustedRenderer(event);
      return workspaceAccess.readFile(workspaceId, relativePath);
    });

    handleMachineSensitive('workspace:load-files', async (event, workspaceId, relativePaths, options) => {
      assertTrustedRenderer(event);
      return workspaceAccess.loadFiles(workspaceId, relativePaths, options);
    });

    handleMachineSensitive('workspace:project-docs', async (event, workspaceId) => {
      assertTrustedRenderer(event);
      return workspaceAccess.projectDocs(workspaceId);
    });

    handleMachineSensitive('workspace:rename-file', async (event, workspaceId, fromPath, toPath) => {
      assertTrustedRenderer(event);
      const result = await workspaceAccess.renameFile(workspaceId, fromPath, toPath);
      await typeScriptService?.invalidateFiles?.(workspaceId, [fromPath, toPath]);
      return result;
    });

    handleMachineSensitive('workspace:create-directory', async (event, workspaceId, relativePath) => {
      assertTrustedRenderer(event);
      return workspaceAccess.createDirectory(workspaceId, relativePath);
    });

    handleMachineSensitive('workspace:delete-path', async (event, workspaceId, relativePath) => {
      assertTrustedRenderer(event);
      const result = await workspaceAccess.deletePath(workspaceId, relativePath);
      await typeScriptService?.invalidateFiles?.(workspaceId, [relativePath]);
      return result;
    });

    handleMachineSensitive('workspace:search-files', async (event, workspaceId, query, limit) => {
      assertTrustedRenderer(event);
      return workspaceAccess.searchFiles(workspaceId, query, limit);
    });

    handleMachineSensitive('workspace:search-content', async (event, workspaceId, options) => {
      assertTrustedRenderer(event);
      return workspaceAccess.searchContent(workspaceId, options);
    });

    handleMachineSensitive('workspace:save-files', async (event, workspaceId, files) => {
      assertTrustedRenderer(event);
      const result = await workspaceAccess.saveFiles(workspaceId, files);
      if (Array.isArray(result?.saved) && result.saved.length > 0) {
        await typeScriptService?.invalidateFiles?.(workspaceId, result.saved);
      }
      return result;
    });

    handleMachineSensitive('workspace:backup-file', async (event, workspaceId, relativePath, content) => {
      assertTrustedRenderer(event);
      const workspace = workspaceAccess.getWorkspace(workspaceId);
      if (!workspace?.root) {
        throw new Error('File backup requires an opened workspace.');
      }
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        throw new Error('Backup path is required.');
      }
      if (typeof content !== 'string') {
        throw new Error('Backup content must be a string.');
      }
      const cleanRel = relativePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
      if (!cleanRel || cleanRel.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Invalid relative backup path.');
      }
      const workspaceHash = createHash('sha256').update(workspace.root).digest('hex').slice(0, 16);
      const backupDir = path.join(app.getPath('userData'), 'file-backups', workspaceHash);
      fs.mkdirSync(backupDir, { recursive: true });
      const safeName = `${cleanRel.replace(/\//g, '__')}.${Date.now()}.bak`;
      const backupPath = path.join(backupDir, safeName);
      fs.writeFileSync(backupPath, content, 'utf8');
      return { backupPath };
    });

    handleMachineSensitive('workspace:stage-files', async (event, workspaceId, files) => {
      assertTrustedRenderer(event);
      return workspaceAccess.stageFiles(workspaceId, files);
    });

    handleMachineSensitive('workspace:commit', async (event, workspaceId, transactionId) => {
      assertTrustedRenderer(event);
      const result = await workspaceAccess.commitTransaction(workspaceId, transactionId);
      if (Array.isArray(result?.saved) && result.saved.length > 0) {
        await typeScriptService?.invalidateFiles?.(workspaceId, result.saved);
      }
      return result;
    });

    handleMachineSensitive('workspace:discard', async (event, workspaceId, transactionId) => {
      assertTrustedRenderer(event);
      workspaceAccess.discardTransaction(workspaceId, transactionId);
    });

    handleMachineSensitive('workspace:verify-change-set', async (event, workspaceId, files) => {
      assertTrustedRenderer(event);
      const workspace = workspaceAccess.getWorkspace(workspaceId);
      if (!workspace?.root) {
        throw new Error('Change verification requires an opened workspace.');
      }
      return verifyChangeSet({ root: workspace.root, files });
    });

    ipcMain.handle('ts:diagnostics', async (event, workspaceId, overrides, files) => {
      assertTrustedRenderer(event);
      return typeScriptService.diagnostics(workspaceId, overrides, files);
    });

    ipcMain.handle('ts:definition', async (event, workspaceId, relativePath, line, character, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.definition(workspaceId, relativePath, line, character, overrides);
    });

    ipcMain.handle('ts:references', async (event, workspaceId, relativePath, line, character, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.references(workspaceId, relativePath, line, character, overrides);
    });

    ipcMain.handle('ts:exported-contracts', async (event, workspaceId, relativePaths, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.exportedContracts(workspaceId, relativePaths, overrides);
    });

    ipcMain.handle('ts:rename', async (event, workspaceId, relativePath, line, character, newName, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.rename(workspaceId, relativePath, line, character, newName, overrides);
    });

    ipcMain.handle(
      'ts:code-actions',
      async (event, workspaceId, relativePath, startLine, startCharacter, endLine, endCharacter, overrides) => {
        assertTrustedRenderer(event);
        return typeScriptService.codeActions(
          workspaceId,
          relativePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          overrides
        );
      }
    );

    ipcMain.handle('ts:semantic-tokens', async (event, workspaceId, relativePath, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.semanticTokens(workspaceId, relativePath, overrides);
    });

    ipcMain.handle('ts:outline', async (event, workspaceId, relativePath, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.outline(workspaceId, relativePath, overrides);
    });

    ipcMain.handle('ts:workspace-symbols', async (event, workspaceId, query, overrides) => {
      assertTrustedRenderer(event);
      return typeScriptService.symbols(workspaceId, query, overrides);
    });
  }

  return {
    stopWorkspaceServices,
    openFolderWorkspace,
    openFilesWorkspace,
    registerWorkspaceHandlers,
    stopAllWatchers() {
      for (const workspaceId of [...workspaceWatchers.keys()]) stopWorkspaceServices(workspaceId);
    }
  };
}

module.exports = {
  createWorkspaceService
};
