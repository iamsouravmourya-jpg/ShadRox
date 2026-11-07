/**
 * The context manifest (S05).
 *
 * The composer's context surface has to describe the request that will actually
 * be sent: which sources made it in, why, which line ranges, how fresh they are,
 * how many tokens they cost, and — just as important — which explicit targets
 * did not resolve. Today the preview is pre-fit and the counter is prompt-only,
 * so the manifest and the payload can disagree.
 *
 * This module is the pure half: it turns a flat list of context contributions
 * into one deduplicated manifest. Overlapping active, pinned, attached and
 * retrieved ranges for the same source collapse to a single union of ranges, so
 * one file is never billed twice. Nothing here reads the disk or calls a model;
 * the caller resolves bytes and hands them in with a freshness and version.
 */

export type ContextSourceKind =
  | 'target'
  | 'pin'
  | 'attachment'
  | 'active'
  | 'retrieved'
  | 'rule'
  | 'map';

export type ContextFreshness = 'fresh' | 'stale' | 'unknown';

/** A half-open line range: `start` is included, `end` is excluded. */
export interface SourceRange {
  start: number;
  end: number;
}

export interface ContextSource {
  path: string;
  kind: ContextSourceKind;
  /** Why this source is in the request, in the user's words. */
  reason: string;
  /** Lines actually carried; empty when only the path is listed. */
  ranges: readonly SourceRange[];
  /** True when the whole file is carried, not a set of ranges. */
  fullFile: boolean;
  freshness: ContextFreshness;
  /** Content identity or version, when the caller knows it. */
  version?: string;
  estimatedTokens: number;
  truncated?: boolean;
}

export interface ContextManifest {
  sources: ContextSource[];
  /** Explicit targets that resolved to no bytes — surface them, never hide them. */
  missing: string[];
  /** How many contributions were folded into another source rather than counted. */
  deduped: number;
}

/**
 * The deduplication order: when two sources cover the same path, the stronger
 * kind keeps the reason. An explicit target outranks a pin, which outranks an
 * attachment, and so on down to the repo map, which is only navigation.
 */
const KIND_RANK: Record<ContextSourceKind, number> = {
  target: 6,
  pin: 5,
  attachment: 4,
  active: 3,
  retrieved: 2,
  rule: 1,
  map: 0
};

/** Freshness is merged pessimistically: one stale contributor is enough. */
const FRESHNESS_RANK: Record<ContextFreshness, number> = { fresh: 0, unknown: 1, stale: 2 };

/** './a/b', 'a\\b' and 'A/B' all describe the same source identity. */
export function normalizeContextPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/** Merge overlapping and touching ranges into the smallest covering set. */
export function unionRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({ start: Math.max(0, Math.floor(range.start)), end: Math.max(0, Math.ceil(range.end)) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function coveredLines(ranges: readonly SourceRange[]): number {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
}

/**
 * Collapse contributions that share a source identity into one entry. The
 * surviving entry keeps the strongest kind/reason, the union of ranges, the
 * most conservative freshness and the first known version; the token estimate
 * accounts for the overlap so a line brought in twice is billed once.
 */
export function mergeContextSources(sources: readonly ContextSource[]): {
  sources: ContextSource[];
  deduped: number;
} {
  const byPath = new Map<string, { merged: ContextSource; tokens: number; maxTokens: number; lines: number }>();
  let deduped = 0;

  for (const source of sources) {
    const key = normalizeContextPath(source.path);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, {
        merged: { ...source, ranges: unionRanges(source.ranges) },
        tokens: source.estimatedTokens,
        maxTokens: source.estimatedTokens,
        lines: coveredLines(source.ranges)
      });
      continue;
    }
    deduped += 1;
    const { merged } = existing;
    const winner =
      KIND_RANK[source.kind] > KIND_RANK[merged.kind]
        ? { kind: source.kind, reason: source.reason }
        : { kind: merged.kind, reason: merged.reason };
    const mergedRanges = unionRanges([...merged.ranges, ...source.ranges]);
    merged.kind = winner.kind;
    merged.reason = winner.reason;
    merged.ranges = mergedRanges;
    merged.fullFile = merged.fullFile || source.fullFile;
    merged.truncated = (merged.truncated ?? false) || (source.truncated ?? false);
    merged.freshness =
      FRESHNESS_RANK[source.freshness] > FRESHNESS_RANK[merged.freshness] ? source.freshness : merged.freshness;
    merged.version = merged.version ?? source.version;
    existing.tokens += source.estimatedTokens;
    existing.maxTokens = Math.max(existing.maxTokens, source.estimatedTokens);
    existing.lines += coveredLines(source.ranges);
  }

  const mergedSources = [...byPath.values()].map(({ merged, tokens, maxTokens, lines }) => {
    const unique = coveredLines(merged.ranges);
    const estimate =
      merged.fullFile || lines === 0 ? maxTokens : Math.max(0, Math.round((tokens * unique) / lines));
    return { ...merged, estimatedTokens: estimate };
  });

  return { sources: mergedSources, deduped };
}

