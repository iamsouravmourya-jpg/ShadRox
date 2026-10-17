import { findAsset, type AssetMap } from './assets';
import { apiMockBridge, detectRoutes, type DetectedRoute } from './backend';
import type { SecretItem, WorkspaceFile } from './types';

/**
 * In-browser bundling with esbuild-wasm.
 *
 * The workspace files are fed to esbuild through a virtual file system, so a
 * real React + TypeScript SaaS project can be bundled and run inside the preview
 * iframe without a server build step. Anything the compiler cannot resolve
 * inside the workspace (react, react-dom, lucide-react...) stays external and is satisfied
 * by an import map pointing at a CDN.
 */
type Esbuild = typeof import('esbuild-wasm');

type Loader = 'tsx' | 'ts' | 'jsx' | 'js' | 'json' | 'css' | 'text';

const LOADERS: Record<string, Loader> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  css: 'css'
};

/** Entry file names tried in order before falling back to a react-dom scan. */
const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/main.ts',
  'src/main.js',
  'src/index.tsx',
  'src/index.jsx',
  'src/index.ts',
  'src/index.js',
  'src/App.tsx',
  'src/App.jsx',
  'main.tsx',
  'main.jsx',
  'index.tsx',
  'index.jsx',
  'App.tsx',
  'App.jsx',
  'main.ts',
  'index.ts',
  'main.js',
  'index.js'
];

const RESOLVE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'];

/** Text-ish files that `?raw` can inline directly and `?url` can serve as data URLs. */
const TEXT_ASSET_MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  txt: 'text/plain',
  glsl: 'text/plain',
  vert: 'text/plain',
  frag: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml'
};

/** Bare imports are resolved from CDN */
const CDN = 'https://esm.sh';

/** Fallback pins, used only when the workspace has no package.json entry for the package. */
const DEFAULT_IMPORT_MAP: Record<string, string> = {
  react: `${CDN}/react@19`,
  'react/': `${CDN}/react@19/`,
  'react-dom': `${CDN}/react-dom@19`,
  'react-dom/': `${CDN}/react-dom@19/`,
  'lucide-react': `${CDN}/lucide-react@0.546.0`,
  clsx: `${CDN}/clsx@2.1.1`,
  'tailwind-merge': `${CDN}/tailwind-merge@2.5.4`
};

export interface BundleResult {
  code: string;
  css: string;
  entry: string;
  /** Bare specifier -> CDN URL map for the iframe, derived from package.json. */
  importMap: Record<string, string>;
  /** Real HTTP routes read out of the workspace's server code. */
  routes: DetectedRoute[];
}

let esbuildPromise: Promise<Esbuild> | null = null;

