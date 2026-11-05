'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function isMissingPath(error) {
  return error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
}

function createWorkspaceConsent({ platform = process.platform } = {}) {
  const folders = new Set();
  const files = new Set();

  function key(realPath) {
    const normalized = path.normalize(realPath);
    return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  async function resolveKey(target) {
    if (typeof target !== 'string' || !target.trim()) return null;
    try {
      return key(await fs.realpath(target));
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
  }

  return {
    async grantFolder(target) {
      const resolved = await resolveKey(target);
      if (resolved === null) throw new Error('Cannot grant consent to a folder that does not exist.');
      folders.add(resolved);
    },

    async hasFolder(target) {
      const resolved = await resolveKey(target);
      return resolved !== null && folders.has(resolved);
    },

    async grantFiles(targets) {
      if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== 'string' || !target.trim())) {
        throw new Error('At least one valid file path is required for consent.');
      }
      const resolved = await Promise.all(targets.map(resolveKey));
      if (resolved.some((target) => target === null)) {
        throw new Error('Cannot grant consent to a file that does not exist.');
      }
      for (const target of resolved) files.add(target);
    },

    async hasFiles(targets) {
      if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== 'string' || !target.trim())) {
        return false;
      }
      const resolved = await Promise.all(targets.map(resolveKey));
      return resolved.every((target) => target !== null && files.has(target));
    }
  };
}

async function resolveFolderReopen(targetPath, consent, chooseFolder) {
  if (await consent.hasFolder(targetPath)) return targetPath;
  const selection = await chooseFolder();
  if (selection?.canceled || !Array.isArray(selection?.filePaths) || selection.filePaths.length !== 1) return null;
  const [selectedPath] = selection.filePaths;
  if (typeof selectedPath !== 'string' || !selectedPath.trim()) return null;
  return selectedPath;
}

async function resolveFileReopen(targetPaths, consent, chooseFiles) {
  if (await consent.hasFiles(targetPaths)) return targetPaths;
  const selection = await chooseFiles();
  if (selection?.canceled || !Array.isArray(selection?.filePaths) || selection.filePaths.length === 0) return null;
  if (selection.filePaths.some((filePath) => typeof filePath !== 'string' || !filePath.trim())) return null;
  return selection.filePaths;
}

module.exports = {
  createWorkspaceConsent,
  resolveFileReopen,
  resolveFolderReopen
};
