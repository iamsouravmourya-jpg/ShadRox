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

type Loader = 'tsx' | 'ts' | 'jsx' | 'js' | 'json' | 'css' | 'local-css' | 'text';

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
  'tailwind-merge': `${CDN}/tailwind-merge@2.5.4`,
  path: `${CDN}/path-browserify@1.0.1`,
  'node:path': `${CDN}/path-browserify@1.0.1`
};

/** Node.js built-ins that have no browser sandbox equivalent */
const NODE_BUILTINS_UNSUPPORTED = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'console',
  'constants',
  'crypto',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'node:fs',
  'http',
  'https',
  'http2',
  'inspector',
  'module',
  'os',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'test',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster'
]);

function packageNameFromSpecifier(specifier: string): string | null {
  if (!specifier || specifier.startsWith('#') || specifier.startsWith('node:')) return null;
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  return /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/i.test(packageName) ? packageName : null;
}

function isUnsupportedNodeBuiltin(specifier: string): boolean {
  const unprefixed = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const builtin = unprefixed.split('/')[0];
  return NODE_BUILTINS_UNSUPPORTED.has(specifier) ||
    NODE_BUILTINS_UNSUPPORTED.has(unprefixed) ||
    NODE_BUILTINS_UNSUPPORTED.has(builtin);
}

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
      const esbuild = await import('esbuild-wasm');
      if (typeof window === 'undefined') {
        // Node / test environment: initialize native wasm runner
        await esbuild.initialize({});
        return esbuild;
      }
      try {
        const wasm = await import('esbuild-wasm/esbuild.wasm?url');
        await esbuild.initialize({ wasmURL: wasm.default });
      } catch (err: unknown) {
        if (!String((err as { message?: string })?.message).includes('already been called')) {
          // Fallback to CDN URL if local asset URL fails
          await esbuild.initialize({ wasmURL: `${CDN}/esbuild-wasm@0.28.2/esbuild.wasm` });
        }
      }
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
  if (/\.module\.css$/i.test(path)) return 'local-css';
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

  // Force esbuild-wasm to resolve to a CDN asset even if not in package.json.
  // This is required for ShadRox to bundle itself (nested bundling).
  if (!imports['esbuild-wasm']) imports['esbuild-wasm'] = `${CDN}/esbuild-wasm@0.28.2`;
  if (!imports['esbuild-wasm/']) imports['esbuild-wasm/'] = `${CDN}/esbuild-wasm@0.28.2/`;

  // Force React and ReactDOM to be singletons via the import map.
  // This prevents "Cannot read properties of null (reading 'useState')" errors
  // caused by multiple React instances being loaded from different CDN paths.
  const reactUrl = imports['react'] || DEFAULT_IMPORT_MAP['react'];
  const reactDomUrl = imports['react-dom'] || DEFAULT_IMPORT_MAP['react-dom'];

  imports['react'] = reactUrl;
  imports['react-dom'] = reactDomUrl;

  // Import-map prefix targets cannot safely append subpaths after a query
  // string, and React's JSX runtime must externalize React to preserve hooks.
  if (!imports['react/']) imports['react/'] = `${reactUrl}/`;
  if (!imports['react-dom/']) imports['react-dom/'] = `${reactDomUrl}/`;
  const reactBaseUrl = reactUrl.split('?')[0];
  const reactDomBaseUrl = reactDomUrl.split('?')[0];
  imports['react/jsx-runtime'] = `${reactBaseUrl}/jsx-runtime?external=react-dom`;
  imports['react/jsx-dev-runtime'] = `${reactBaseUrl}/jsx-dev-runtime?external=react-dom`;
  imports['react-dom/client'] = `${reactDomBaseUrl}/client?external=react`;

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
 * Reads `@/*` style aliases from mounted tsconfig/jsconfig files, so imports that
 * only resolve through TypeScript path mapping also resolve in the sandbox.
 * Inspects solution-style tsconfigs (tsconfig.app.json, tsconfig.json, jsconfig.json).
 */
