/**
 * Candidate selection for prompt context.
 *
 * A folder workspace loads no file contents at open — the explorer is lazy and
 * the editor only buffers tabs. That is correct for the UI and wrong for the
 * prompt: without this, a 219-file folder contributed nothing but file names
 * the user happened to have open. These helpers decide, from the on-disk path
 * list alone, which few files are worth reading for a given request.
 */

import type { WorkspaceFile, WorkspaceFileEntry } from './types';
import { buildFileTreeMap } from './retrieval';

export type { WorkspaceFileEntry };

const STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
  'your', 'you', 'are', 'was', 'will', 'please', 'make', 'add', 'fix', 'change'
]);

/** Bootstrap files describe the project before any query term is known. */
const BOOTSTRAP_BASENAMES = [
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'README.md',
  'index.html',
  'main.tsx',
  'main.ts',
  'index.tsx',
  'index.ts',
  'app.tsx',
  'app.ts',
  'server.ts',
  'server.js'
];

/** Shorthand queries that mean "this whole project", not one file. */
const PROJECT_TERMS = ['project', 'architecture', 'overview', 'structure', 'repo', 'codebase', 'explain'];

/** Reads would throw on these, so do not spend a context slot on them. */
const UNREADABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.svg',
  '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.lock'
]);

function isReadable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot < 0 || !UNREADABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9_.$-]{2,}/g)) {
    const term = match[0];
    if (!STOP_TERMS.has(term)) seen.add(term);
  }
  return Array.from(seen);
}

function score(path: string, terms: string[]): number {
  const lower = path.toLowerCase();
  const base = basename(path);
  let score = 0;
  for (const term of terms) {
    if (base.includes(term)) score += 4;
    else if (lower.includes(term)) score += 2;
  }
  // A shorter path is closer to the project root, so a hit there is more
  // likely to be the real entry point than a hit in a deep leaf directory.
  if (score > 0) score += Math.max(0, 4 - path.split('/').length);
  return score;
}

export interface CandidateOptions {
  maxFiles: number;
  maxBytesPerFile: number;
  /** Files the user already has open; they are in context and need no re-read. */
  loadedPaths?: Iterable<string>;
}

/**
 * Picks the files worth reading for this request: bootstrap files first (they
 * explain the project), then whatever the query names. Pure — no I/O — so the
 * ranking is testable and the caller decides what reading costs.
 */
export function selectContextCandidates(
  tree: readonly WorkspaceFileEntry[],
  query: string,
  options: CandidateOptions
): string[] {
  const terms = queryTerms(query);
  const loaded = new Set(Array.from(options.loadedPaths ?? [], (path) => path.toLowerCase()));
  const readable = tree.filter(
    (entry) =>
      entry.size > 0 &&
      entry.size <= options.maxBytesPerFile &&
      isReadable(entry.path) &&
      !loaded.has(entry.path.toLowerCase())
  );
  if (readable.length === 0) return [];

  const chosen: string[] = [];
  const taken = new Set<string>();

  // A query about the whole project earns the root manifest; a query about one
  // component should not spend half the budget on package.json.
  if (terms.some((term) => PROJECT_TERMS.includes(term)) || terms.length === 0) {
    for (const name of BOOTSTRAP_BASENAMES) {
      // The shallowest match wins: a project's own manifest is at the root, and
      // a build copy deeper in the tree must not outrank it.
      let best: WorkspaceFileEntry | undefined;
      for (const entry of readable) {
        if (basename(entry.path) !== name || taken.has(entry.path)) continue;
        if (!best || entry.path.split('/').length < best.path.split('/').length) best = entry;
      }
      if (!best) continue;
      chosen.push(best.path);
      taken.add(best.path);
      if (chosen.length >= options.maxFiles) return chosen;
    }
  }

  const ranked = readable
    .map((entry) => ({ path: entry.path, value: score(entry.path, terms) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.path.length - b.path.length);

  for (const entry of ranked) {
    if (taken.has(entry.path)) continue;
    chosen.push(entry.path);
    taken.add(entry.path);
    if (chosen.length >= options.maxFiles) break;
  }

  // Nothing matched — a vague query, or a project whose names say nothing. Still
  // read the files nearest the root: they are the ones that describe a project,
  // and an empty context is the one outcome that must not happen by construction.
  if (chosen.length === 0) {
    const shallowest = readable
      .slice()
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    for (const entry of shallowest) {
      if (taken.has(entry.path)) continue;
      chosen.push(entry.path);
      taken.add(entry.path);
      if (chosen.length >= options.maxFiles) break;
    }
  }

  return chosen;
}

/** The on-disk listing plus any file the editor knows about that it missed. */
export function mergeInventory(
  tree: readonly WorkspaceFileEntry[],
  buffers: ReadonlyArray<{ name: string; content: string }>
): WorkspaceFileEntry[] {
  const listed = new Set(tree.map((entry) => entry.path.toLowerCase()));
  return [
    ...tree,
    ...buffers
      .filter((file) => !listed.has(file.name.toLowerCase()))
      // The listing is a snapshot taken when the folder was opened, so a file
      // created during this session (by a previous AI turn, say) is only known
      // from its buffer. Content length stands in for the byte size.
      .map((file) => ({ path: file.name, size: file.content.length }))
  ];
}

/**
 * The workspace's own lines in the system instruction.
 *
 * Two functions used to sit behind one `files.length > 0` test, so a folder
 * with no open tabs contributed nothing at all — the model then reported that
 * it had received no repo map and no file names, which was true. These lines
 * are built from the path listing, so they exist whenever a folder does.
 */
export function describeWorkspaceForPrompt(options: {
  name: string;
  path: string;
  inventory: readonly WorkspaceFileEntry[];
  /** How many files this request carries contents for. */
  contentsIncluded: number;
}): string[] {
  const lines = [
    `Workspace: ${options.name} at ${options.path} — ${options.inventory.length} file(s), ` +
    `contents included for ${Math.min(options.contentsIncluded, options.inventory.length || options.contentsIncluded)} of them ` +
    '(the open editor tabs plus the files most relevant to this request).'
  ];
  const map = options.inventory.length > 0 ? buildFileTreeMap(options.inventory) : '';
  if (map) lines.push(`REPO MAP (paths in this workspace):\n${map}`);
  return lines;
}

export interface ContextReadFailure {
  path: string;
  reason: string;
}
/**
 * Reads candidates through the desktop bridge, tolerating per-file failures:
 * binary/generated files throw from `readFile`, and one unreadable file must
 * not cost the request the rest of the context.
 */
export async function readContextFiles<T>(
  paths: readonly string[],
  readFile: (path: string) => Promise<T>,
  onError?: (failure: ContextReadFailure) => void
): Promise<T[]> {
  const files: T[] = [];
  await Promise.all(
    paths.map(async (path) => {
      try {
        files.push(await readFile(path));
      } catch (error) {
        onError?.({ path, reason: error instanceof Error ? error.message : 'Unknown error' });
      }
    })
  );
  return files;
}