async function loadEsbuild(): Promise<Esbuild> {
  if (!esbuildPromise) {
    esbuildPromise = (async () => {
      const [esbuild, wasm] = await Promise.all([
        import('esbuild-wasm'),
        import('esbuild-wasm/esbuild.wasm?url')
      ]);
      await esbuild.initialize({ wasmURL: wasm.default });
      return esbuild;
    })().catch((error) => {
      esbuildPromise = null;
      throw error;
    });
  }
  return esbuildPromise;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function normalize(path: string): string {
  const parts: string[] = [];
  path.split('/').forEach((segment) => {
    if (!segment || segment === '.') return;
    if (segment === '..') {
      parts.pop();
      return;
    }
    parts.push(segment);
  });
  return parts.join('/');
}

function loaderFor(path: string): Loader {
  const extension = (path.split('.').pop() || '').toLowerCase();
  return LOADERS[extension] ?? 'text';
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Finds the project root directory inside a mounted workspace (e.g. for monorepos
 * or when the user opens the parent folder of a project).
 */
export function findProjectRoot(files: WorkspaceFile[]): string {
  // If we can identify the entry point by React mounter, use its root directly.
  const mounter = files.find((file) => /from\s+['"]react-dom\/client['"]|from\s+['"]react-dom['"]/.test(file.content));
  if (mounter) {
    const mounterDir = dirname(normalize(mounter.name));
    const parts = mounterDir.split('/');
    const srcIndex = parts.lastIndexOf('src');
    const root = srcIndex >= 0 ? parts.slice(0, srcIndex).join('/') : mounterDir;
    
    // Verify a package.json actually exists at this inferred root
    const target = root ? `${root}/package.json` : 'package.json';
    if (files.some((f) => normalize(f.name).toLowerCase() === target.toLowerCase())) {
      return root;
    }
  }

  // Fallback: shortest package.json path wins
  const pkgs = files.filter((f) => normalize(f.name).toLowerCase().endsWith('package.json'));
  if (pkgs.length === 0) return '';
  pkgs.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  return dirname(normalize(pkgs[0].name));
}

/** Parses a mounted package.json, or null when it is missing or unreadable. */
function readManifest(files: WorkspaceFile[], root: string = ''): PackageManifest | null {
  const target = root ? `${root}/package.json` : 'package.json';
  const pkg = files.find((file) => normalize(file.name).toLowerCase() === target.toLowerCase());
  if (!pkg) return null;
  try {
    return JSON.parse(pkg.content) as PackageManifest;
  } catch {
    return null;
  }
}

/** Condenses an npm range (^19.0.1, ~4.25.12, >=18 <20, workspace:*) into an esm.sh version. */
function toEsmVersion(range: string): string {
  const raw = range.trim();
  if (!raw || raw === '*' || raw === 'latest') return '';
  if (/^[a-z]+:/i.test(raw)) return ''; // workspace:, file:, link:, git:, http:, npm:
  const candidate = raw.split('||')[0].trim().replace(/^[\^~><=\s]+/, '').trim().split(/\s+/)[0];
  return /^\d/.test(candidate) ? candidate : '';
}

/** esm.sh URL for a package, optionally externalizing sibling packages for dedupe. */
function cdnUrl(name: string, version: string, externals: string[] = []): string {
  const base = version ? `${CDN}/${name}@${version}` : `${CDN}/${name}`;
  return externals.length > 0 ? `${base}?external=${externals.join(',')}` : base;
}

/**
 * Builds the iframe import map from the workspace's own package.json, so any
 * npm dependency the project imports can be served by esm.sh at runtime
 * instead of failing with "Failed to resolve module specifier".
 *
 * Each bare entry externalizes the workspace's other dependencies, which makes
 * esm.sh emit bare imports that come back through this map. That keeps a single
 * instance of shared libraries (React, @codemirror/state...) instead of a
 * duplicate copy per package, which is what breaks hooks/observers at runtime.
 */
export function buildImportMap(files: WorkspaceFile[], root: string = ''): Record<string, string> {
  const imports: Record<string, string> = {};
  const manifest = readManifest(files, root) ?? {};
  const deps = { ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.dependencies };
  const names = Object.keys(deps).filter((name) => !name.startsWith('@types/'));
  // devDependencies are build tooling, so only runtime deps are dedupe candidates.
  const shared = new Set(
    [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})].filter(
      (name) => !name.startsWith('@types/')
    )
  );

  names.forEach((name) => {
    const version = toEsmVersion(deps[name]);
    const externals = [...shared].filter((other) => other !== name);
    const bare = cdnUrl(name, version, externals);
    // Very large manifests would blow past sane URL lengths; fall back to plain URLs.
    if (!imports[name]) imports[name] = bare.length <= 1500 ? bare : cdnUrl(name, version);
    // Subpath imports (react-dom/client) need a trailing-slash entry, which cannot
    // carry a query string without breaking prefix matching.
    if (!imports[`${name}/`]) imports[`${name}/`] = `${cdnUrl(name, version)}/`;
  });

  Object.entries(DEFAULT_IMPORT_MAP).forEach(([specifier, url]) => {
    if (!imports[specifier]) imports[specifier] = url;
  });
  if (!imports['esbuild-wasm']) imports['esbuild-wasm'] = `${CDN}/esbuild-wasm@0.28.2`;
  if (!imports['esbuild-wasm/']) imports['esbuild-wasm/'] = `${CDN}/esbuild-wasm@0.28.2/`;

  return imports;
}

/** Resolves a bare specifier against an import map: exact key first, then longest `pkg/` prefix. */
export function resolveImportMapUrl(specifier: string, importMap: Record<string, string>): string | null {
  if (importMap[specifier]) return importMap[specifier];
  const prefix = Object.keys(importMap)
    .filter((key) => key.endsWith('/') && specifier.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? `${importMap[prefix]}${specifier.slice(prefix.length)}` : null;
}

function base64Encode(value: string): string {
  let binary = '';
  new TextEncoder().encode(value).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

/** Data URL for a text asset kept in the workspace sources (svg, glsl, csv...). */
function textDataUrl(path: string, content: string): string {
  const extension = (path.split('.').pop() || '').toLowerCase();
  return `data:${TEXT_ASSET_MIME[extension] ?? 'text/plain'};base64,${base64Encode(content)}`;
}

/** One `compilerOptions.paths` entry, rewritten into workspace-root-relative targets. */
export interface PathAlias {
  prefix: string;
  suffix: string;
  targets: string[];
}

/** Tolerant JSON reader: tsconfig files may contain comments and trailing commas. */
function parseJsonc(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
        .replace(/,\s*([}\]])/g, '$1')
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Reads `@/*` style aliases from a mounted tsconfig/jsconfig, so imports that
 * only resolve through TypeScript path mapping also resolve in the sandbox.
 */
export function readPathAliases(files: WorkspaceFile[], root: string = ''): PathAlias[] {
  const config = files.find((file) => {
    const name = normalize(file.name).toLowerCase();
    return (
      name === (root ? `${root}/tsconfig.json`.toLowerCase() : 'tsconfig.json') ||
      name === (root ? `${root}/jsconfig.json`.toLowerCase() : 'jsconfig.json') ||
      name === (root ? `${root}/tsconfig.app.json`.toLowerCase() : 'tsconfig.app.json')
    );
  });
  if (!config) return [];

  const parsed = parseJsonc(config.content);
  const options = parsed?.compilerOptions as { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
  const paths = options?.paths;
  if (!paths || typeof paths !== 'object') return [];

  let base = normalize(String(options?.baseUrl ?? '.'));
  if (root) base = base === '.' || !base ? root : `${root}/${base}`;

  return Object.entries(paths).flatMap(([pattern, targets]) => {
    if (!Array.isArray(targets) || targets.length === 0) return [];
    const star = pattern.indexOf('*');
    return [
      {
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? '' : pattern.slice(star + 1),
        targets: targets
          .filter((target): target is string => typeof target === 'string')
          .map((target) => normalize(base ? `${base}/${target}` : target))
      }
    ];
  });
}

/** Returns the workspace path an aliased import points at, or null. */
export function resolveAliasPath(specifier: string, aliases: PathAlias[]): string | null {
  for (const alias of aliases) {
    if (specifier.length < alias.prefix.length + alias.suffix.length) continue;
    if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
    const captured = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    for (const target of alias.targets) {
      if (target.includes('*')) return target.replace('*', captured);
      if (!captured) return target;
    }
  }
  return null;
}

/** Picks the file that boots the app, or null when nothing looks runnable. */
export function findEntryFile(files: WorkspaceFile[], root: string = ''): string | null {
  const byName = new Map(files.map((file) => [normalize(file.name).toLowerCase(), file.name]));
  for (const candidate of ENTRY_CANDIDATES) {
    const target = root ? `${root}/${candidate}` : candidate;
    const hit = byName.get(target.toLowerCase());
    if (hit) return hit;
  }

  // Anything that mounts React or renders JSX
  const mounter = files.find((file) => /from\s+['"]react-dom\/client['"]|from\s+['"]react-dom['"]/.test(file.content));
  if (mounter) return mounter.name;

  return null;
}

/** True when this workspace can be bundled and run, not just viewed. */
export function canBundle(files: WorkspaceFile[]): boolean {
  const root = findProjectRoot(files);
  return findEntryFile(files, root) !== null;
}

export async function bundleProject(
  files: WorkspaceFile[],
  secrets: SecretItem[] = [],
  assets: AssetMap = {}
): Promise<BundleResult> {
  const root = findProjectRoot(files);
  const entry = findEntryFile(files, root);
  if (!entry) throw new Error('No entry file found (e.g. src/main.tsx, src/index.tsx, or index.html required).');

  const esbuild = await loadEsbuild();
  const sources = new Map(files.map((file) => [normalize(file.name), file.content]));
  const aliases = readPathAliases(files, root);
  const importMap = buildImportMap(files, root);

  // Generated virtual modules (asset data URLs, CDN URLs) are handed to esbuild
  // through this side table so no large payload travels through plugin metadata.
  const inlineModules = new Map<string, string>();
  let inlineSeq = 0;
  const registerInline = (source: string): string => {
    const id = `shadrox-inline-${inlineSeq}`;
    inlineSeq += 1;
    inlineModules.set(id, source);
    return id;
  };
  const asModule = (value: string) => ({ path: registerInline(`export default ${JSON.stringify(value)};`), namespace: 'shadrox-inline' });

  const resolveModule = (specifier: string, importer: string): string | null => {
    // Vite asset suffixes (./logo.svg?url, ./shader.glsl?raw) point at a real file.
    const clean = specifier.replace(/[?#].*$/, '');
    const base = clean.startsWith('/') ? clean : `${dirname(importer)}/${clean}`;
    const target = normalize(base);
    for (const extension of RESOLVE_EXTENSIONS) {
      if (sources.has(target + extension)) return target + extension;
    }
    for (const extension of RESOLVE_EXTENSIONS.slice(1)) {
      if (sources.has(`${target}/index${extension}`)) return `${target}/index${extension}`;
    }
    return null;
  };

  /** Workspace asset lookup, including tsconfig aliases that point at an asset. */
  const resolveAsset = (specifier: string, importer: string): string | null => {
    const direct = findAsset(specifier, importer, assets);
    if (direct) return direct;
    const aliasTarget = resolveAliasPath(specifier, aliases);
    return aliasTarget ? findAsset(`/${aliasTarget}`, '', assets) : null;
  };

  const virtualFs = {
    name: 'shadrox-vfs',
    setup(build: any) {
      build.onResolve({ filter: /.*/ }, (args: { path: string; importer: string; kind?: string }) => {
        const question = args.path.indexOf('?');
        const specifier = question === -1 ? args.path : args.path.slice(0, question);
        const query = question === -1 ? '' : args.path.slice(question + 1);
        const importer = args.importer || '';
        const isRelative = specifier.startsWith('.') || specifier.startsWith('/');

        // The entry point is always a workspace file, but esbuild hands it to us
        // both as `src/main.tsx` and as `./src/main.tsx`. Returning it as external
        // is a hard error ("entry point cannot be marked as external"), so the
        // entry is resolved against the virtual file system first.
        if (args.kind === 'entry-point') {
          const resolved = resolveModule(specifier, importer);
          if (resolved) return { path: resolved, namespace: 'shadrox' };
          return { errors: [{ text: `Entry file not found: ${args.path}` }] };
        }

        // Vite asset suffixes: `?url` yields a URL, `?raw` yields the file text.
        if (query === 'url' || query === 'raw') {
          if (query === 'url') {
            const dataUrl = resolveAsset(specifier, importer);
            if (dataUrl) return asModule(dataUrl);
          }
          const resolved = resolveModule(specifier, importer);
          if (resolved) {
            const content = sources.get(resolved) ?? '';
            return asModule(query === 'raw' ? content : textDataUrl(resolved, content));
          }
          // `esbuild-wasm/esbuild.wasm?url` — a package file requested as a URL
          // is a real CDN asset, which is what makes a nested bundler work.
          if (query === 'url') {
            const mapped = resolveImportMapUrl(specifier, importMap);
            if (mapped) return asModule(mapped);
          }
          return { errors: [{ text: `Asset not found: ${args.path}` }] };
        }

        // `import logo from './logo.png'` — binary files never reach `sources`.
        if (isRelative) {
          const asset = resolveAsset(specifier, importer);
          if (asset) return asModule(asset);
          const resolved = resolveModule(specifier, importer);
          if (resolved) return { path: resolved, namespace: 'shadrox' };
          return { errors: [{ text: `Module not found: ${args.path}` }] };
        }

        // tsconfig path mapping (@/components/Button) is a workspace file, not a package.
        const aliasTarget = resolveAliasPath(specifier, aliases);
        if (aliasTarget) {
          const asset = findAsset(`/${aliasTarget}`, '', assets);
          if (asset) return asModule(asset);
          const resolved = resolveModule(`/${aliasTarget}`, '');
          if (resolved) return { path: resolved, namespace: 'shadrox' };
        }

        // Bare specifier -> leave it to the import map in the iframe.
        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: 'shadrox' }, (args: { path: string }) => {
        const content = sources.get(args.path);
        if (content === undefined) return { errors: [{ text: `File not found: ${args.path}` }] };
        return { contents: content, loader: loaderFor(args.path) };
      });

      build.onLoad({ filter: /.*/, namespace: 'shadrox-inline' }, (args: { path: string }) => {
        const contents = inlineModules.get(args.path);
        if (contents === undefined) return { errors: [{ text: `Virtual module not found: ${args.path}` }] };
        return { contents, loader: 'js' };
      });
    }
  };

  // Virtual secret definitions injected directly into runtime without disk .env file
  const define: Record<string, string> = {
    'process.env.NODE_ENV': '"development"'
  };
  secrets.forEach((s) => {
    define[`process.env.${s.key}`] = JSON.stringify(s.value);
  });

  // Vite's env object, so `import.meta.env.DEV` and any missing key resolve
  // instead of throwing on an undefined `import.meta.env` in the sandbox.
  const viteEnv: Record<string, string | boolean> = {
    MODE: 'development',
    DEV: true,
    PROD: false,
    SSR: false,
    BASE_URL: '/'
  };
  secrets.forEach((s) => {
    viteEnv[s.key] = s.value;
  });
  define['import.meta.env'] = JSON.stringify(viteEnv);

  const result = await esbuild.build({
    entryPoints: [normalize(entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
    define,
    plugins: [virtualFs],
    outdir: 'shadrox-out'
  });

  let code = '';
  let css = '';
  for (const output of result.outputFiles ?? []) {
    if (output.path.endsWith('.css')) css += output.text;
    else code += output.text;
  }

  return { code, css, entry, importMap, routes: detectRoutes(files) };
}

/** Turns esbuild's error objects into something readable in the preview pane. */
export function describeBundleError(error: unknown): string {
  const failures = (error as { errors?: Array<{ text?: string; location?: { file?: string; line?: number } }> })
    ?.errors;
  if (Array.isArray(failures) && failures.length > 0) {
    return failures
      .slice(0, 4)
      .map((failure) => {
        const where = failure.location?.file
          ? `${failure.location.file}${failure.location.line ? `:${failure.location.line}` : ''}: `
          : '';
        return `${where}${failure.text || 'Build error'}`;
      })
      .join('\n');
  }
  return error instanceof Error ? error.message : 'Build failed.';
}

/**
 * Document that runs the bundle. `errorBridge` is injected by the caller so
 * runtime errors keep flowing into the same self-heal path as the static
 * preview. Tailwind CSS CDN is added so SaaS components render with full styling.
 *
 * When the workspace declares server routes, an API bridge is injected too: the
 * app's own requests are answered with simulated JSON instead of failing.
 */
export function bundleDocument(
  result: BundleResult,
  errorBridge: string,
  baseStyle: string,
  secrets: SecretItem[] = []
): string {
  const importMap = { imports: result.importMap };

  const virtualEnvObj: Record<string, string> = { NODE_ENV: 'development' };
  secrets.forEach((s) => {
    virtualEnvObj[s.key] = s.value;
  });

  const apiBridge = result.routes.length > 0 ? `<script>${apiMockBridge(result.routes)}</script>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseStyle}</style>
<style>${result.css}</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script>
  window.process = { env: ${JSON.stringify(virtualEnvObj)} };
  window.global = window.global || window;
</script>
</head>
<body>
<div id="root"></div>
<div id="app"></div>
<script>${errorBridge}</script>
${apiBridge}
<script type="module">
${result.code}
</script>
</body>
</html>`;
}
