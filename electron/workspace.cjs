const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_FILES = 400;
const MAX_ASSETS = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const DIRECTORY_PAGE_SIZE = 200;
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
  '.svg': 'image/svg+xml',
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
  if (fileName.startsWith('.')) return true;
  const ext = path.extname(fileName).toLowerCase();
  return BINARY_EXTENSIONS.has(ext) && !isPreviewAsset(fileName);
}

async function resolveWorkspaceDirectory(workspace, relativePath = '', create = false) {
  const clean = relativePath ? normalizeRelativePath(relativePath) : '';
  let current = workspace.root;
  const segments = clean ? clean.split('/') : [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return path.resolve(current, ...segments.slice(index));
      await fs.mkdir(next);
      stat = await fs.lstat(next);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The directory path contains a symbolic link or non-directory.');
    const real = await fs.realpath(next);
    if (!isWithinRoot(workspace.root, real)) throw new Error('The directory resolves outside the opened workspace.');
    current = real;
  }
  return current;
}

function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function resolveWorkspaceFile(workspace, relativePath) {
  const clean = normalizeRelativePath(relativePath);
  if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) {
    throw new Error('Hidden and generated project files are not available in the editor.');
  }
  if (isIgnoredFile(path.posix.basename(clean)) || isPreviewAsset(clean)) throw new Error('Binary and generated files cannot be opened as text.');
  const segments = clean.split('/');
  let absolute;
  if (workspace.fileMap.has(clean)) {
    const mapped = workspace.fileMap.get(clean);
    if (!isWithinRoot(workspace.root, mapped)) throw new Error('The file path resolves outside the opened workspace.');
    const parent = await fs.realpath(path.dirname(mapped));
    if (parent !== workspace.root && !isWithinRoot(workspace.root, parent)) throw new Error('The file path resolves outside the opened workspace.');
    absolute = path.join(parent, path.basename(mapped));
  } else {
    const parent = await resolveWorkspaceDirectory(workspace, segments.slice(0, -1).join('/'));
    absolute = path.join(parent, segments.at(-1));
  }
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not opened in the workspace editor.');
  if (!stat.isFile()) throw new Error('The requested path is not a regular file.');
  if (stat.size > MAX_TEXT_BYTES) throw new Error('The file exceeds the 2 MiB editor limit.');
  return { clean, realPath: absolute };
}

