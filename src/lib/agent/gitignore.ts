/**
 * A small gitignore matcher for the agent's directory walks.
 *
 * Supports the parts of the format that matter for listing a project: comments,
 * negation (`!keep.log`), directory-only rules (`build/`), anchoring (`/root-only`,
 * any pattern containing a slash), and `*`, `?`, `**` globs. The last matching
 * rule wins, exactly like git. A rule that ignores a directory also ignores
 * everything under it, so ancestors are checked as directories.
 *
 * Pure and dependency-free: the tool layer feeds it the `.gitignore` text it
 * read from disk and asks about workspace-relative POSIX paths.
 */

export interface GitignoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function globToRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
          continue;
        }
        source += '.*';
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Trailing spaces are ignored unless escaped; leading spaces are literal.
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    rules.push({ negated, dirOnly, anchored, regex: globToRegex(line) });
  }
  return rules;
}

function ruleMatches(rule: GitignoreRule, relativePath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.anchored) return rule.regex.test(relativePath);
  // Unanchored: the pattern matches the basename at any depth, or any full
  // path suffix when it contains no slash (git's "match at any level" rule).
  const base = relativePath.split('/').pop() ?? relativePath;
  return rule.regex.test(base) || rule.regex.test(relativePath);
}

/**
 * Whether a path is ignored. `isDir` says the path itself is a directory;
 * ancestor directories are always checked so `build/` hides `build/out/x.js`.
 */
export function isIgnoredPath(rules: GitignoreRule[], relativePath: string, isDir = false): boolean {
  if (rules.length === 0) return false;
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return false;
  const segments = clean.split('/');
  let ignored = false;
  // Ancestors first: a negation deeper in the tree can re-include a file whose
  // parent directory was ignored only if git would re-include the parent too,
  // so an ignored ancestor directory stays ignored for its children.
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join('/');
    const prefixIsDir = depth < segments.length ? true : isDir;
    let decision: boolean | null = null;
    for (const rule of rules) {
      if (ruleMatches(rule, prefix, prefixIsDir)) decision = !rule.negated;
    }
    if (decision !== null) ignored = decision;
    if (ignored && depth < segments.length) return true;
  }
  return ignored;
}