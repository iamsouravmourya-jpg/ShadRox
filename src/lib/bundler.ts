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

/** Bare imports are resolved from CDN */
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

  // Anything that mounts React or renders JSX
  const mounter = files.find((file) => /from\s+['"]react-dom\/client['"]|from\s+['"]react-dom['"]/.test(file.content));
  if (mounter) return mounter.name;

  return null;
}

/** True when this workspace can be bundled and run, not just viewed. */
export function canBundle(files: WorkspaceFile[]): boolean {
  return findEntryFile(files) !== null;
}

export async function bundleProject(files: WorkspaceFile[], secrets: SecretItem[] = []): Promise<BundleResult> {
  const entry = findEntryFile(files);
  if (!entry) throw new Error('No entry file found (e.g. src/main.tsx, src/index.tsx, or index.html required).');

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
    name: 'shadrox-vfs',
    setup(build: any) {
      build.onResolve({ filter: /.*/ }, (args: { path: string; importer: string }) => {
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const resolved = resolveModule(args.path, args.importer || '');
          if (resolved) return { path: resolved, namespace: 'shadrox' };
          return { errors: [{ text: `Module not found: ${args.path}` }] };
        }
        // Bare specifier -> leave it to the import map in the iframe.
        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: 'shadrox' }, (args: { path: string }) => {
        const content = sources.get(args.path);
        if (content === undefined) return { errors: [{ text: `File not found: ${args.path}` }] };
        return { contents: content, loader: loaderFor(args.path) };
      });
    }
  };

  // Virtual secret definitions injected directly into runtime without disk .env file
  const define: Record<string, string> = {
    'process.env.NODE_ENV': '"development"'
  };
  secrets.forEach((s) => {
    define[`process.env.${s.key}`] = JSON.stringify(s.value);
    define[`import.meta.env.${s.key}`] = JSON.stringify(s.value);
  });

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
  return error instanceof Error ? error.message : 'Build failed.';
}

/**
 * Document that runs the bundle. `errorBridge` is injected by the caller so
 * runtime errors keep flowing into the same self-heal path as the static
 * preview. Tailwind CSS CDN is added so SaaS components render with full styling.
 */
export function bundleDocument(
  result: BundleResult,
  errorBridge: string,
  baseStyle: string,
  secrets: SecretItem[] = []
): string {
  const importMap = {
    imports: {
      react: `${CDN}/react@19`,
      'react/': `${CDN}/react@19/`,
      'react-dom': `${CDN}/react-dom@19`,
      'react-dom/': `${CDN}/react-dom@19/`,
      'react-dom/client': `${CDN}/react-dom@19/client`,
      'react/jsx-runtime': `${CDN}/react@19/jsx-runtime`,
      'react/jsx-dev-runtime': `${CDN}/react@19/jsx-dev-runtime`,
      'lucide-react': `${CDN}/lucide-react@0.460.0`,
      'clsx': `${CDN}/clsx@2.1.1`,
      'tailwind-merge': `${CDN}/tailwind-merge@2.5.4`
    }
  };

  const virtualEnvObj: Record<string, string> = { NODE_ENV: 'development' };
  secrets.forEach((s) => {
    virtualEnvObj[s.key] = s.value;
  });

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
</script>
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
