/**
 * Workspace dependency & TypeScript config manifest extractor for Coordinator
 * and Specialist Sub-Agents.
 *
 * Parses `package.json` (`dependencies`, `devDependencies`) and `tsconfig.json`
 * (`compilerOptions.baseUrl`, `compilerOptions.paths`) before dispatching any
 * sub-agent task so specialists never hallucinate uninstalled npm packages
 * (e.g. `zod`, `bullmq`, `ioredis`) or invent non-existent `@/` path aliases.
 */

export interface WorkspaceManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  baseUrl: string | null;
  pathAliases: Record<string, string[]>;
  hasPackageJson: boolean;
  hasTsconfig: boolean;
}

/**
 * Strips `//` line comments, `/* *\/` block comments, and trailing commas
 * outside quoted string literals so real-world `tsconfig.json` (JSONC) files
 * parse cleanly without a heavy dependency.
 */
export function parseJsonWithComments(raw: string): unknown {
  let stripped = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        stripped += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    stripped += ch;
  }

  // Remove trailing commas outside strings
  let out = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < stripped.length && /\s/.test(stripped[lookahead])) lookahead += 1;
      if (stripped[lookahead] === '}' || stripped[lookahead] === ']') continue;
    }
    out += ch;
  }

  return JSON.parse(out.trim());
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function asPathAliases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(value)) {
    if (Array.isArray(targets)) {
      const clean = targets.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (clean.length > 0) result[alias] = clean;
    }
  }
  return result;
}

export function parseWorkspaceManifest(
  packageJsonText: string | null | undefined,
  tsconfigText: string | null | undefined
): WorkspaceManifest {
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};
  let scripts: Record<string, string> = {};
  let hasPackageJson = false;

  if (typeof packageJsonText === 'string' && packageJsonText.trim()) {
    try {
      const parsed = JSON.parse(packageJsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hasPackageJson = true;
        dependencies = asStringMap((parsed as { dependencies?: unknown }).dependencies);
        devDependencies = asStringMap((parsed as { devDependencies?: unknown }).devDependencies);
        scripts = asStringMap((parsed as { scripts?: unknown }).scripts);
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  let baseUrl: string | null = null;
  let pathAliases: Record<string, string[]> = {};
  let hasTsconfig = false;

  if (typeof tsconfigText === 'string' && tsconfigText.trim()) {
    try {
      const parsed = parseJsonWithComments(tsconfigText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hasTsconfig = true;
        const compilerOptions = (parsed as { compilerOptions?: unknown }).compilerOptions;
        if (compilerOptions && typeof compilerOptions === 'object' && !Array.isArray(compilerOptions)) {
          const opts = compilerOptions as { baseUrl?: unknown; paths?: unknown };
          if (typeof opts.baseUrl === 'string' && opts.baseUrl.trim()) {
            baseUrl = opts.baseUrl.trim();
          }
          pathAliases = asPathAliases(opts.paths);
        }
      }
    } catch {
      /* ignore malformed tsconfig.json */
    }
  }

  return {
    dependencies,
    devDependencies,
    scripts,
    baseUrl,
    pathAliases,
    hasPackageJson,
    hasTsconfig
  };
}

function formatPackageList(entries: Record<string, string>, limit = 60): string {
  const names = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return '(none)';
  const shown = names.slice(0, limit).map((name) => `${name}@${entries[name]}`).join(', ');
  return names.length > limit ? `${shown} (+${names.length - limit} more)` : shown;
}

export function formatWorkspaceManifestBlock(manifest: WorkspaceManifest): string {
  const aliasEntries = Object.entries(manifest.pathAliases);
  const aliasLine = aliasEntries.length > 0
    ? aliasEntries.map(([alias, targets]) => `${alias} -> ${targets.join(' | ')}`).join('; ')
    : '(none configured)';

  const scriptEntries = Object.keys(manifest.scripts);
  const lines = [
    'WORKSPACE MANIFEST & DEPENDENCY CONSTRAINTS:',
    `- package.json dependencies: ${manifest.hasPackageJson ? formatPackageList(manifest.dependencies) : '(no package.json found)'}`,
    `- package.json devDependencies: ${manifest.hasPackageJson ? formatPackageList(manifest.devDependencies) : '(none)'}`,
    ...(scriptEntries.length > 0
      ? [`- package.json scripts: ${scriptEntries.slice(0, 10).map((k) => `${k}="${manifest.scripts[k]}"`).join(', ')}`]
      : []),
    `- tsconfig.json baseUrl: ${manifest.baseUrl ?? '(none)'}`,
    `- tsconfig.json compilerOptions.paths: ${manifest.hasTsconfig ? aliasLine : '(no tsconfig.json found)'}`,
    '- STRICT RULE: NEVER import external packages not explicitly listed in `package.json`. If validation, queues, rate-limiting, or helpers are needed and no library is installed, write zero-dependency native TypeScript implementations.',
    '- STRICT RULE: Only use path aliases explicitly listed in `tsconfig.json` above (never invent aliases or non-existent helper paths). Verify every import path matches real files in the workspace.'
  ];
  return lines.join('\n');
}
