import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const stagingDirectory = path.join(projectDirectory, 'dist_staging');
const outputDirectory = path.join(projectDirectory, 'dist_desktop');
const heapLimit = '--max-old-space-size=12288';
const env = { ...process.env, NODE_OPTIONS: heapLimit };
const isWindows = process.platform === 'win32';

// Root of the backend import graph that must exist in the packaged app.
const RUNTIME_ROOTS = ['server.ts'];
// The renderer's lib modules are shared with api/**; the resolver figures out
// which subset the backend actually reaches at runtime.
const RUNTIME_LIB_DIR = 'src/lib';
// Fallback entry kept in package.json's build.files so a manual electron-builder
// run (without this script) still ships a bootable app. The script derives the
// precise list at packaging time and overwrites it in the staged manifest.
// (see LIB_FALLBACK in package.json)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectDirectory,
    env,
    stdio: 'inherit',
    shell: options.shell ?? isWindows,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function copyIntoStage(source, destination) {
  fs.cpSync(path.join(projectDirectory, source), path.join(stagingDirectory, destination), {
    recursive: true,
    force: true,
  });
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Collect every module specifier referenced by a static `import`, a bare
// `import '...'`, `export ... from '...'` (including `export * from`) or a
// dynamic `import('...')` whose target is a string literal. We deliberately
// keep this tiny and dependency-free.
function extractSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    // import ... from 'x' / export ... from 'x' / import 'x'
    /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    // dynamic import('x') — only literal strings resolve statically
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.add(match[1]);
  }
  return [...specifiers];
}

// Resolve a relative specifier to a file on disk, mirroring how tsx/vite map
// `.js` specifiers onto `.ts` sources and how extensionless imports expand.
function resolveRelative(importerAbs, specifier) {
  const baseAbs = path.resolve(path.dirname(importerAbs), specifier);
  const candidates = [];
  const isExplicitExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(baseAbs);

  if (isExplicitExt) {
    // Prefer the same-named TS source for `.js`/`.jsx` specifiers (allowImportingTsExtensions).
    const tsFor = { '.js': ['.ts', '.tsx', '.js', '.jsx'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] };
    const ext = path.extname(baseAbs);
    const stem = baseAbs.slice(0, -ext.length);
    for (const alt of (tsFor[ext] || [ext])) candidates.push(stem + alt);
  } else {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
      candidates.push(baseAbs + ext);
    }
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '/index.js']) {
      candidates.push(path.join(baseAbs, ext.replace(/^\//, '')));
      candidates.push(baseAbs + ext);
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Walk the graph from the roots and return the relative (posix) paths of every
// file under src/lib that the backend can reach. Throws when a relative import
// cannot be resolved, so the script fails loudly instead of shipping a partial
// runtime. `root` is overridable for verification; packaging always uses the
// repository root.
function resolveRuntimeLibFiles(root = projectDirectory) {
  const seen = new Set();
  const reached = new Set();
  const stack = RUNTIME_ROOTS.map((r) => path.join(root, r));
  const libRootAbs = path.join(root, RUNTIME_LIB_DIR);

  for (const r of stack) {
    if (!fs.existsSync(r)) {
      throw new Error(`Runtime root is missing from disk: ${toPosix(path.relative(root, r))}`);
    }
  }

  while (stack.length) {
    const fileAbs = stack.pop();
    const key = toPosix(path.relative(root, fileAbs));
    if (seen.has(key)) continue;
    seen.add(key);

    if (fileAbs.startsWith(libRootAbs + path.sep)) reached.add(key);

    let source;
    try {
      source = fs.readFileSync(fileAbs, 'utf8');
    } catch (error) {
      throw new Error(`Could not read ${key} while resolving the runtime graph: ${error.message}`);
    }

    for (const specifier of extractSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue; // bare specifiers are node_modules externals
      const targetAbs = resolveRelative(fileAbs, specifier);
      if (!targetAbs) {
        throw new Error(`Unresolvable import "${specifier}" from ${key}. Refusing to package an incomplete runtime.`);
      }
      stack.push(targetAbs);
    }
  }

  return [...reached].sort();
}

function main() {
  run(isWindows ? 'npm.cmd' : 'npm', ['run', 'build']);

  // Derive the backend runtime's src/lib dependencies instead of hard-coding them,
  // so package.json's build.files and the staged copy set can never drift apart.
  const runtimeLibFiles = resolveRuntimeLibFiles();
  if (runtimeLibFiles.length === 0) {
    throw new Error('Runtime dependency resolver found no src/lib modules; the graph is likely broken.');
  }

  // The packaged main process starts server.ts and imports the API layer; include
  // those runtime files along with Electron's main-process modules.
  if (path.resolve(stagingDirectory) !== path.join(projectDirectory, 'dist_staging')) {
    throw new Error('Refusing to clean an unexpected staging path.');
  }
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  copyIntoStage('dist', 'dist');
  copyIntoStage('electron', 'electron');
  copyIntoStage('api', 'api');
  copyIntoStage('assets', 'assets');
  for (const relative of runtimeLibFiles) {
    copyIntoStage(relative, relative);
  }
  copyIntoStage('server.ts', 'server.ts');
  copyIntoStage('package-lock.json', 'package-lock.json');
  copyIntoStage('.npmrc', '.npmrc');

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
  const electronPackage = JSON.parse(fs.readFileSync(
    path.join(projectDirectory, 'node_modules', 'electron', 'package.json'),
    'utf8',
  ));
  packageJson.build.electronVersion = electronPackage.version;
  packageJson.build.directories.output = outputDirectory;

  // Replace the manual/fallback src/lib entry with the derived list so the staged
  // manifest ships exactly the files the resolver proved the backend reaches.
  // Order is irrelevant to electron-builder, so drop every existing src/lib/*
  // entry (including the fallback glob) and append the precise derived list.
  const withoutLib = packageJson.build.files.filter(
    (entry) => !entry.startsWith(`${RUNTIME_LIB_DIR}/`),
  );
  packageJson.build.files = [...withoutLib, ...runtimeLibFiles];

  fs.writeFileSync(path.join(stagingDirectory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  run(isWindows ? 'npm.cmd' : 'npm', [
    'install',
    '--production',
    '--no-audit',
    '--no-fund',
  ], { cwd: stagingDirectory });

  // npm needs the full lockfile for a reproducible production install. Once that
  // install is complete, keep the packaged manifest focused on runtime modules.
  const stagedPackagePath = path.join(stagingDirectory, 'package.json');
  const stagedPackage = JSON.parse(fs.readFileSync(stagedPackagePath, 'utf8'));
  delete stagedPackage.devDependencies;
  fs.writeFileSync(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
  fs.rmSync(path.join(stagingDirectory, 'package-lock.json'), { force: true });

  run(process.execPath, [
    path.join(projectDirectory, 'node_modules', 'electron-builder', 'cli.js'),
    '--projectDir',
    stagingDirectory,
    ...process.argv.slice(2),
  ], { shell: false });
}

// Export the resolver so verification can exercise the real logic without
// triggering the build; run the pipeline only when this file is executed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { resolveRuntimeLibFiles, copyIntoStage, stagingDirectory, projectDirectory };
