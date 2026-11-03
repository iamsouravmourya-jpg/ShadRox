/**
 * Mapping from what the preview reports — a served URL, a stack frame file, an
 * inlined asset marker — back to a workspace-relative source file.
 *
 * Every input here is a string the runtime actually emitted: the dev server's
 * own stack trace, the static server's resolved path, the `data-source`
 * attributes ShadRox adds when inlining workspace CSS/JS. No JSX component
 * inference happens anywhere — a DOM node inside a bundled React app cannot be
 * honestly traced to the component that rendered it without a build-time
 * instrument, which this project does not do.
 */

export interface SourceLocation {
  path: string;
  line?: number;
  character?: number;
}

const SOURCE_EXTENSIONS =
  /\.(tsx|ts|jsx|js|mjs|cjs|mts|cts|vue|svelte|astro|html|htm|css|scss|sass|less|py|go|rs|java|php|rb|cs|kt|swift)$/i;

/** Directories that mark the start of a project's own source inside a frame path. */
const SOURCE_ROOT_HINTS = /^(src|app|pages|lib|components|client|server|api)$/;

/** `<function> (file:line:column)` and bare `at file:line:column` frames. */
const FRAME_PATTERN = /at\s+(?:async\s+)?(?:[^(\n]*?\(|)\s*([^()\s]+?):(\d{1,7}):(\d{1,6})\)?/g;

export function normalizeSlashes(value: string): string {
  return String(value ?? '').replace(/\\/g, '/');
}

export function stripAnsi(value: string): string {
  return String(value ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** A workspace-relative candidate for a stack frame's file, or null when it is not project code. */
export function workspacePathFromFrameFile(file: string): string | null {
  let pathname = normalizeSlashes(String(file ?? '')).split('?')[0].split('#')[0];
  pathname = pathname.replace(/^webpack:\//, '').replace(/^@[^/]+\//, '');
  if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(pathname)) {
    try {
      pathname = normalizeSlashes(new URL(pathname).pathname);
    } catch {
      return null;
    }
  }
  if (pathname.startsWith('file:///')) pathname = pathname.slice('file://'.length);
  pathname = pathname.replace(/^\/+/, '');

  if (!pathname || pathname.includes('node_modules/') || pathname.includes('..')) return null;
  if (/^node:internal\//.test(pathname) || /^node:/.test(pathname)) return null;
  if (!SOURCE_EXTENSIONS.test(pathname)) return null;
  // A CDN URL is not this project's source, however plausible the filename looks.
  if (/^https?:\/\//i.test(file)) {
    let origin = '';
    try {
      origin = new URL(file).host;
    } catch {
      return null;
    }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return null;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const hint = segments.findIndex((segment) => SOURCE_ROOT_HINTS.test(segment));
  const relative = hint > 0 ? segments.slice(hint).join('/') : segments.join('/');
  if (!relative || relative.includes('..')) return null;
  return relative;
}

/** Every stack frame that names a project file, closest to the throw first. */
export function parseStackFrames(stack: string): SourceLocation[] {
  if (typeof stack !== 'string' || !stack) return [];
  const text = stripAnsi(stack);
  const frames: SourceLocation[] = [];
  FRAME_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FRAME_PATTERN.exec(text))) {
    const path = workspacePathFromFrameFile(match[1]);
    if (!path) continue;
    const line = Number(match[2]);
    const character = Number(match[3]);
    if (!Number.isInteger(line) || line < 1) continue;
    if (frames.some((frame) => frame.path === path && frame.line === line)) continue;
    frames.push({ path, line, character });
  }
  return frames;
}

/** The first frame that maps to a workspace file, or null. */
export function sourceFromStack(stack: string | undefined): SourceLocation | null {
  const frames = parseStackFrames(stack ?? '');
  return frames.length > 0 ? frames[0] : null;
}

/**
 * Case-insensitively resolves a candidate against the mounted file list,
 * tolerating the shortened paths stacks report (`App.tsx` for `src/App.tsx`).
 * Ambiguous matches are refused rather than guessed.
 */
export interface FileLike {
  name: string;
}

export function matchWorkspaceFile(candidate: string, files: FileLike[]): string | null {
  if (!candidate || !Array.isArray(files) || files.length === 0) return null;
  const needle = normalizeSlashes(candidate).toLowerCase();
  const names = files.map((file) => normalizeSlashes(file?.name ?? '')).filter(Boolean);
  const lowered = names.map((name) => name.toLowerCase());

  const exact = lowered.indexOf(needle);
  if (exact !== -1) return names[exact];

  const suffixed = lowered
    .map((name, index) => ({ name, index }))
    .filter((entry) => entry.name.endsWith(`/${needle}`));
  if (suffixed.length === 1) return names[suffixed[0].index];

  const base = needle.split('/').pop() ?? needle;
  const byBase = lowered
    .map((name, index) => ({ name, index }))
    .filter((entry) => (entry.name.split('/').pop() ?? '') === base);
  if (byBase.length === 1) return names[byBase[0].index];

  return null;
}

/**
 * Maps a URL the preview served to the workspace file behind it:
 * `/assets/app.js` -> `assets/app.js`, `/` -> `index.html`, `/about/` ->
 * `about/index.html`, `/pricing` -> `pricing.html`. Only unambiguous hits.
 */
export function servedPathToWorkspaceFile(url: string | null | undefined, files: FileLike[]): string | null {
  if (!url || !Array.isArray(files) || files.length === 0) return null;
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    pathname = String(url).split('?')[0].split('#')[0];
  }

  const names = files.map((file) => normalizeSlashes(file?.name ?? '')).filter(Boolean);
  const lowered = names.map((name) => name.toLowerCase());
  const relative = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const lookup = (key: string) => {
    const index = lowered.indexOf(key.toLowerCase());
    return index === -1 ? null : names[index];
  };

  if (!relative) return lookup('index.html');
  return lookup(relative) ?? lookup(`${relative}/index.html`) ?? lookup(`${relative}.html`);
}

/**
 * The `data-source` markers `inlineWorkspaceHtml` puts on inlined workspace CSS
 * and JS. They say exactly which file a previewed page pulled its styles or
 * behaviour from, which is honest evidence for "attach this file to the chat".
 */
export function inlinedSourceFiles(html: string): string[] {
  if (typeof html !== 'string' || !html) return [];
  const found: string[] = [];
  const pattern = /data-source=(["'])([^"']+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const name = normalizeSlashes(match[2]).replace(/^\/+/, '');
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export interface PreviewSourceInput {
  stack?: string;
  pageUrl?: string | null;
  revealPath?: string | null;
  html?: string;
  files: FileLike[];
}

/** Files this preview run can legitimately be traced back to, most specific first. */
export function collectPreviewSources(input: PreviewSourceInput): string[] {
  const out: string[] = [];
  const add = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const matched = matchWorkspaceFile(candidate, input.files) ?? normalizeSlashes(candidate);
    if (matched && !out.includes(matched)) out.push(matched);
  };

  add(sourceFromStack(input.stack)?.path);
  if (input.revealPath) add(input.revealPath);
  add(servedPathToWorkspaceFile(input.pageUrl, input.files));
  for (const name of inlinedSourceFiles(input.html ?? '')) add(name);
  return out;
}
