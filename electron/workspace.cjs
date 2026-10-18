const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILES = 400;
const MAX_ASSETS = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__'
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.lock'
]);
const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf'
};

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A workspace-relative file path is required.');
  }

  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('Absolute paths are not allowed.');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('The file path contains an unsafe path segment.');
  }
  if (segments.some((segment) =>
    /[<>:"|?*\0]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  )) {
    throw new Error('The file path contains a name that is unsafe or invalid on Windows.');
  }

  return segments.join('/');
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isPreviewAsset(fileName) {
  return Object.hasOwn(ASSET_MIME_TYPES, path.extname(fileName).toLowerCase());
}

function isIgnoredFile(fileName) {
  return fileName.startsWith('.') || BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function ensureInsideRoot(root, target) {
  const absolute = path.resolve(root, ...target.split('/'));
  if (!isWithinRoot(root, absolute)) throw new Error('The file path resolves outside the opened workspace.');
  return absolute;
}

async function readTextFile(absolutePath, relativePath, files, fileMap) {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return false;

  const content = await fs.readFile(absolutePath, 'utf8');
  files.push({ name: relativePath, content });
  fileMap.set(relativePath, absolutePath);
  return true;
}

async function readAssetFile(absolutePath, relativePath, assets) {
  const extension = path.extname(relativePath).toLowerCase();
  if (!isPreviewAsset(relativePath) || Object.keys(assets).length >= MAX_ASSETS) return;

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return;

  const encoded = (await fs.readFile(absolutePath)).toString('base64');
  assets[relativePath] = `data:${ASSET_MIME_TYPES[extension]};base64,${encoded}`;
}

async function scanDirectory(root, directory, prefix, result, fileMap) {
  if (result.files.length >= MAX_FILES) return;

  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (result.files.length >= MAX_FILES) break;
    if (entry.isSymbolicLink()) continue;

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await scanDirectory(root, absolutePath, relativePath, result, fileMap);
      }
      continue;
    }
    if (!entry.isFile() || isIgnoredFile(entry.name)) continue;

    try {
      if (isPreviewAsset(entry.name)) {
        await readAssetFile(absolutePath, relativePath, result.assets);
      } else {
        await readTextFile(absolutePath, relativePath, result.files, fileMap);
      }
    } catch (error) {
      result.warnings.push(`Could not read ${relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

function createWorkspaceAccess() {
  const workspaces = new Map();

  async function openFolder(folderPath) {
    const root = await fs.realpath(folderPath);
    const result = { files: [], assets: {}, warnings: [] };
    const fileMap = new Map();
    await scanDirectory(root, root, '', result, fileMap);

    const workspaceId = randomUUID();
    workspaces.set(workspaceId, { root, fileMap, mode: 'folder' });
    if (result.files.length >= MAX_FILES) result.warnings.push(`Only the first ${MAX_FILES} text files were loaded.`);
    return {
      workspaceId,
      name: path.basename(root),
      kind: 'folder',
      files: result.files,
      assets: result.assets,
      warnings: result.warnings
    };
  }

  async function openFiles(filePaths) {
    const files = [];
    const fileMap = new Map();
    const assets = {};
    const warnings = [];

    for (const filePath of filePaths.slice(0, MAX_FILES)) {
      const absolutePath = await fs.realpath(filePath);
      const name = path.basename(absolutePath);
      if (fileMap.has(name)) {
        throw new Error(`More than one selected file is named "${name}". Open the containing folder to preserve paths.`);
      }

      if (isPreviewAsset(name)) {
        await readAssetFile(absolutePath, name, assets);
        continue;
      }
      if (isIgnoredFile(name)) continue;

      try {
        await readTextFile(absolutePath, name, files, fileMap);
      } catch (error) {
        warnings.push(`Could not read ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (filePaths.length > MAX_FILES) warnings.push(`Only the first ${MAX_FILES} selected files were loaded.`);
    if (files.length === 0) return null;

    const workspaceId = randomUUID();
    workspaces.set(workspaceId, {
      root: path.dirname(await fs.realpath(filePaths[0])),
      fileMap,
      mode: 'files'
    });
    return {
      workspaceId,
      name: files.length === 1 ? files[0].name : `${files.length} files`,
      kind: 'file',
      files,
      assets,
      warnings
    };
  }

  async function saveFiles(workspaceId, requestedFiles) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder before saving.');
    if (!Array.isArray(requestedFiles) || requestedFiles.length > MAX_FILES) {
      throw new Error(`A save request must contain between 1 and ${MAX_FILES} files.`);
    }

    const saved = [];
    const errors = [];
    for (const file of requestedFiles) {
      let temporaryPath;
      try {
        if (!file || typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > MAX_TEXT_BYTES) {
          throw new Error('File content is missing or exceeds the 2 MiB write limit.');
        }

        const relativePath = normalizeRelativePath(file.name);
        let target = workspace.fileMap.get(relativePath);
        const wasOpenedFile = Boolean(target);
        if (!target) {
          if (workspace.mode !== 'folder') {
            throw new Error('New files can only be created in a folder workspace.');
          }
          target = ensureInsideRoot(workspace.root, relativePath);
          await fs.mkdir(path.dirname(target), { recursive: true });
        }

        if (!isWithinRoot(workspace.root, target)) throw new Error('The destination is outside the opened workspace.');
        const realParent = await fs.realpath(path.dirname(target));
        if (realParent !== workspace.root && !isWithinRoot(workspace.root, realParent)) {
          throw new Error('The destination directory resolves outside the opened workspace.');
        }
        target = path.join(realParent, path.basename(target));
        try {
          const existing = await fs.lstat(target);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new Error('The destination is not a regular file.');
          }
          if (!workspace.fileMap.has(relativePath)) {
            throw new Error('A file already exists at this path but was not part of the opened workspace.');
          }
        } catch (error) {
          if (error && error.code !== 'ENOENT') throw error;
        }

        temporaryPath = path.join(path.dirname(target), `.shadrox-${randomUUID()}.tmp`);
        await fs.writeFile(temporaryPath, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        if (wasOpenedFile) {
          await fs.rename(temporaryPath, target);
        } else {
          await fs.link(temporaryPath, target);
          await fs.unlink(temporaryPath);
        }
        workspace.fileMap.set(relativePath, target);
        saved.push(relativePath);
      } catch (error) {
        if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
        errors.push({
          name: typeof file?.name === 'string' ? file.name : '',
          message: error instanceof Error ? error.message : 'Unknown write error.'
        });
      }
    }
    return { saved, errors };
  }

  function getWorkspace(workspaceId) {
    return workspaces.get(workspaceId) ?? null;
  }

  function closeWorkspace(workspaceId) {
    workspaces.delete(workspaceId);
  }

  return { openFolder, openFiles, saveFiles, getWorkspace, closeWorkspace };
}

module.exports = { createWorkspaceAccess, normalizeRelativePath, isWithinRoot };
