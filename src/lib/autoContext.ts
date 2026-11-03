import { selectContextCandidates } from './contextCandidates';
import type { WorkspaceFileEntry } from './types';

export interface ShortlistOptions {
  /** How many times wider than the read budget the shortlist is drawn. */
  widen: number;
  maxFiles: number;
  maxBytesPerFile: number;
  loadedPaths?: Iterable<string>;
}

/**
 * A deliberately wider list than the files we can actually afford to read, so
 * a cheap model can prune it before the expensive model pays for the contents.
 */
export function buildPathShortlist(
  tree: readonly WorkspaceFileEntry[],
  query: string,
  options: ShortlistOptions
): string[] {
  return selectContextCandidates(tree, query, {
    maxFiles: Math.max(1, options.maxFiles) * Math.max(1, options.widen),
    maxBytesPerFile: options.maxBytesPerFile,
    loadedPaths: options.loadedPaths
  });
}

/**
 * The ask handed to the cheap reader model. It chooses paths and never quotes
 * file contents, because a paraphrased file cannot be patched: SEARCH/REPLACE
 * needs bytes copied verbatim, so the contents always come from disk.
 */
export function buildSelectionInstruction(paths: readonly string[], query: string, maxPick: number): string {
  return [
    'You are the context picker for a code editor. Choose which files the answer model should be given.',
    `Request: ${query}`,
    `Candidate paths (this is the ONLY list of real files you may choose from):\n${paths.join('\n')}`,
    `Rules:`,
    `- Output at most ${maxPick} paths, best first.`,
    '- Copy each path exactly as it appears above. Never invent, rename, shorten or guess a path.',
    '- Output only the paths, one per line. No explanations, no code fences, no line numbers.',
    '- Pick the files that must be READ to answer, not files that merely sound related.',
    '- If a component is asked about, include the file it is defined in and the file that renders it.'
  ].join('\n');
}

function normalise(line: string): string {
  return line
    .trim()
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/**
 * The model's answer reduced to paths that genuinely exist.
 *
 * Anything not on the candidate list is dropped rather than repaired: a small
 * model asked for a path it already has will sometimes answer with a plausible
 * one, and reading a wrong file is worse than reading one fewer file.
 */
export function parseSelectedPaths(answer: string, allowed: readonly string[], maxPick: number): string[] {
  const byExactPath = new Map(allowed.map((path) => [path.toLowerCase(), path]));
  const byBasename = new Map<string, string[]>();
  for (const path of allowed) {
    const name = path.split('/').pop() ?? path;
    const bucket = byBasename.get(name.toLowerCase()) ?? [];
    bucket.push(path);
    byBasename.set(name.toLowerCase(), bucket);
  }

  const picked: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of answer.split('\n')) {
    if (picked.length >= maxPick) break;
    const line = normalise(rawLine);
    if (!line || /\s/.test(line)) continue;

    const exact = byExactPath.get(line.toLowerCase());
    const uniqueBasename = byBasename.get(line.toLowerCase());
    const match = exact ?? (uniqueBasename && uniqueBasename.length === 1 ? uniqueBasename[0] : undefined);
    if (!match || seen.has(match)) continue;

    seen.add(match);
    picked.push(match);
  }

  return picked;
}

/**
 * The shortlist trimmed to what the picker chose, keeping the picker's order but
 * never adding a file the shortlist did not offer.
 */
export function applySelection(shortlist: readonly string[], chosen: readonly string[]): string[] {
  const offered = new Set(shortlist);
  const ordered = chosen.filter((path) => offered.has(path));
  return ordered.length > 0 ? ordered : [];
}
