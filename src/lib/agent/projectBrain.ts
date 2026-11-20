/**
 * Architecture & Product Brain for ShadRox.
 *
 * Produces a compact, high-signal architecture summary from the workspace file
 * inventory and optional package.json contents so the agent ALWAYS knows the
 * exact stack, scripts, package manager, styling engine, and directory
 * conventions before proposing or writing a single line of code.
 */

export interface ProjectArchitecture {
  kind: 'empty' | 'framework-web' | 'node-backend' | 'static-web' | 'library-or-cli' | 'other';
  framework: string | null;
  language: 'TypeScript' | 'JavaScript' | 'HTML/CSS/JS' | 'Unknown';
  styling: string | null;
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm' | null;
  routerStyle: string | null;
  scripts: Array<{ name: string; command: string }>;
  conventions: string[];
  deployTarget: string | null;
}

const IGNORED_PATH_PREFIXES = ['node_modules/', '.git/', 'dist/', 'build/', '.next/', '.nuxt/', 'coverage/'];

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSourcePath(path: string): boolean {
  return !IGNORED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function analyzeProjectStack(
  filePaths: readonly string[],
  packageJsonText?: string | null
): ProjectArchitecture {
  const paths = filePaths.map(normalizePath).filter(Boolean).filter(isSourcePath);
  if (paths.length === 0 && !packageJsonText) {
    return {
      kind: 'empty',
      framework: null,
      language: 'Unknown',
      styling: null,
      packageManager: null,
      routerStyle: null,
      scripts: [],
      conventions: [],
      deployTarget: 'empty folder — scaffold modular multi-file architecture'
    };
  }

  const lowerSet = new Set(paths.map((p) => p.toLowerCase()));
  const hasPrefix = (prefix: string) => paths.some((p) => p.toLowerCase().startsWith(prefix));
  const hasExt = (ext: string) => paths.some((p) => p.toLowerCase().endsWith(ext));

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, unknown>;
    packageManager?: string;
  } | null = null;
  if (packageJsonText) {
    try {
      const parsed = JSON.parse(packageJsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed;
    } catch {
      /* ignore malformed package.json */
    }
  }

  const deps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {})
  };
  const hasDep = (name: string) => typeof deps[name] === 'string';

  // Package manager detection
  let packageManager: ProjectArchitecture['packageManager'] = null;
  if (pkg?.packageManager?.startsWith('pnpm@') || lowerSet.has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (pkg?.packageManager?.startsWith('bun@') || lowerSet.has('bun.lockb') || lowerSet.has('bun.lock')) packageManager = 'bun';
  else if (pkg?.packageManager?.startsWith('yarn@') || lowerSet.has('yarn.lock')) packageManager = 'yarn';
  else if (pkg || lowerSet.has('package-lock.json')) packageManager = 'npm';

  // Framework & router detection
  let framework: string | null = null;
  let routerStyle: string | null = null;
  let kind: ProjectArchitecture['kind'] = 'other';

  if (hasDep('next') || paths.some((p) => /^next\.config\./i.test(p))) {
    framework = hasDep('react') ? 'Next.js (React)' : 'Next.js';
    kind = 'framework-web';
    if (hasPrefix('src/app/') || hasPrefix('app/')) routerStyle = 'App Router';
    else if (hasPrefix('src/pages/') || hasPrefix('pages/')) routerStyle = 'Pages Router';
  } else if (hasDep('vite') || paths.some((p) => /^vite\.config\./i.test(p))) {
    const ui = hasDep('react')
      ? 'React'
      : hasDep('vue')
        ? 'Vue'
        : hasDep('svelte')
          ? 'Svelte'
          : hasDep('solid-js')
            ? 'Solid'
            : null;
    framework = ui ? `Vite + ${ui}` : 'Vite';
    kind = 'framework-web';
  } else if (hasDep('astro') || paths.some((p) => /^astro\.config\./i.test(p))) {
    framework = 'Astro';
    kind = 'framework-web';
  } else if (hasDep('nuxt')) {
    framework = 'Nuxt';
    kind = 'framework-web';
  } else if (hasDep('@remix-run/react')) {
    framework = 'Remix (React)';
    kind = 'framework-web';
  } else if (hasDep('react')) {
    framework = 'React';
    kind = 'framework-web';
  } else if (hasDep('express') || hasDep('fastify') || hasDep('hono') || hasDep('koa')) {
    const serverLib = hasDep('hono') ? 'Hono' : hasDep('fastify') ? 'Fastify' : hasDep('express') ? 'Express' : 'Koa';
    framework = `Node.js + ${serverLib}`;
    kind = 'node-backend';
  } else if (!pkg && (lowerSet.has('index.html') || hasExt('.html'))) {
    framework = 'Static HTML/CSS/JS';
    kind = 'static-web';
  } else if (pkg) {
    kind = 'library-or-cli';
  }

  // Language detection
  const hasTs = lowerSet.has('tsconfig.json') || hasDep('typescript') || hasExt('.ts') || hasExt('.tsx');
  const hasJs = hasExt('.js') || hasExt('.jsx') || hasExt('.mjs') || hasExt('.cjs');
  const language: ProjectArchitecture['language'] = hasTs
    ? 'TypeScript'
    : hasJs
      ? 'JavaScript'
      : hasExt('.html')
        ? 'HTML/CSS/JS'
        : 'Unknown';

  // Styling detection
  const styleParts: string[] = [];
  if (hasDep('tailwindcss') || hasDep('@tailwindcss/vite') || paths.some((p) => /^tailwind\.config\./i.test(p))) {
    styleParts.push(hasDep('@tailwindcss/vite') ? 'Tailwind CSS v4' : 'Tailwind CSS');
  }
  if (lowerSet.has('components.json')) styleParts.push('shadcn/ui');
  if (hasExt('.module.css') || hasExt('.module.scss')) styleParts.push('CSS Modules');
  else if (hasExt('.scss') || hasExt('.sass')) styleParts.push('Sass/SCSS');
  else if (styleParts.length === 0 && hasExt('.css')) styleParts.push('CSS');
  const styling = styleParts.length > 0 ? styleParts.join(' + ') : null;

  // Scripts (priority order)
  const scripts: Array<{ name: string; command: string }> = [];
  const rawScripts = pkg?.scripts ?? {};
  for (const key of ['dev', 'build', 'typecheck', 'type-check', 'lint', 'test', 'start']) {
    const cmd = rawScripts[key];
    if (typeof cmd === 'string' && cmd.trim()) {
      scripts.push({ name: key, command: cmd.trim().slice(0, 80) });
    }
  }

  // Directory conventions
  const conventions: string[] = [];
  for (const dir of [
    'src/app', 'app', 'src/pages', 'pages', 'src/components', 'components',
    'src/lib', 'lib', 'src/hooks', 'api', 'server', 'public', 'assets'
  ]) {
    if (hasPrefix(`${dir}/`)) conventions.push(`${dir}/`);
  }
  if (lowerSet.has('src/app.tsx') || lowerSet.has('src/main.tsx')) {
    conventions.push(lowerSet.has('src/main.tsx') ? 'entry: src/main.tsx' : 'entry: src/App.tsx');
  } else if (lowerSet.has('src/index.ts') || lowerSet.has('src/main.ts')) {
    conventions.push(lowerSet.has('src/main.ts') ? 'entry: src/main.ts' : 'entry: src/index.ts');
  }

  let deployTarget: string | null = null;
  if (kind === 'framework-web' || kind === 'node-backend') {
    deployTarget = 'Git/Vercel-ready modular build';
  } else if (kind === 'static-web') {
    deployTarget = 'static multi-file web bundle';
  }

  return {
    kind,
    framework,
    language,
    styling,
    packageManager,
    routerStyle,
    scripts,
    conventions,
    deployTarget
  };
}

export function formatArchitectureSummary(arch: ProjectArchitecture): string {
  if (arch.kind === 'empty') {
    return [
      'PROJECT ARCHITECTURE: Empty workspace.',
      '- Follow scaffold discipline: create a clean, modular multi-file web app or framework structure (never dump everything into one giant raw HTML file).'
    ].join('\n');
  }

  const stackParts = [
    arch.framework,
    arch.routerStyle,
    arch.language !== 'Unknown' ? arch.language : null,
    arch.styling
  ].filter(Boolean);

  const lines = [
    `PROJECT ARCHITECTURE: ${stackParts.join(' · ') || arch.kind}${arch.packageManager ? ` (${arch.packageManager})` : ''}`,
    ...(arch.conventions.length > 0 ? [`- Conventions: ${arch.conventions.slice(0, 8).join(', ')}`] : []),
    ...(arch.scripts.length > 0
      ? [`- Scripts: ${arch.scripts.slice(0, 6).map((s) => `${s.name}="${s.command}"`).join(', ')}`]
      : []),
    '- Integration rule: match the existing stack, components, types, and folder layout above. Verify with project scripts before finishing.'
  ];
  return lines.join('\n');
}
