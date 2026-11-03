/**
 * Project-wide search and replace.
 *
 * The editor's find box only ever looked at the open buffer, so a rename across
 * a folder meant opening files one by one. This searches every buffer at once
 * and returns the exact ranges, which is what the preview list and the
 * "replace all" plan are both built from.
 */

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Treat the query as a regular expression (group references work in the replacement). */
  regex?: boolean;
}

export interface FileSearchMatch {
  /** 0-based line within the file. */
  line: number;
  character: number;
  endCharacter: number;
  /** The whole line, for the preview row. */
  text: string;
  /** The matched text itself. */
  match: string;
}

export interface FileSearchResult {
  file: string;
  matches: FileSearchMatch[];
}

export type SearchOutcome = { results: FileSearchResult[]; truncated: boolean } | { error: string };

export interface ReplacePlan {
  file: string;
  original: string;
  content: string;
  replacements: number;
}

export type ReplaceOutcome = { plans: ReplacePlan[]; truncated: boolean } | { error: string };

export interface SearchableFile {
  name: string;
  content: string;
}

const MAX_MATCHES = 2_000;

/** Open buffers are authoritative over the corresponding on-disk contents. */
export function mergeSearchableFiles(openFiles: SearchableFile[], diskFiles: SearchableFile[]): SearchableFile[] {
  const merged = new Map<string, SearchableFile>();
  for (const file of diskFiles) {
    merged.set(file.name.replace(/\\/g, '/').toLowerCase(), file);
  }
  for (const file of openFiles) {
    merged.set(file.name.replace(/\\/g, '/').toLowerCase(), file);
  }
  return [...merged.values()];
}

function buildPattern(query: string, options: SearchOptions): RegExp | { error: string } {
  if (!query) return { error: 'Enter something to search for.' };
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    const pattern = new RegExp(source, options.caseSensitive ? 'g' : 'gi');
    // A pattern that matches the empty string would insert the replacement
    // between every character, so it is refused before it can reach a file.
    if (pattern.test('')) return { error: 'That pattern can match an empty string.' };
    return pattern;
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That is not a valid regular expression.' };
  }
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; character: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - starts[low] };
}

function lineText(content: string, starts: number[], line: number): string {
  const from = starts[line];
  const newline = content.indexOf('\n', from);
  return content.slice(from, newline === -1 ? content.length : newline);
}

export function searchInFiles(files: SearchableFile[], query: string, options: SearchOptions = {}): SearchOutcome {
  const pattern = buildPattern(query, options);
  if (!(pattern instanceof RegExp)) return pattern;

  const results: FileSearchResult[] = [];
  let truncated = false;
  let total = 0;

  for (const file of files) {
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const starts = lineStarts(file.content);
    const matches: FileSearchMatch[] = [];
    // `matchAll` needs a fresh lastIndex per file; the pattern is rebuilt from
    // the source so a shared regex cannot carry state between files.
    const scanner = new RegExp(pattern.source, pattern.flags);
    for (const found of file.content.matchAll(scanner)) {
      const index = found.index ?? 0;
      const text = found[0];
      if (text.length === 0) break; // a zero-width match would loop forever
      const start = positionAt(starts, index);
      const end = positionAt(starts, index + text.length);
      matches.push({
        line: start.line,
        character: start.character,
        endCharacter: end.line === start.line ? end.character : lineText(file.content, starts, start.line).length,
        text: lineText(file.content, starts, start.line),
        match: text
      });
      total += 1;
      if (total >= MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (matches.length > 0) results.push({ file: file.name, matches });
  }

  return { results, truncated };
}

export function totalMatches(results: FileSearchResult[]): number {
  return results.reduce((sum, result) => sum + result.matches.length, 0);
}

/**
 * Build the new content of every file that would change. Nothing is written
 * here — the caller shows the plan and only then hands it to the workspace.
 */
export function planReplaceAll(
  files: SearchableFile[],
  query: string,
  replacement: string,
  options: SearchOptions = {}
): ReplaceOutcome {
  const pattern = buildPattern(query, options);
  if (!(pattern instanceof RegExp)) return pattern;

  const plans: ReplacePlan[] = [];
  let truncated = false;
  let total = 0;

  for (const file of files) {
    const count = [...file.content.matchAll(new RegExp(pattern.source, pattern.flags))].filter(
      (entry) => entry[0].length > 0
    ).length;
    if (count === 0) continue;
    if (total + count > MAX_MATCHES) {
      truncated = true;
      continue;
    }
    // A string replacement keeps `$1`-style group references working, which a
    // function replacement would drop.
    const content = file.content.replace(new RegExp(pattern.source, pattern.flags), replacement);
    if (content === file.content) continue;
    plans.push({ file: file.name, original: file.content, content, replacements: count });
    total += count;
  }

  return { plans, truncated };
}
