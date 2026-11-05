const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_FILES = 400;
const MAX_ASSETS = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 6000;
const MAX_PATH_BATCH = 4000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const DIRECTORY_PAGE_SIZE = 200;
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'dist_staging', 'dist_desktop', 'build', '.next', 'out', 'coverage',
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

/**
 * The config files the app owns inside a workspace, and the ones it may read
 * but never write. Everything else under a dot-directory stays invisible to the
 * editor and the save path.
 */
const SHADROX_CONFIG_PATTERN = /^\.shadrox\/(?:automations\.json|plugins\/[a-z0-9][a-z0-9-]{1,63}\/plugin\.json)$/;
/**
 * Rules and skills steer the prompt, so the chat needs to read them. They stay
 * out of `SHADROX_CONFIG_PATTERN`, which is also the write allow-list: a reply
 * must not be able to rewrite the instructions a folder gives its own assistant.
 */
const PROJECT_DOC_PATTERN = /^\.shadrox\/(?:(?:rules|skills)\/[^/]+\.md|cursorrules)$/;
const CURSOR_RULES = '.cursorrules';

function isShadroxConfigFile(clean) {
  return SHADROX_CONFIG_PATTERN.test(clean);
}

function isProjectDocFile(clean) {
  return PROJECT_DOC_PATTERN.test(clean) || clean === CURSOR_RULES;
}

function isPreviewAsset(fileName) {
  return Object.hasOwn(ASSET_MIME_TYPES, path.extname(fileName).toLowerCase());
}

function isIgnoredFile(fileName) {
  // Env files are where configuration lives; a coding agent that cannot see
  // them answers "not configured" questions wrong. Other dotfiles stay hidden.
  if (fileName.startsWith('.') && !fileName.startsWith('.env')) return true;
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
  const hidden = clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part));
  if (hidden && !isShadroxConfigFile(clean) && !isProjectDocFile(clean)) {
    throw new Error('Hidden and generated project files are not available in the editor.');
  }
  if ((isIgnoredFile(path.posix.basename(clean)) || isPreviewAsset(clean)) && !isProjectDocFile(clean)) {
    throw new Error('Binary and generated files cannot be opened as text.');
  }
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

/**
 * Folder mode: every regular file under the root belongs to the workspace, even
 * one the renderer has never opened. The write path used to refuse those with
 * "a file already exists but was not part of the opened workspace", which meant
 * an edit to any file that was not already a tab could never be saved. Adopting
 * the path here makes the write an ordinary edit; the caller's version check
 * still protects against clobbering edits made outside ShadRox.
 */
async function adoptWorkspaceFile(workspace, clean) {
  if (workspace.mode !== 'folder' || workspace.fileMap.has(clean)) return;
  if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part)) ||
    isIgnoredFile(path.posix.basename(clean)) || isPreviewAsset(clean)) {
    return;
  }
  const segments = clean.split('/');
  const parent = await resolveWorkspaceDirectory(workspace, segments.slice(0, -1).join('/'));
  const absolute = path.join(parent, segments.at(-1));
  const stat = await fs.lstat(absolute).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TEXT_BYTES) return;
  const realParent = await fs.realpath(parent);
  if (!isWithinRoot(workspace.root, realParent) && realParent !== workspace.root) return;
  workspace.fileMap.set(clean, path.join(realParent, segments.at(-1)));
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

const MAX_TREE_FILES = 5000;

/**
 * Walks the files the explorer will actually show — hidden, generated, binary
 * and asset files are skipped exactly like `listDirectory` — and returns their
 * workspace-relative paths with byte sizes. No contents are read; this is what
 * lets a 219-file folder still tell the prompt which files exist. The walk
 * stops at `MAX_TREE_FILES`; `truncated` tells the UI to render "5000+".
 *
 * Paths are sorted so the repo map is byte-identical between requests, which
 * is what makes provider prompt caching possible.
 */
