'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

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
  'dist_staging',
  '.cache',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.netlify'
]);

const WHITELIST_PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^bun\.lockb?$/i,
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
  /^vitest\.config\..*$/i,
  /^next\.config\..*$/i,
  /^drizzle\.config\..*$/i,
  /^vercel\.json$/i,
  /^netlify\.toml$/i,
  /^Dockerfile$/i,
  /^shadrox\.debug\.json$/i
];

const HIGH_CONFIDENCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte'
]);

const QUOTED_PATH_REGEX = /['"`]([^'"`\r\n]{1,260})['"`]/g;
const ASSET_OR_MODULE_PATH_RE =
  /^(?:\.\.?\/|\/|[a-zA-Z0-9_-]+\/).+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|css|scss|sass|less|vue|svelte|json|html|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|ogg|wasm|pdf|txt|md|sql)(?:[?#][^'"`\s]*)?$/i;

function normalizePosix(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifyUnusedConfidence(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return HIGH_CONFIDENCE_EXTENSIONS.has(ext) ? 'high' : 'review';
}

function isWhitelisted(relPath) {
  const normalized = normalizePosix(relPath);
  if (normalized.startsWith('public/')) return true;
  const basename = path.basename(normalized);
  return WHITELIST_PATTERNS.some((re) => re.test(basename));
}

function isDefaultEntry(relPath) {
  const norm = normalizePosix(relPath);
  if (/^index\.html$/i.test(norm)) return true;
  if (/^server\.[cm]?[jt]s$/i.test(norm)) return true;
  if (/^src\/main\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/index\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/App\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/^src\/pages\//i.test(norm)) return true;
  if (/^src\/app\//i.test(norm)) return true;
  if (/^api\//i.test(norm)) return true;
  if (/^electron\//i.test(norm)) return true;
  if (/^supabase\/functions\//i.test(norm)) return true;
  if (/^netlify\/functions\//i.test(norm)) return true;
  if (/^functions\//i.test(norm)) return true;
  if (/^workers\//i.test(norm)) return true;
  if (/\.worker\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/(?:^|\/)service-worker\.[cm]?[jt]s$/i.test(norm)) return true;
  if (/^scripts\//i.test(norm)) return true;
  if (/^prisma\//i.test(norm)) return true;
  if (/^drizzle\//i.test(norm)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm)) return true;
  return false;
}

async function extractPackageJsonEntries(root) {
  const entries = new Set();
  try {
    const pkgPath = path.join(root, 'package.json');
    const content = await fsp.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    if (typeof pkg.main === 'string') entries.add(normalizePosix(pkg.main));
    if (typeof pkg.module === 'string') entries.add(normalizePosix(pkg.module));
    if (typeof pkg.bin === 'string') entries.add(normalizePosix(pkg.bin));
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const val of Object.values(pkg.bin)) {
        if (typeof val === 'string') entries.add(normalizePosix(val));
      }
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const cmd of Object.values(pkg.scripts)) {
        if (typeof cmd === 'string') {
          const matches = cmd.match(/(?:[\w./\\-]+?\.[cm]?[jt]sx?)/g);
          if (matches) {
            for (const m of matches) entries.add(normalizePosix(m));
          }
        }
      }
    }
  } catch {
    // ignore missing or malformed package.json
  }
  return entries;
}

function extractReferences(filePath, content, ext) {
  const refs = new Set();
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(ext)) {
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
    // dynamic string asset/module references in code (e.g. '/assets/hero.png', './workers/sync.ts')
    QUOTED_PATH_REGEX.lastIndex = 0;
    while ((match = QUOTED_PATH_REGEX.exec(content)) !== null) {
      const candidate = match[1]?.trim();
      if (candidate && !candidate.includes('://') && ASSET_OR_MODULE_PATH_RE.test(candidate)) {
        refs.add(candidate);
      }
    }
  } else if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
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
    const srcRegex = /(?:src|href|poster)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = srcRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('http://') && !match[1].startsWith('https://') && !match[1].startsWith('#')) {
        refs.add(match[1]);
      }
    }
  } else if (ext === '.json') {
    let match;
    QUOTED_PATH_REGEX.lastIndex = 0;
    while ((match = QUOTED_PATH_REGEX.exec(content)) !== null) {
      const candidate = match[1]?.trim();
      if (candidate && !candidate.includes('://') && ASSET_OR_MODULE_PATH_RE.test(candidate)) {
        refs.add(candidate);
      }
    }
  }
  return refs;
}

async function resolveTsconfigPaths(root) {
  try {
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return {};
    const content = await fsp.readFile(tsconfigPath, 'utf8');
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
    // ignore invalid tsconfig
  }
  return {};
}

function stripRefSuffix(ref) {
  return String(ref || '').split(/[?#]/)[0];
}

function resolveModulePath(root, currentFile, rawRef, fileSet, tsconfigPaths) {
  const ref = stripRefSuffix(rawRef);
  if (!ref) return null;

  const candidatePaths = [];

  for (const [alias, targetDir] of Object.entries(tsconfigPaths)) {
    if (ref === alias || ref.startsWith(alias + '/')) {
      const rel = ref.slice(alias.length).replace(/^\//, '');
      candidatePaths.push(path.join(targetDir, rel));
      break;
    }
  }

  if (candidatePaths.length === 0) {
    if (ref.startsWith('.')) {
      const currentDir = path.dirname(path.join(root, currentFile));
      candidatePaths.push(path.resolve(currentDir, ref));
    } else if (ref.startsWith('/')) {
      const cleanRootRef = ref.replace(/^\/+/, '');
      candidatePaths.push(path.join(root, cleanRootRef));
      candidatePaths.push(path.join(root, 'src', cleanRootRef));
      candidatePaths.push(path.join(root, 'public', cleanRootRef));
    } else {
      candidatePaths.push(path.join(root, ref));
      candidatePaths.push(path.join(root, 'src', ref));
    }
  }

  const extensions = [
    '',
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.css',
    '.scss',
    '.json',
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/index.jsx'
  ];

  // TypeScript allowImportingTsExtensions maps foo.js -> foo.ts / foo.tsx
  const tsAlternateExtensions = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs']
  };

  for (const base of candidatePaths) {
    const baseExt = path.extname(base).toLowerCase();
    if (tsAlternateExtensions[baseExt]) {
      const stem = base.slice(0, -baseExt.length);
      for (const altExt of tsAlternateExtensions[baseExt]) {
        const rel = path.relative(root, stem + altExt).replace(/\\/g, '/');
        if (fileSet.has(rel)) return rel;
      }
    }

    for (const ext of extensions) {
      const full = base + ext;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (fileSet.has(rel)) return rel;
    }
  }

  return null;
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function scanJunk(root, onProgress) {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const emitProgress = (payload) => {
    if (typeof onProgress === 'function') {
      onProgress(payload);
    }
  };

  emitProgress({ step: 'discovering', current: 0, total: 0, message: 'Discovering project files...' });

  const allFiles = []; // { relPath, fullPath, size, mtime }
  const fileSet = new Set();
  const queueDirs = [root];
  let discoveredCount = 0;

  // Iterative async BFS directory walk with regular yields keeps UI/main responsive on 10,000+ files.
  while (queueDirs.length > 0 && !cancelled) {
    const dir = queueDirs.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (cancelled) break;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        queueDirs.push(fullPath);
      } else if (entry.isFile()) {
        if (isWhitelisted(relPath)) continue;
        try {
          const stats = await fsp.stat(fullPath);
          allFiles.push({ relPath, fullPath, size: stats.size, mtime: stats.mtimeMs });
          fileSet.add(relPath);
          discoveredCount += 1;
          if (discoveredCount % 100 === 0) {
            emitProgress({
              step: 'discovering',
              current: discoveredCount,
              total: 0,
              message: `Indexed ${discoveredCount} workspace files...`
            });
            await yieldEventLoop();
          }
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  if (cancelled) {
    return {
      unusedFiles: [],
      deadFolders: [],
      stats: { total: 0, unused: 0, reclaimableBytes: 0, highConfidenceCount: 0, reviewCount: 0 },
      cancel
    };
  }

  emitProgress({
    step: 'resolving',
    current: allFiles.length,
    total: allFiles.length,
    message: 'Resolving dependency graph...'
  });

  const tsconfigPaths = await resolveTsconfigPaths(root);
  const pkgEntries = await extractPackageJsonEntries(root);

  const entryPoints = new Set();
  for (const f of allFiles) {
    if (isDefaultEntry(f.relPath) || pkgEntries.has(f.relPath)) {
      entryPoints.add(f.relPath);
    }
  }
  if (entryPoints.size === 0 && allFiles.length > 0) {
    entryPoints.add(allFiles[0].relPath);
  }

  const visited = new Set();
  const queue = [...entryPoints];
  let queueHead = 0;
  for (const ep of queue) visited.add(ep);

  let processedCount = 0;
  const totalFiles = allFiles.length;
  const fileMap = new Map();
  for (const f of allFiles) fileMap.set(f.relPath, f);

  while (queueHead < queue.length && !cancelled) {
    const current = queue[queueHead++];
    const fileObj = fileMap.get(current);
    if (!fileObj) continue;

    processedCount++;
    if (processedCount % 40 === 0) {
      emitProgress({ step: 'analyzing', current: processedCount, total: totalFiles, message: `Analyzing ${current}...` });
      await yieldEventLoop();
    }

    try {
      const ext = path.extname(current).toLowerCase();
      const content = await fsp.readFile(fileObj.fullPath, 'utf8');
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

  if (cancelled) {
    return {
      unusedFiles: [],
      deadFolders: [],
      stats: { total: 0, unused: 0, reclaimableBytes: 0, highConfidenceCount: 0, reviewCount: 0 },
      cancel
    };
  }

  const unusedFiles = allFiles
    .filter((f) => !visited.has(f.relPath))
    .map((f) => ({
      path: f.relPath,
      size: f.size,
      mtime: f.mtime,
      confidence: classifyUnusedConfidence(f.relPath)
    }));

  const reclaimableBytes = unusedFiles.reduce((acc, f) => acc + f.size, 0);
  const highConfidenceCount = unusedFiles.filter((f) => f.confidence === 'high').length;
  const reviewCount = unusedFiles.length - highConfidenceCount;

  const unusedSet = new Set(unusedFiles.map((f) => f.path));
  const dirMap = new Map();

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

  deadDirs.sort((a, b) => b.split('/').length - a.split('/').length);
  const filteredDeadDirs = [];
  const coveredDirs = new Set();
  for (const d of deadDirs) {
    if (![...coveredDirs].some((cd) => d === cd || d.startsWith(cd + '/'))) {
      filteredDeadDirs.push(d);
      coveredDirs.add(d);
    }
  }

  return {
    unusedFiles,
    deadFolders: filteredDeadDirs,
    stats: {
      total: allFiles.length,
      unused: unusedFiles.length,
      reclaimableBytes,
      highConfidenceCount,
      reviewCount
    },
    cancel
  };
}

module.exports = {
  scanJunk,
  isDefaultEntry,
  isWhitelisted,
  classifyUnusedConfidence,
  extractReferences,
  resolveModulePath
};