export function readPathAliases(files: WorkspaceFile[], root: string = ''): PathAlias[] {
  const candidateNames = [
    root ? `${root}/tsconfig.app.json`.toLowerCase() : 'tsconfig.app.json',
    root ? `${root}/tsconfig.json`.toLowerCase() : 'tsconfig.json',
    root ? `${root}/jsconfig.json`.toLowerCase() : 'jsconfig.json',
    root ? `${root}/tsconfig.base.json`.toLowerCase() : 'tsconfig.base.json'
  ];

  const configs = files.filter((file) => candidateNames.includes(normalize(file.name).toLowerCase()));
  if (configs.length === 0) return [];

  const allAliases: PathAlias[] = [];
  const seenPrefixes = new Set<string>();

  for (const config of configs) {
    const parsed = parseJsonc(config.content);
    const options = parsed?.compilerOptions as { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
    const paths = options?.paths;
    if (!paths || typeof paths !== 'object') continue;

    let base = normalize(String(options?.baseUrl ?? '.'));
    if (root) base = base === '.' || !base ? root : `${root}/${base}`;

    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0 || seenPrefixes.has(pattern)) continue;
      seenPrefixes.add(pattern);
      const star = pattern.indexOf('*');
      allAliases.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? '' : pattern.slice(star + 1),
        targets: targets
          .filter((target): target is string => typeof target === 'string')
          .map((target) => normalize(base ? `${base}/${target}` : target))
      });
    }
  }

  return allAliases;
}

