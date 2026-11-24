import { normalizeSlashes } from './diagnostics';
import type { WorkspaceFile } from './types';

export function normalizeContextPath(filePath: string): string {
  return normalizeSlashes(filePath).replace(/^\.\//, '').toLowerCase();
}

/**
 * Groups multi-line stack traces with their header error line, deduplicates
 * identical diagnostic entries while preserving first-seen order and counting
 * repeats `(xN)`, and caps output to `maxUnique` entries.
 */
export function dedupeAndCapDiagnostics(raw: string, maxUnique = 5): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const rawLines = trimmed.split(/\r?\n/);
  const entries: string[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const isContinuation = /^\s+(?:at\s|\.\.\.|Caused by:|Traceback|\^|~)/.test(line) && entries.length > 0;
    if (isContinuation) {
      entries[entries.length - 1] = `${entries[entries.length - 1]}\n${line}`;
    } else {
      entries.push(line.trim());
    }
  }

  const uniqueOrder: string[] = [];
  const counts = new Map<string, number>();
  const keyToEntry = new Map<string, string>();

  for (const entry of entries) {
    const normKey = entry
      .replace(/\s+/g, ' ')
      .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
      .trim();
    const prev = counts.get(normKey);
    if (prev === undefined) {
      counts.set(normKey, 1);
      keyToEntry.set(normKey, entry);
      uniqueOrder.push(normKey);
    } else {
      counts.set(normKey, prev + 1);
    }
  }

  const cap = Math.max(1, maxUnique);
  const shown = uniqueOrder.slice(0, cap).map((key) => {
    const entry = keyToEntry.get(key) ?? '';
    const count = counts.get(key) ?? 1;
    if (count <= 1) return entry;
    const newlineIdx = entry.indexOf('\n');
    if (newlineIdx < 0) return `${entry} (x${count})`;
    return `${entry.slice(0, newlineIdx)} (x${count})${entry.slice(newlineIdx)}`;
  });

  const omitted = uniqueOrder.length - shown.length;
  if (omitted > 0) {
    shown.push(`… (+${omitted} more unique runtime/diagnostic error${omitted === 1 ? '' : 's'} omitted)`);
  }
  return shown.join('\n');
}

/**
 * Deduplicates workspace files by normalized relative path, preserving the
 * earlier (higher-priority buffered) copy when duplicates exist.
 */
export function dedupeWorkspaceFiles(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  const seen = new Set<string>();
  const out: WorkspaceFile[] = [];
  for (const file of files) {
    const key = normalizeContextPath(file.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * Excludes files whose full contents were already injected into `files`
 * (active/attached excerpts below maxChars) so BM25 retrieval does not send
 * identical content twice in the same prompt.
 */
export function filterFilesForRetrieval(
  files: readonly WorkspaceFile[],
  alreadyIncludedInFull: ReadonlySet<string>
): WorkspaceFile[] {
  if (alreadyIncludedInFull.size === 0) return [...files];
  return files.filter((file) => !alreadyIncludedInFull.has(normalizeContextPath(file.name)));
}