async function readTextFile(absolutePath, relativePath, files, fileMap) {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return false;

  const content = await fs.readFile(absolutePath, 'utf8');
  files.push({ name: relativePath, content, version: hashContent(content) });
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

function createWorkspaceAccess() {
  const workspaces = new Map();

  async function openFolder(folderPath) {
    const root = await fs.realpath(folderPath);
    const fileMap = new Map();

    const workspaceId = randomUUID();
    workspaces.set(workspaceId, { root, fileMap, mode: 'folder' });
    return {
      workspaceId,
      rootPath: root,
      name: path.basename(root),
      kind: 'folder',
      files: [],
      assets: {},
      warnings: []
    };
  }

  async function openFiles(filePaths) {
    const files = [];
    const fileMap = new Map();
    const assets = {};
    const warnings = [];
    const openedPaths = [];

    for (const filePath of filePaths.slice(0, MAX_FILES)) {
      const absolutePath = await fs.realpath(filePath);
      const name = path.basename(absolutePath);
      if (fileMap.has(name)) {
        throw new Error(`More than one selected file is named "${name}". Open the containing folder to preserve paths.`);
      }
      openedPaths.push(absolutePath);

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
    const root = path.dirname(openedPaths[0]);
    workspaces.set(workspaceId, { root, fileMap, mode: 'files' });
    return {
      workspaceId,
      rootPath: root,
      filePaths: openedPaths,
      name: files.length === 1 ? files[0].name : `${files.length} files`,
      kind: 'file',
      files,
      assets,
      warnings
    };
  }

  async function readFile(workspaceId, relativePath) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder before reading.');
    const { clean, realPath } = await resolveWorkspaceFile(workspace, relativePath);
    const content = await fs.readFile(realPath, 'utf8');
    workspace.fileMap.set(clean, realPath);
    return { name: clean, content, version: hashContent(content) };
  }

  async function listDirectory(workspaceId, relativePath = '', cursor = 0) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.mode !== 'folder') throw new Error('Directory browsing requires an opened folder workspace.');
    const clean = relativePath ? normalizeRelativePath(relativePath) : '';
    if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) {
      throw new Error('Hidden and generated project directories cannot be browsed.');
    }
    const realDirectory = await resolveWorkspaceDirectory(workspace, clean);
    const stat = await fs.stat(realDirectory);
    if (!stat.isDirectory()) throw new Error('The requested path is not a directory.');
    const entries = await fs.readdir(realDirectory, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .filter((entry) => !entry.isDirectory() || !IGNORED_DIRECTORIES.has(entry.name))
      .filter((entry) => entry.isDirectory() || (!isIgnoredFile(entry.name) && !isPreviewAsset(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const page = visible.slice(offset, offset + DIRECTORY_PAGE_SIZE).map((entry) => ({
      name: entry.name,
      path: clean ? `${clean}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file'
    }));
    return { entries: page, nextCursor: offset + page.length < visible.length ? offset + page.length : null };
  }

  async function renameFile(workspaceId, fromPath, toPath) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder before renaming.');
    const source = await resolveWorkspaceFile(workspace, fromPath);
    const cleanTo = normalizeRelativePath(toPath);
    if (cleanTo.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part)) ||
      isIgnoredFile(path.posix.basename(cleanTo)) || isPreviewAsset(cleanTo)) {
      throw new Error('That destination name is not an editable workspace file.');
    }
    if (cleanTo === source.clean) return { name: cleanTo, content: null, version: null };

    const parts = cleanTo.split('/');
    const parent = await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/'), true);
    const target = path.join(parent, parts.at(-1));
    const existing = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) throw new Error('A file already exists at that destination.');

    await fs.rename(source.realPath, target);
    workspace.fileMap.delete(source.clean);
    workspace.fileMap.set(cleanTo, target);
    const content = await fs.readFile(target, 'utf8');
    return { name: cleanTo, content, version: hashContent(content) };
  }

  async function searchFiles(workspaceId, rawQuery, rawLimit) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open.');
    const query = typeof rawQuery === 'string' ? rawQuery : '';
    if (query.length < 2) return [];
    const limit = Math.min(Number.isSafeInteger(rawLimit) ? rawLimit : 80, 200);
    const needle = query.toLowerCase();
    const results = [];
    let scanned = 0;
    const pending = [''];

    while (pending.length > 0 && results.length < limit && scanned < 2000) {
      const relative = pending.pop();
      let entries;
      try {
        entries = await fs.readdir(relative ? path.join(workspace.root, relative) : workspace.root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const childPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(childPath);
          continue;
        }
        if (!entry.isFile() || isIgnoredFile(entry.name) || isPreviewAsset(entry.name)) continue;
        scanned += 1;
        let content;
        try {
          const absolute = path.join(workspace.root, childPath);
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_TEXT_BYTES) continue;
          content = await fs.readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < limit; index += 1) {
          const line = lines[index];
          const column = line.toLowerCase().indexOf(needle);
          if (column < 0) continue;
          results.push({
            name: childPath,
            line: index + 1,
            column: column + 1,
            preview: line.trim().slice(0, 200)
          });
        }
        if (results.length >= limit) break;
      }
    }
    return results;
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
        const hadMappedPath = workspace.fileMap.has(relativePath);
        if (!hadMappedPath) {
          if (workspace.mode !== 'folder') {
            throw new Error('New files can only be created in a folder workspace.');
          }
        }
        const pathParts = relativePath.split('/');
        let target;
        if (hadMappedPath) {
          const mapped = workspace.fileMap.get(relativePath);
          if (!isWithinRoot(workspace.root, mapped)) throw new Error('The destination is outside the opened workspace.');
          const parent = await fs.realpath(path.dirname(mapped));
          if (parent !== workspace.root && !isWithinRoot(workspace.root, parent)) throw new Error('The destination is outside the opened workspace.');
          target = path.join(parent, path.basename(mapped));
        } else {
          const parent = await resolveWorkspaceDirectory(workspace, pathParts.slice(0, -1).join('/'), true);
          target = path.join(parent, pathParts.at(-1));
        }
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

        if (file.expectedVersion !== undefined) {
          const current = await fs.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          const currentVersion = current === null ? null : hashContent(current);
          if (currentVersion !== (file.expectedVersion || null)) throw new Error('This file changed on disk. Reload it before saving to avoid overwriting external changes.');
        }

        temporaryPath = path.join(path.dirname(target), `.shadrox-${randomUUID()}.tmp`);
        await fs.writeFile(temporaryPath, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        if (hadMappedPath) {
          await fs.rename(temporaryPath, target);
        } else {
          await fs.link(temporaryPath, target);
          await fs.unlink(temporaryPath);
        }
        workspace.fileMap.set(relativePath, target);
        saved.push(relativePath);
        if (!workspace.fileMap.has(relativePath)) workspace.fileMap.set(relativePath, target);
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

  async function stageFiles(workspaceId, requestedFiles) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open.');
    if (!Array.isArray(requestedFiles) || requestedFiles.length === 0 || requestedFiles.length > MAX_FILES) throw new Error('A staged change must contain between 1 and 400 files.');
    const staged = [];
    for (const file of requestedFiles) {
      const clean = normalizeRelativePath(file?.name);
      const content = file?.content;
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error(`${clean} is missing content or exceeds the 2 MiB write limit.`);
      if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part)) || isIgnoredFile(path.posix.basename(clean)) || isPreviewAsset(clean)) {
        throw new Error(`${clean} is not an editable workspace file.`);
      }
      let target;
      if (workspace.fileMap.has(clean)) {
        target = (await resolveWorkspaceFile(workspace, clean)).realPath;
      } else {
        if (workspace.mode !== 'folder') throw new Error(`Cannot create ${clean} in a file-only workspace.`);
        const parts = clean.split('/');
        const parent = await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/'));
        target = path.join(parent, parts.at(-1));
        const existing = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (existing?.isSymbolicLink() || (existing && !workspace.fileMap.has(clean))) throw new Error(`A file already exists at ${clean}.`);
      }
      const current = await fs.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      const version = current === null ? null : hashContent(current);
      if (file.expectedVersion !== undefined && (file.expectedVersion || null) !== version) throw new Error(`${clean} changed on disk. Reload it before staging changes.`);
      staged.push({ name: clean, before: current, after: content, expectedVersion: version });
    }
    const transactionId = randomUUID();
    workspace.transactions ??= new Map();
    workspace.transactions.set(transactionId, staged);
    return { transactionId, files: staged.map(({ name, before, after }) => ({ name, before, after })) };
  }

  async function commitTransaction(workspaceId, transactionId) {
    const workspace = workspaces.get(workspaceId);
    const transaction = workspace?.transactions?.get(transactionId);
    if (!workspace || !transaction) throw new Error('The staged change expired. Generate it again.');
    const files = [];
    for (const file of transaction) {
      const parts = file.name.split('/');
      const target = workspace.fileMap.has(file.name)
        ? (await resolveWorkspaceFile(workspace, file.name)).realPath
        : path.join(await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/')), parts.at(-1));
      const existing = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing?.isSymbolicLink() || (existing && !workspace.fileMap.has(file.name))) throw new Error(`A file appeared at ${file.name} after the proposal was prepared.`);
      const current = await fs.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if ((current === null ? null : hashContent(current)) !== file.expectedVersion) throw new Error(`${file.name} changed after the proposal was prepared. Generate it again.`);
      files.push({ name: file.name, content: file.after, expectedVersion: file.expectedVersion });
    }
    const result = await saveFiles(workspaceId, files);
    if (result.errors.length) return result;
    workspace.transactions.delete(transactionId);
    return result;
  }

  function discardTransaction(workspaceId, transactionId) {
    const workspace = workspaces.get(workspaceId);
    workspace?.transactions?.delete(transactionId);
  }

  function getWorkspace(workspaceId) {
    return workspaces.get(workspaceId) ?? null;
  }

  function closeWorkspace(workspaceId) {
    workspaces.delete(workspaceId);
  }

  return { openFolder, openFiles, listDirectory, readFile, renameFile, searchFiles, saveFiles, stageFiles, commitTransaction, discardTransaction, getWorkspace, closeWorkspace };
}

module.exports = { createWorkspaceAccess, normalizeRelativePath, isWithinRoot };