async function listWorkspaceFiles(root, limit = MAX_TREE_FILES) {
  const files = [];
  let truncated = false;
  const queue = [{ directory: root, prefix: '' }];
  while (queue.length > 0) {
    if (files.length >= limit) { truncated = true; break; }
    const { directory, prefix } = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push({
            directory: path.join(directory, entry.name),
            prefix: prefix ? `${prefix}/${entry.name}` : entry.name
          });
        }
        continue;
      }
      if (!entry.isFile() || isIgnoredFile(entry.name) || isPreviewAsset(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      files.push({ path: relativePath, size: 0, absolutePath: path.join(directory, entry.name) });
      if (files.length >= limit) { truncated = true; break; }
    }
  }
  // Sequential `stat` per file added seconds of latency to large folders before
  // the explorer could paint. Sizes are cosmetic, so stat in bounded batches.
  const STAT_CONCURRENCY = 32;
  for (let index = 0; index < files.length; index += STAT_CONCURRENCY) {
    await Promise.all(
      files.slice(index, index + STAT_CONCURRENCY).map(async (file) => {
        try {
          file.size = (await fs.stat(file.absolutePath)).size;
        } catch {
          /* removed between listing and stat */
        }
      })
    );
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: files.map((file) => ({ path: file.path, size: file.size })),
    truncated
  };
}

/**
 * Prompt-shaping documents: the ones the explorer deliberately hides.
 *
 * The tree walk skips dot-paths, so `.shadrox/rules/*.md` and `.cursorrules`
 * are invisible to `listWorkspaceFiles`; without this the rules engine could
 * only ever see `SHADROX.md` and `AGENTS.md`. Same symlinks-refused,
 * ignored-directory walk, plus the one dot-directory the app owns.
 */
const PROJECT_DOC_NAMES = new Set(['shadrox.md', 'agents.md', 'qoder.md', '.cursorrules']);
const PROJECT_DOC_LIMIT = 64;

async function listProjectDocs(root) {
  const found = [];
  const queue = [{ directory: root, prefix: '' }];
  while (queue.length > 0 && found.length < PROJECT_DOC_LIMIT) {
    const { directory, prefix } = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        const insideConfig = relative === '.shadrox' || prefix === '.shadrox';
        if (entry.name.startsWith('.') && !insideConfig) continue;
        queue.push({ directory: path.join(directory, entry.name), prefix: relative });
        continue;
      }
      if (!entry.isFile()) continue;
      const underShadrox = relative.startsWith('.shadrox/rules/') || relative.startsWith('.shadrox/skills/');
      if (!underShadrox && !PROJECT_DOC_NAMES.has(entry.name.toLowerCase())) continue;
      let size = 0;
      try {
        size = (await fs.stat(path.join(directory, entry.name))).size;
      } catch {
        continue;
      }
      found.push({ path: relative, size });
      if (found.length >= PROJECT_DOC_LIMIT) break;
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Glob patterns match workspace-relative POSIX paths. `**` spans directories,
 * `*` and `?` stop at `/`; a pattern without a slash matches the file name.
 */
function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { index += 1; source += '(?:[^/]+/)*'; continue; }
        source += '.*';
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') { source += '[^/]'; continue; }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matchesInclude(relativePath, patterns) {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const scoped = pattern.includes('/');
    const target = scoped ? relativePath : path.posix.basename(relativePath);
    if (!pattern.includes('*') && !pattern.includes('?')) return target.includes(pattern);
    return globToRegExp(pattern).test(target);
  });
}