/** Returns all workspace path candidates an aliased import points at. */
export function resolveAliasPath(specifier: string, aliases: PathAlias[]): string[] {
  const matches: string[] = [];
  for (const alias of aliases) {
    if (specifier.length < alias.prefix.length + alias.suffix.length) continue;
    if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
    const captured = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    for (const target of alias.targets) {
      if (target.includes('*')) matches.push(target.replace('*', captured));
      else if (!captured) matches.push(target);
    }
  }
  return matches;
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

/** True when this workspace can be bundled and run with the React/Vite bundler. */
export function canBundle(files: WorkspaceFile[]): boolean {
  const root = findProjectRoot(files);
  const entry = findEntryFile(files, root);
  if (!entry) return false;

  // If there is an index.html, check whether this is truly a bundlable React/JSX project
  // or a pure static HTML/CSS/JS site.
  const hasIndexHtml = files.some(
    (f) => normalize(f.name).toLowerCase() === (root ? `${root}/index.html`.toLowerCase() : 'index.html')
  );
  if (hasIndexHtml) {
    const hasReactOrJsx = files.some((f) => {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (ext === 'tsx' || ext === 'jsx') return true;
      return /from\s+['"]react['"]|from\s+['"]react-dom['"]|createRoot\(|ReactDOM\.render/.test(f.content);
    });
    const hasPackageJson = files.some((f) => normalize(f.name).toLowerCase().endsWith('package.json'));
    if (!hasReactOrJsx && !hasPackageJson) {
      // Pure static HTML/CSS/JS website — render via HTML preview so index.html structure is not replaced
      return false;
    }
  }

  return true;
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
    const candidates = [target];
    if (root && !target.startsWith(root)) {
      candidates.push(normalize(`${root}/${target}`));
    }

    for (const cand of candidates) {
      for (const extension of RESOLVE_EXTENSIONS) {
        if (sources.has(cand + extension)) return cand + extension;
      }
      for (const extension of RESOLVE_EXTENSIONS.slice(1)) {
        if (sources.has(`${cand}/index${extension}`)) return `${cand}/index${extension}`;
      }
    }
    return null;
  };

  /** Workspace asset lookup, including tsconfig aliases that point at an asset. */
  const resolveAsset = (specifier: string, importer: string): string | null => {
    const direct = findAsset(specifier, importer, assets);
    if (direct) return direct;
    const aliasTargets = resolveAliasPath(specifier, aliases);
    for (const target of aliasTargets) {
      const hit = findAsset(`/${target}`, '', assets);
      if (hit) return hit;
    }
    return null;
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

        // 1. CSS url(...) tokens: must return an external URL or data URL (not a JS module!)
        if (args.kind === 'url-token') {
          if (/^(?:https?:)?\/\//i.test(specifier) || specifier.startsWith('data:')) {
            return { path: specifier, external: true };
          }
          const asset = resolveAsset(specifier, importer);
          if (asset) return { path: asset, external: true };

          const resolved = resolveModule(specifier, importer);
          if (resolved) {
            const content = sources.get(resolved) ?? '';
            return { path: textDataUrl(resolved, content), external: true };
          }
          return { errors: [{ text: `Asset not found in CSS: ${args.path}` }] };
        }

        // 2. Vite asset query suffixes: `?url` yields a data/asset URL, `?raw` yields the file text.
        if (query === 'url' || query === 'raw') {
          if (query === 'url') {
            const dataUrl = resolveAsset(specifier, importer);
            if (dataUrl) return asModule(dataUrl);

            // Package file requested as a URL (e.g. esbuild-wasm/esbuild.wasm?url)
            const mapped = resolveImportMapUrl(specifier, importMap);
            if (mapped) return asModule(mapped);
          }

          const resolved = resolveModule(specifier, importer);
          if (resolved) {
            const content = sources.get(resolved) ?? '';
            return asModule(query === 'raw' ? content : textDataUrl(resolved, content));
          }

          return { errors: [{ text: `Asset not found: ${args.path}` }] };
        }

        // Tailwind's package stylesheet is a build-time entrypoint. The preview
        // document injects Tailwind's browser CDN, so importing it in VFS would
        // otherwise fail because node_modules are intentionally not mounted.
        if (args.kind === 'import-rule' && specifier === 'tailwindcss') {
          return { path: 'shadrox-tailwindcss-cdn.css', namespace: 'shadrox-inline-css' };
        }

        // 3. Relative imports or CSS @import rules
        if (isRelative || args.kind === 'import-rule') {
          const asset = resolveAsset(specifier, importer);
          if (asset) return asModule(asset);

          const resolved = resolveModule(specifier, importer);
          if (resolved) {
            // If importing a text asset (SVG, etc.) in JS, return data URL so <img src={logo} /> renders
            const ext = (resolved.split('.').pop() || '').toLowerCase();
            if (TEXT_ASSET_MIME[ext] && !importer.endsWith('.css')) {
              const content = sources.get(resolved) ?? '';
              return asModule(textDataUrl(resolved, content));
            }
            return { path: resolved, namespace: 'shadrox' };
          }
          return { errors: [{ text: `Module not found: ${args.path}` }] };
        }

        // 4. TypeScript path mapping (@/components/Button)
        const aliasTargets = resolveAliasPath(specifier, aliases);
        if (aliasTargets.length > 0) {
          for (const target of aliasTargets) {
            const asset = findAsset(`/${target}`, '', assets);
            if (asset) return asModule(asset);

            const resolved = resolveModule(`/${target}`, '');
            if (resolved) {
              const ext = (resolved.split('.').pop() || '').toLowerCase();
              if (TEXT_ASSET_MIME[ext] && !importer.endsWith('.css')) {
                const content = sources.get(resolved) ?? '';
                return asModule(textDataUrl(resolved, content));
              }
              return { path: resolved, namespace: 'shadrox' };
            }
          }
          // Only error if not also resolvable through package import map
          if (!resolveImportMapUrl(args.path, importMap)) {
            return {
              errors: [
                {
                  text: `Workspace alias "${specifier}" points to a missing file (${aliasTargets.join(', ')}).`
                }
              ]
            };
          }
        }

        // 5. Bare dependencies resolved by the iframe import map.
        if (resolveImportMapUrl(args.path, importMap)) {
          const packageName = packageNameFromSpecifier(args.path);
          const prefix = packageName ? importMap[`${packageName}/`] : undefined;
          if (packageName && prefix && args.path !== packageName && !importMap[args.path]) {
            const externals = ['react', 'react-dom'].filter((name) => name !== packageName);
            importMap[args.path] = `${prefix}${args.path.slice(packageName.length + 1)}?external=${externals.join(',')}`;
          }
          return { path: args.path, external: true };
        }

        // 6. Explicit URL imports (CDN/HTTP)
        if (/^(?:https?:)?\/\//i.test(args.path)) {
          return { path: args.path, external: true };
        }

        // 7. Unsupported Node.js modules in browser preview
        if (isUnsupportedNodeBuiltin(args.path)) {
          return {
            errors: [
              {
                text: `Node.js built-in module "${args.path}" cannot run in the browser preview. Replace with browser APIs or mock data.`
              }
            ]
          };
        }

        // Resolve undeclared npm packages through the browser CDN rather than
        // modifying the workspace or running package install scripts.
        const packageName = packageNameFromSpecifier(args.path);
        if (packageName) {
          const externals = ['react', 'react-dom'].filter((name) => name !== packageName);
          const cdnBase = cdnUrl(packageName, '', externals);
          if (!importMap[packageName]) importMap[packageName] = cdnBase;
          if (!importMap[`${packageName}/`]) importMap[`${packageName}/`] = `${CDN}/${packageName}/`;
          if (args.path !== packageName) {
            importMap[args.path] = `${CDN}/${args.path}?external=${externals.join(',')}`;
          }
          return { path: args.path, external: true };
        }

        return {
          errors: [
            {
              text: `Could not resolve module "${args.path}". Check the import path and package name.`
            }
          ]
        };
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

      build.onLoad({ filter: /.*/, namespace: 'shadrox-inline-css' }, () => ({
        contents: '',
        loader: 'css'
      }));
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

  // Use a virtual stdin entry that imports the workspace entry. This ensures
  // the entry goes through the same VFS resolver as every other local module;
  // esbuild can otherwise bypass plugin resolution for bare relative entries.
  const result = await esbuild.build({
    stdin: {
      contents: `import ${JSON.stringify(`./${normalize(entry)}`)};`,
      resolveDir: '/',
      sourcefile: 'shadrox-preview-entry.js',
      loader: 'js'
    },
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
  secrets: SecretItem[] = [],
  templateHtml?: string
): string {
  const importMap = { imports: result.importMap };

  const virtualEnvObj: Record<string, string> = { NODE_ENV: 'development' };
  secrets.forEach((s) => {
    virtualEnvObj[s.key] = s.value;
  });

  const apiBridge = result.routes.length > 0 ? `<script>${apiMockBridge(result.routes)}</script>` : '';

  const headInjections = `
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseStyle}</style>
<style>${result.css}</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script>
  window.process = { env: ${JSON.stringify(virtualEnvObj)} };
  window.global = window.global || window;
</script>`;

  let bodyInjections = `
<script>${errorBridge}</script>
  <script>console.info('[ShadRox] Browser dependencies are being resolved automatically; no terminal or project install is required.');</script>
  ${apiBridge}
<script type="module">
${result.code}
</script>`;

  if (templateHtml && templateHtml.includes('<html')) {
    let html = templateHtml;
    // Strip original script tags pointing to main.tsx/jsx/ts/js so they don't execute twice or 404
    html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*\b(main|index)\.(?:tsx|jsx|ts|js)[^"']*["'][^>]*><\/script>/gi, '');

    // Inject head items
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, () => `${headInjections}\n</head>`);
    } else {
      html = `${headInjections}\n${html}`;
    }

    // Ensure #root or #app mount container exists if neither is present
    if (!html.includes('id="root"') && !html.includes("id='root'") && !html.includes('id="app"') && !html.includes("id='app'")) {
      bodyInjections = `<div id="root"></div>\n${bodyInjections}`;
    }

    // Inject body items
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, () => `${bodyInjections}\n</body>`);
    } else {
      html = `${html}\n${bodyInjections}`;
    }

    return html;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${headInjections}
</head>
<body>
<div id="root"></div>
<div id="app"></div>
${bodyInjections}
</body>
</html>`;
}
