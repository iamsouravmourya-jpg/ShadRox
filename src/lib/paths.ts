/**
 * Canonical workspace path normalization & platform-aware deduplication.
 *
 * On Windows (`win32`), `src/rateLimiter.ts` and `src/ratelimiter.ts` refer to
 * the exact same file on disk. Without canonical matching, retries that vary in
 * filename casing create duplicate entries in `files`, `editorGroups.tabs`,
 * `touchedFiles`, and `summaryReport.filesModified` while overwriting one file.
 */

export function isCaseInsensitivePlatform(platform?: string): boolean {
  if (typeof platform === 'string' && platform.length > 0) {
    return platform.toLowerCase().startsWith('win');
  }
  const win = typeof globalThis !== 'undefined'
    ? (globalThis as { window?: { shadroxDesktop?: { platform?: string }; navigator?: { platform?: string } } }).window
    : undefined;
  const desktopPlatform = win?.shadroxDesktop?.platform;
  if (typeof desktopPlatform === 'string' && desktopPlatform.length > 0) {
    return desktopPlatform.toLowerCase().startsWith('win');
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform.toLowerCase().startsWith('win');
  }
  const navPlatform = win?.navigator?.platform;
  if (typeof navPlatform === 'string' && navPlatform.length > 0) {
    return navPlatform.toLowerCase().includes('win');
  }
  return false;
}

/** Normalize separators (`\`), leading `./` and `/`, and repeated slashes. */
export function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
}

/**
 * Canonical comparison key for a workspace path. Preserves original casing in
 * callers while allowing exact case-insensitive matching on Windows (`win32`)
 * or when `caseInsensitive` is explicitly enabled.
 */
export function canonicalPathKey(value: string, caseInsensitive = isCaseInsensitivePlatform()): string {
  const normalized = normalizeRepoPath(value);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Deduplicate tracked file paths while preserving the original canonical casing
 * from the first occurrence (or disk tree).
 */
export function dedupePaths(
  paths: readonly string[],
  caseInsensitive = isCaseInsensitivePlatform()
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const normalized = normalizeRepoPath(raw);
    if (!normalized) continue;
    const key = caseInsensitive ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Merge newly touched/read paths into an existing list without creating case
 * duplicates and while preserving original disk casing.
 */
export function mergeTrackedPaths(
  existing: readonly string[],
  incoming: readonly string[],
  caseInsensitive = isCaseInsensitivePlatform()
): string[] {
  return dedupePaths([...existing, ...incoming], caseInsensitive);
}

/** Find an entry's canonical spelling among known workspace paths (e.g. disk tree). */
export function resolveCanonicalPath(
  target: string,
  knownPaths: readonly string[],
  caseInsensitive = isCaseInsensitivePlatform()
): string {
  const normalized = normalizeRepoPath(target);
  if (!normalized) return '';
  const targetKey = caseInsensitive ? normalized.toLowerCase() : normalized;
  for (const candidate of knownPaths) {
    const cleanCandidate = normalizeRepoPath(candidate);
    if (!cleanCandidate) continue;
    const candidateKey = caseInsensitive ? cleanCandidate.toLowerCase() : cleanCandidate;
    if (candidateKey === targetKey) return cleanCandidate;
  }
  return normalized;
}

export function findPathIndex(
  entries: readonly string[],
  target: string,
  caseInsensitive = isCaseInsensitivePlatform()
): number {
  const key = canonicalPathKey(target, caseInsensitive);
  if (!key) return -1;
  return entries.findIndex((entry) => canonicalPathKey(entry, caseInsensitive) === key);
}

export function hasTrackedPath(
  entries: readonly string[],
  target: string,
  caseInsensitive = isCaseInsensitivePlatform()
): boolean {
  return findPathIndex(entries, target, caseInsensitive) >= 0;
}

export function pathsEqual(
  left: string,
  right: string,
  caseInsensitive = isCaseInsensitivePlatform()
): boolean {
  return canonicalPathKey(left, caseInsensitive) === canonicalPathKey(right, caseInsensitive);
}
