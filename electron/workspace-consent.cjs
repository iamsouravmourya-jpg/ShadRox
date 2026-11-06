'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function isMissingPath(error) {
  return error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
}

/**
 * Consent has to outlive the process, or every recent entry falls back to the
 * folder picker on the next launch — the user already chose that folder once,
 * in a native dialog, so asking again is the bug, not the safeguard.
 *
 * The file is a plain list of real paths this machine has been granted; it
 * never contains anything the renderer sent, only the resolved paths main
 * itself let through a dialog. Reads are best-effort: a corrupt or missing
 * file means "nothing consented yet", never a crash at startup.
 */
function readConsentedFile(storageFile, key) {
  if (!storageFile) return { folders: new Set(), files: new Set() };
  try {
    const parsed = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    const list = (value) => new Set(
      (Array.isArray(value) ? value : []).filter((entry) => typeof entry === 'string' && entry.trim()).map(key)
    );
    return { folders: list(parsed?.folders), files: list(parsed?.files) };
  } catch {
    return { folders: new Set(), files: new Set() };
  }
}

async function writeConsentedFile(storageFile, folders, files) {
  if (!storageFile) return;
  const payload = `${JSON.stringify({ version: 1, folders: [...folders], files: [...files] }, null, 2)}\n`;
  const tempPath = `${storageFile}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(storageFile), { recursive: true });
  await fsp.writeFile(tempPath, payload, 'utf8');
  await fsp.rename(tempPath, storageFile);
}

function createWorkspaceConsent({ platform = process.platform, storageFile = null } = {}) {
  function key(realPath) {
    const normalized = path.normalize(realPath);
    return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  const persisted = readConsentedFile(storageFile, key);
  const folders = persisted.folders;
  const files = persisted.files;
  let saving = Promise.resolve();

  /** Serialised so two grants cannot interleave into one half-written file. */
  function save() {
    saving = saving
      .then(() => writeConsentedFile(storageFile, folders, files))
      .catch(() => { /* A failed write leaves the in-memory grant intact. */ });
    return saving;
  }

  async function resolveKey(target) {
    if (typeof target !== 'string' || !target.trim()) return null;
    try {
      return key(await fsp.realpath(target));
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
      await save();
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
      await save();
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
