'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPathInsideDirectory } = require('./desktop-security.cjs');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.shadrox',
  'shadrox-backups',
  'dist_desktop',
  '.cache'
]);

const WHITELIST_PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^tsconfig.*\.json$/i,
  /^\.env.*$/i,
  /^README.*$/i,
  /^LICENSE.*$/i,
  /^\.gitignore$/i,
  /^\.eslintrc.*$/i,
  /^eslint\.config\..*$/i,
  /^prettier.*$/i,
  /^tailwind\.config\..*$/i,
  /^postcss\.config\..*$/i,
  /^vite\.config\..*$/i,
  /^next\.config\..*$/i,
  /^vercel\.json$/i,
  /^netlify\.toml$/i,
  /^Dockerfile$/i,
  /^shadrox\.debug\.json$/i
];

function isWhitelisted(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('public/')) return true;
  const basename = path.basename(normalized);
  return WHITELIST_PATTERNS.some((re) => re.test(basename));
}

function isDefaultEntry(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (/^index\.html$/i.test(norm)) return true;
  if (/^server\.[cm]?[jt]s$/i.test(norm)) return true;
  if (/^src\/main\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/index\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/App\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/pages\//i.test(norm)) return true;
  if (/^src\/app\//i.test(norm)) return true;
  if (/^api\//i.test(norm)) return true;
  if (/^electron\//i.test(norm)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm)) return true;
  return false;
}

function extractPackageJsonEntries(root) {
  const entries = new Set();
  try {
    const pkgPath = path.join(root, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    if (typeof pkg.main === 'string') entries.add(pkg.main.replace(/^\.\//, ''));
    if (typeof pkg.module === 'string') entries.add(pkg.module.replace(/^\.\//, ''));
    if (typeof pkg.bin === 'string') entries.add(pkg.bin.replace(/^\.\//, ''));
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const val of Object.values(pkg.bin)) {
        if (typeof val === 'string') entries.add(val.replace(/^\.\//, ''));
      }
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const cmd of Object.values(pkg.scripts)) {
        if (typeof cmd === 'string') {
          // extract any file paths mentioned in scripts (e.g. tsx server.ts)
          const matches = cmd.match(/(?:[\w./\\-]+?\.[jt]sx?)/g);
          if (matches) {
            for (const m of matches) entries.add(m.replace(/^\.\//, ''));
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return entries;
}

function extractReferences(filePath, content, ext) {
  const refs = new Set();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // import/export ... from '...' or "..."
    const importExportRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importExportRegex.exec(content)) !== null) {
      if (match[1]) refs.add(match[1]);
    }
    // dynamic import(...) or require(...)
    const callRegex = /(?:import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    while ((match = callRegex.exec(content)) !== null) {
      const target = match[1] || match[2];
      if (target) refs.add(target);
    }
    // side-effect import '...'
    const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
    while ((match = sideEffectRegex.exec(content)) !== null) {
      if (match[1]) refs.add(match[1]);
    }
  } else if (ext === '.css') {
    const cssImport = /@import\s+(?:url\(\s*)?['"]?([^'")\s]+)['"]?\s*\)?/g;
    let match;
    while ((match = cssImport.exec(content)) !== null) {
      if (match[1]) refs.add(match[1]);
    }
    const urlRegex = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
    while ((match = urlRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('data:')) refs.add(match[1]);
    }
  } else if (ext === '.html') {
    const srcRegex = /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = srcRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('http://') && !match[1].startsWith('https://') && !match[1].startsWith('#')) {
        refs.add(match[1]);
      }
    }
  }
  return refs;
}

function resolveTsconfigPaths(root) {
  try {
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return {};
    const content = fs.readFileSync(tsconfigPath, 'utf8');
    // Simple json strip comments
    const cleaned = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const tsconfig = JSON.parse(cleaned);
    const paths = tsconfig?.compilerOptions?.paths;
    const baseUrl = tsconfig?.compilerOptions?.baseUrl || '.';
    if (paths && typeof paths === 'object') {
      const resolved = {};
      for (const [alias, targets] of Object.entries(paths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          const cleanAlias = alias.replace(/\/\*$/, '');
          const cleanTarget = targets[0].replace(/\/\*$/, '');
          resolved[cleanAlias] = path.resolve(root, baseUrl, cleanTarget);
        }
      }
      return resolved;
    }
  } catch {
    // ignore
  }
  return {};
}

function resolveModulePath(root, currentFile, ref, fileSet, tsconfigPaths) {
  let candidatePaths = [];

  // Handle @/* aliases
  let targetRef = ref;
  for (const [alias, targetDir] of Object.entries(tsconfigPaths)) {
    if (targetRef === alias || targetRef.startsWith(alias + '/')) {
      const rel = targetRef.slice(alias.length).replace(/^\//, '');
      candidatePaths.push(path.join(targetDir, rel));
      break;
    }
  }

  if (candidatePaths.length === 0) {
    if (ref.startsWith('.')) {
      const currentDir = path.dirname(path.join(root, currentFile));
      candidatePaths.push(path.resolve(currentDir, ref));
    } else if (!ref.startsWith('/')) {
      // Node module or absolute in root
      candidatePaths.push(path.join(root, ref));
    }
  }

  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

  for (const base of candidatePaths) {
    for (const ext of extensions) {
      const full = base + ext;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (fileSet.has(rel)) {
        return rel;
      }
    }
  }

  return null;
}

async function scanJunk(root, onProgress) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  if (typeof onProgress === 'function') {
    onProgress({ step: 'discovering', current: 0, total: 0, message: 'Discovering project files...' });
  }

  const allFiles = []; // { relPath, fullPath, size, mtime }
  const fileSet = new Set();

  function walk(dir) {
    if (cancelled) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (cancelled) return;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (isWhitelisted(relPath)) continue;
        try {
          const stats = fs.statSync(fullPath);
          allFiles.push({ relPath, fullPath, size: stats.size, mtime: stats.mtimeMs });
          fileSet.add(relPath);
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  walk(root);
  if (cancelled) return { unusedFiles: [], deadFolders: [], stats: { total: 0, unused: 0, reclaimableBytes: 0 } };

  if (typeof onProgress === 'function') {
    onProgress({ step: 'resolving', current: allFiles.length, total: allFiles.length, message: 'Resolving dependency graph...' });
  }

  const tsconfigPaths = resolveTsconfigPaths(root);
  const pkgEntries = extractPackageJsonEntries(root);

  const entryPoints = new Set();
  for (const f of allFiles) {
    if (isDefaultEntry(f.relPath) || pkgEntries.has(f.relPath)) {
      entryPoints.add(f.relPath);
    }
  }
  // Ensure at least one entry point if none found
  if (entryPoints.size === 0 && allFiles.length > 0) {
    entryPoints.add(allFiles[0].relPath);
  }

  // Graph traversal
  const visited = new Set();
  const queue = [...entryPoints];
  for (const ep of queue) visited.add(ep);

  let processedCount = 0;
  const totalFiles = allFiles.length;

  const fileMap = new Map();
  for (const f of allFiles) fileMap.set(f.relPath, f);

  while (queue.length > 0 && !cancelled) {
    const current = queue.shift();
    const fileObj = fileMap.get(current);
    if (!fileObj) continue;

    processedCount++;
    if (typeof onProgress === 'function' && processedCount % 20 === 0) {
      onProgress({ step: 'analyzing', current: processedCount, total: totalFiles, message: `Analyzing ${current}...` });
    }

    try {
      const ext = path.extname(current).toLowerCase();
      const content = fs.readFileSync(fileObj.fullPath, 'utf8');
      const refs = extractReferences(current, content, ext);

      for (const ref of refs) {
        const resolved = resolveModulePath(root, current, ref, fileSet, tsconfigPaths);
        if (resolved && !visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
        }
      }
    } catch {
      // ignore read/parse errors
    }
  }

  if (cancelled) return { unusedFiles: [], deadFolders: [], stats: { total: 0, unused: 0, reclaimableBytes: 0 } };

  const unusedFiles = allFiles.filter((f) => !visited.has(f.relPath));
  let reclaimableBytes = unusedFiles.reduce((acc, f) => acc + f.size, 0);

  // Dead folder detection
  const unusedSet = new Set(unusedFiles.map((f) => f.relPath));
  const dirMap = new Map(); // dir -> { totalFiles: Set, unusedFiles: Set }

  for (const f of allFiles) {
    const dir = path.dirname(f.relPath);
    if (dir === '.' || dir === '') continue;
    let curr = dir;
    while (curr && curr !== '.' && curr !== '') {
      if (!dirMap.has(curr)) dirMap.set(curr, { total: 0, unused: 0 });
      const stats = dirMap.get(curr);
      stats.total++;
      if (unusedSet.has(f.relPath)) stats.unused++;
      curr = path.dirname(curr);
    }
  }

  const deadDirs = [];
  for (const [dir, stats] of dirMap.entries()) {
    if (stats.total > 0 && stats.unused === stats.total) {
      deadDirs.push(dir);
    }
  }

  // Sort dead dirs by depth (deepest first) to avoid redundant parent/child reporting
  deadDirs.sort((a, b) => b.split('/').length - a.split('/').length);
  const filteredDeadDirs = [];
  const coveredDirs = new Set();
  for (const d of deadDirs) {
    if (![...coveredDirs].some((cd) => d === cd || d.startsWith(cd + '/'))) {
      filteredDeadDirs.add ? filteredDeadDirs.push(d) : filteredDeadDirs.push(d);
      coveredDirs.add(d);
    }
  }

  return {
    unusedFiles: unusedFiles.map((f) => ({
      path: f.relPath,
      size: f.size,
      mtime: f.mtime
    })),
    deadFolders: filteredDeadDirs,
    stats: {
      total: allFiles.length,
      unused: unusedFiles.length,
      reclaimableBytes
    },
    cancel
  };
}

module.exports = { scanJunk };
