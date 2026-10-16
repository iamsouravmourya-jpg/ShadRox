import type { WorkspaceFile } from './types';

/**
 * In-browser bundling with esbuild-wasm.
 *
 * The workspace files are fed to esbuild through a virtual file system, so a
 * real React + TypeScript project can be bundled and run inside the preview
 * iframe without a server build step. Anything the compiler cannot resolve
 * inside the workspace (react, react-dom, ...) stays external and is satisfied
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
  'main.tsx',
  'main.jsx',
  'index.tsx',
  'index.jsx',
  'main.ts',
  'index.ts',
  'main.js',
  'index.js'
];

const RESOLVE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'];

/** Bare imports are never bundled — the iframe resolves them from a CDN. */
const CDN = 'https://esm.sh';

export interface BundleResult {
  code: string;
  css: string;
  entry: string;
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
      // Allow a later attempt instead of caching a broken initialisation.
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

/** Picks the file that boots the app, or null when nothing looks runnable. */
export function findEntryFile(files: WorkspaceFile[]): string | null {
  const byName = new Map(files.map((file) => [file.name.toLowerCase(), file.name]));
  for (const candidate of ENTRY_CANDIDATES) {
    const hit = byName.get(candidate);
    if (hit) return hit;
  }

  // Anything that mounts React is by definition the entry point.
  const mounter = files.find((file) => /from\s+['"]react-dom\/client['"]/.test(file.content));
  if (mounter) return mounter.name;

  return null;
}

/** True when this workspace can be bundled and run, not just viewed. */
export function canBundle(files: WorkspaceFile[]): boolean {
  return findEntryFile(files) !== null;
}

export async function bundleProject(files: WorkspaceFile[]): Promise<BundleResult> {
  const entry = findEntryFile(files);
  if (!entry) throw new Error('Koi entry file nahi mili (src/main.tsx ya index.html chahiye).');

  const esbuild = await loadEsbuild();
  const sources = new Map(files.map((file) => [normalize(file.name), file.content]));

  const resolveModule = (specifier: string, importer: string): string | null => {
    const base = specifier.startsWith('/') ? specifier : `${dirname(importer)}/${specifier}`;
    const target = normalize(base);
    for (const extension of RESOLVE_EXTENSIONS) {
      if (sources.has(target + extension)) return target + extension;
    }
    for (const extension of RESOLVE_EXTENSIONS.slice(1)) {
      if (sources.has(`${target}/index${extension}`)) return `${target}/index${extension}`;
    }
    return null;
  };

  const virtualFs = {
    name: 'devora-vfs',
    setup(build: any) {
      build.onResolve({ filter: /.*/ }, (args: { path: string; importer: string }) => {
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const resolved = resolveModule(args.path, args.importer || '');
          if (resolved) return { path: resolved, namespace: 'devora' };
          return { errors: [{ text: `Module nahi mila: ${args.path}` }] };
        }
        // Bare specifier -> leave it to the import map in the iframe.
        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: 'devora' }, (args: { path: string }) => {
        const content = sources.get(args.path);
        if (content === undefined) return { errors: [{ text: `File nahi mili: ${args.path}` }] };
        return { contents: content, loader: loaderFor(args.path) };
      });
    }
  };

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
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [virtualFs],
    outdir: 'devora-out'
  });

  let code = '';
  let css = '';
  for (const output of result.outputFiles ?? []) {
    if (output.path.endsWith('.css')) css += output.text;
    else code += output.text;
  }

  return { code, css, entry };
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
  return error instanceof Error ? error.message : 'Bundle fail hua.';
}

/**
 * Document that runs the bundle. `errorBridge` is injected by the caller so
 * runtime errors keep flowing into the same self-heal path as the static
 * preview.
 */
export function bundleDocument(result: BundleResult, errorBridge: string, baseStyle: string): string {
  const importMap = {
    imports: {
      react: `${CDN}/react@19`,
      'react/': `${CDN}/react@19/`,
      'react-dom': `${CDN}/react-dom@19`,
      'react-dom/': `${CDN}/react-dom@19/`,
      'react/jsx-runtime': `${CDN}/react@19/jsx-runtime`,
      'react/jsx-dev-runtime': `${CDN}/react@19/jsx-dev-runtime`
    }
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${baseStyle}</style>
<style>${result.css}</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body>
<div id="root"></div>
<div id="app"></div>
<script>${errorBridge}</script>
<script type="module">
${result.code}
</script>
</body>
</html>`;
}