/**
 * The final manifest. `resolvedPaths` is the set of paths the caller actually
 * obtained bytes for; any explicit target not among them (by path identity) is
 * reported as missing so the preview can never claim an unopened file was sent.
 * A target may be `path` or `path#symbol`; the symbol only affects the label.
 */
export function buildContextManifest(input: {
  sources: readonly ContextSource[];
  targets: readonly string[];
  resolvedPaths: readonly string[];
}): ContextManifest {
  const { sources, deduped } = mergeContextSources(input.sources);
  const present = new Set(input.resolvedPaths.map((path) => normalizeContextPath(path)));
  for (const source of sources) present.add(normalizeContextPath(source.path));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const target of input.targets) {
    const pathPart = target.split('#')[0];
    const key = normalizeContextPath(pathPart);
    if (!key || present.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(target);
  }
  return { sources, missing, deduped };
}

export interface ContextManifestTotals {
  files: number;
  tokens: number;
  truncated: number;
  missing: number;
  stale: number;
}

/** The numbers the column header shows; warning counts drive the collapse state. */
export function contextManifestTotals(manifest: ContextManifest): ContextManifestTotals {
  return {
    files: manifest.sources.length,
    tokens: manifest.sources.reduce((sum, source) => sum + source.estimatedTokens, 0),
    truncated: manifest.sources.filter((source) => source.truncated).length,
    missing: manifest.missing.length,
    stale: manifest.sources.filter((source) => source.freshness === 'stale').length
  };
}

function rangeLabel(source: ContextSource): string {
  if (source.fullFile) return 'whole file';
  if (source.ranges.length === 0) return 'path only';
  return source.ranges.map((range) => `${range.start + 1}-${range.end}`).join(', ');
}

/**
 * The docked preview text. Default view is totals plus one warning line; the
 * detailed view adds one line per source. It is deliberately the same data the
 * manifest holds — a preview that re-derives its own numbers is how the preview
 * and the payload drift apart.
 */
export function renderContextManifest(
  manifest: ContextManifest,
  options: { detailed?: boolean } = {}
): string {
  const totals = contextManifestTotals(manifest);
  if (totals.files === 0 && totals.missing === 0) return 'No workspace context will be sent with this request.';

  const head = `${totals.files} file(s) · ~${totals.tokens.toLocaleString('en-US')} tokens`;
  const warnings: string[] = [];
  if (totals.missing > 0) warnings.push(`missing: ${manifest.missing.join(', ')}`);
  if (totals.stale > 0) warnings.push(`${totals.stale} stale source(s)`);
  if (totals.truncated > 0) warnings.push(`${totals.truncated} truncated`);

  const lines = [head];
  if (warnings.length > 0) lines.push(warnings.join(' · '));
  if (options.detailed) {
    for (const source of manifest.sources) {
      lines.push(`• ${source.kind} ${source.path} (${rangeLabel(source)}, ${source.reason})`);
    }
  }
  return lines.join('\n');
}

/**
 * Whether an Enter keypress submits the composer. An in-progress IME
 * composition must never submit; Shift+Enter inserts a newline.
 */
export function shouldSubmitOnEnter(event: { key: string; shiftKey?: boolean; isComposing?: boolean }): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing) return false;
  if (event.shiftKey) return false;
  return true;
}