function createWorkspaceAccess() {
  const workspaces = new Map();

  async function openFolder(folderPath) {
    const root = await fs.realpath(folderPath);
    const fileMap = new Map();
    const { files: fileTree, truncated } = await listWorkspaceFiles(root);

    const workspaceId = randomUUID();
    workspaces.set(workspaceId, { root, fileMap, mode: 'folder' });
    return {
      workspaceId,
      rootPath: root,
      name: path.basename(root),
      kind: 'folder',
      files: [],
      fileTree,
      fileCount: fileTree.length,
      fileCountTruncated: truncated,
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

  /**
   * Reads many files in one round trip, skipping the ones that cannot be read
   * instead of failing the batch. The chat uses this to pull a patch's target
   * files off disk before editing them — a folder is only ever mounted as paths,
   * so the file the assistant means to edit is usually not a buffer yet.
   */
  async function loadFiles(workspaceId, requestedPaths, rawOptions) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder before reading.');
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const maxBytesPerFile = Number.isSafeInteger(options.maxBytesPerFile) && options.maxBytesPerFile > 0
      ? Math.min(options.maxBytesPerFile, MAX_TEXT_BYTES)
      : MAX_TEXT_BYTES;
    const maxTotalBytes = Number.isSafeInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
      ? options.maxTotalBytes
      : (Number.isSafeInteger(options.maxBytesPerFile) && options.maxBytesPerFile > 0 ? options.maxBytesPerFile : Number.MAX_SAFE_INTEGER);
    const paths = Array.isArray(requestedPaths) ? requestedPaths.slice(0, MAX_PATH_BATCH) : [];
    const files = [];
    const missing = [];
    let totalBytes = 0;
    for (const requested of paths) {
      try {
        const { clean, realPath } = await resolveWorkspaceFile(workspace, requested);
        const stat = await fs.stat(realPath);
        if (stat.size > maxBytesPerFile) {
          missing.push({ path: clean, reason: `larger than the ${maxBytesPerFile} byte limit for this read` });
          continue;
        }
        if (totalBytes + stat.size > maxTotalBytes) {
          missing.push({ path: clean, reason: 'the byte budget for this read is full' });
          continue;
        }
        const content = await fs.readFile(realPath, 'utf8');
        totalBytes += stat.size;
        workspace.fileMap.set(clean, realPath);
        files.push({ name: clean, content, version: hashContent(content) });
      } catch (error) {
        missing.push({ path: String(requested), reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { files, missing };
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

  /**
   * Explorer "New Folder". Dot-names and generated directories are refused for
   * the same reason they are never listed: the editor must not write into the
   * places git, node_modules and build outputs live.
   */
  async function createDirectory(workspaceId, relativePath) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder first.');
    if (workspace.mode !== 'folder') throw new Error('Folders can only be created in a folder workspace.');
    const clean = normalizeRelativePath(relativePath);
    if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) {
      throw new Error('Hidden and generated directories cannot be created.');
    }
    const parts = clean.split('/');
    const parent = await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/'), true);
    const target = path.join(parent, parts.at(-1));
    const existing = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) throw new Error('A folder already exists at that path.');

    await fs.mkdir(target);
    const real = await fs.realpath(target);
    if (!isWithinRoot(workspace.root, real)) {
      await fs.rmdir(real).catch(() => {});
      throw new Error('The new folder resolves outside the opened workspace.');
    }
    return { path: clean };
  }

  /**
   * Unlinks one regular file, or removes an empty directory. Non-empty folders
   * are refused rather than recursed: a mistyped path must never take a subtree
   * with it, and the explorer has no undo.
   */
  async function deletePath(workspaceId, relativePath) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open. Reopen its folder before deleting.');
    const clean = normalizeRelativePath(relativePath);
    if (clean.split('/').some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) {
      throw new Error('Hidden and generated project directories cannot be deleted.');
    }
    const parts = clean.split('/');
    const parent = await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/'));
    const target = path.join(parent, parts.at(-1));
    const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) throw new Error('That path is no longer in the workspace.');
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not deleted from the workspace.');

    if (stat.isDirectory()) {
      if ((await fs.readdir(target)).length > 0) throw new Error('Only an empty folder can be deleted.');
      await fs.rmdir(target);
      return { path: clean, kind: 'directory' };
    }
    if (!stat.isFile()) throw new Error('Only files and empty folders can be deleted.');
    await fs.unlink(target);
    workspace.fileMap.delete(clean);
    return { path: clean, kind: 'file' };
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

  /**
   * Bounded workspace-wide search used by the agent tool loop. Reads every
   * regular text file once, so it is capped by directory entries, bytes and
   * matches; a cap hit is reported as `truncated` rather than an error.
   */
  async function searchContent(workspaceId, rawOptions) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('This desktop workspace is no longer open.');
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const query = typeof options.query === 'string' ? options.query : '';
    if (query.length < 2) return { matches: [], truncated: false, filesScanned: 0, error: 'A search query needs at least 2 characters.' };
    const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? options.limit : 200, 1), 400);
    // One chatty README must never starve the rest of the repo out of the
    // global cap, so each file contributes at most `perFile` lines.
    const perFile = Math.min(Math.max(Number.isSafeInteger(options.perFile) ? options.perFile : 3, 1), 50);
    const namesOnly = options.namesOnly === true;
    const include = (Array.isArray(options.include)
      ? options.include
      : typeof options.include === 'string' ? [options.include] : [])
      .filter((pattern) => typeof pattern === 'string' && pattern.trim().length > 0)
      .map((pattern) => pattern.trim().replace(/\\/g, '/'));

    let regex = null;
    if (options.regex === true) {
      try {
        regex = new RegExp(query, 'gi');
      } catch (error) {
        return { matches: [], truncated: false, filesScanned: 0, error: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const lowerQuery = query.toLowerCase();
    const findIn = (text) => {
      if (regex) {
        regex.lastIndex = 0;
        const match = regex.exec(text);
        return match ? { index: match.index, length: match[0].length } : null;
      }
      const index = text.toLowerCase().indexOf(lowerQuery);
      return index < 0 ? null : { index, length: query.length };
    };

    const matches = [];
    const matchesByFile = new Map();
    let perFileCapped = 0;
    let visited = 0;
    let bytesRead = 0;
    let capped = false;
    const pushLineMatches = (childPath, content) => {
      const lines = content.split(/\r?\n/);
      let added = 0;
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const hit = findIn(lines[index]);
        if (!hit) continue;
        if (added >= perFile) { perFileCapped += 1; break; }
        const start = Math.max(0, hit.index - 60);
        matches.push({
          path: childPath,
          line: index + 1,
          column: hit.index + 1,
          preview: lines[index].slice(start, hit.index + hit.length + 140).trim().slice(0, 240)
        });
        added += 1;
      }
      if (added > 0) matchesByFile.set(childPath, added);
      return matches.length >= limit;
    };

    if (workspace.mode !== 'folder') {
      for (const [childPath, absolute] of workspace.fileMap) {
        if (!matchesInclude(childPath, include)) continue;
        if (namesOnly) {
          visited += 1;
          if (findIn(childPath)) matches.push({ path: childPath, line: 0, column: 0, preview: '' });
          if (matches.length >= limit) break;
          continue;
        }
        let content;
        try {
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_TEXT_BYTES) continue;
          bytesRead += stat.size;
          visited += 1;
          content = await fs.readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue;
        if (pushLineMatches(childPath, content)) { capped = true; break; }
      }
      return { matches, truncated: capped, filesScanned: visited, error: null };
    }

    // Breadth-first: every top-level directory is opened before any of its
    // children, so a match-heavy folder early in the listing cannot starve the
    // rest of the repo out of the global cap.
    const pending = [''];
    let cursor = 0;
    let dirsSkipped = [];

    while (cursor < pending.length && matches.length < limit) {
      const relative = pending[cursor++];
      let entries;
      try {
        entries = await fs.readdir(relative ? path.join(workspace.root, relative) : workspace.root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (visited >= MAX_SEARCH_ENTRIES) { capped = true; break; }
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.') && !(entry.isFile() && entry.name.startsWith('.env'))) continue;
        const childPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(childPath);
          continue;
        }
        if (!entry.isFile() || isIgnoredFile(entry.name) || isPreviewAsset(childPath)) continue;
        if (!matchesInclude(childPath, include)) continue;
        if (namesOnly) {
          visited += 1;
          if (findIn(childPath)) matches.push({ path: childPath, line: 0, column: 0, preview: '' });
          if (matches.length >= limit) { capped = true; break; }
          continue;
        }
        let content;
        try {
          const absolute = path.join(workspace.root, childPath);
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_TEXT_BYTES) continue;
          if (bytesRead + stat.size > MAX_SEARCH_BYTES) { capped = true; break; }
          bytesRead += stat.size;
          visited += 1;
          content = await fs.readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue;
        if (pushLineMatches(childPath, content)) { capped = true; break; }
      }
    }
    // Whatever is still queued was never opened. Reporting it is what lets the
    // caller say "partial answer" instead of passing a truncated result off as
    // exhaustive.
    if (matches.length >= limit && cursor < pending.length) dirsSkipped = pending.slice(cursor);
    return {
      matches: matches.slice(0, limit),
      truncated: capped || perFileCapped > 0,
      filesScanned: visited,
      matchesByFile: Object.fromEntries(matchesByFile),
      dirsSkipped,
      error: null
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
        // Reading a rule is prompt input; letting a reply write one back would
        // hand the model a place to leave instructions for its next turn.
        if (isProjectDocFile(relativePath)) {
          throw new Error('Rule and skill documents are read-only in ShadRox.');
        }
        await adoptWorkspaceFile(workspace, relativePath);
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
          if (!workspace.fileMap.has(relativePath) && !isShadroxConfigFile(relativePath)) {
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
      await adoptWorkspaceFile(workspace, clean);
      let target;
      if (workspace.fileMap.has(clean)) {
        target = (await resolveWorkspaceFile(workspace, clean)).realPath;
      } else {
        if (workspace.mode !== 'folder') throw new Error(`Cannot create ${clean} in a file-only workspace.`);
        const parts = clean.split('/');
        const parent = await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/'));
        target = path.join(parent, parts.at(-1));
        const existing = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (existing?.isSymbolicLink() || (existing && !workspace.fileMap.has(clean))) throw new Error(`${clean} already exists but is not an editable text file in this workspace.`);
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
    if (result.errors.length) {
      // A partial write leaves the folder in a state no single reply described,
      // so every file that landed is put back to its staged "before" content.
      const rollbackErrors = [];
      const saved = new Set(result.saved);
      for (const file of transaction) {
        if (!saved.has(file.name)) continue;
        try {
          if (file.before === null) {
            const parts = file.name.split('/');
            const target = path.join(await resolveWorkspaceDirectory(workspace, parts.slice(0, -1).join('/')), parts.at(-1));
            await fs.rm(target, { force: true });
            workspace.fileMap.delete(file.name);
          } else {
            const restored = await saveFiles(workspaceId, [{ name: file.name, content: file.before }]);
            if (restored.errors.length) throw new Error(restored.errors[0].message);
          }
        } catch (error) {
          rollbackErrors.push({ name: file.name, message: error instanceof Error ? error.message : 'Rollback failed.' });
        }
      }
      result.rolledBack = true;
      result.rollbackErrors = rollbackErrors;
      return result;
    }
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

  /** Rule and skill documents the explorer hides; empty for a single-file workspace. */
  async function projectDocs(workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.mode !== 'folder') return [];
    return listProjectDocs(workspace.root);
  }

  function closeWorkspace(workspaceId) {
    workspaces.delete(workspaceId);
  }

  return { openFolder, openFiles, listDirectory, readFile, loadFiles, projectDocs, renameFile, createDirectory, deletePath, searchFiles, searchContent, saveFiles, stageFiles, commitTransaction, discardTransaction, getWorkspace, closeWorkspace };
}

module.exports = { createWorkspaceAccess, normalizeRelativePath, isWithinRoot };
