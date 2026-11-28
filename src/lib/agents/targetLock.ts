/**
 * Tri-Layer Target Lock (Part I, upgraded).
 *
 * A "target" is the exact place a change must land: a file, a line, a symbol.
 * Three independent layers each propose candidates, and this module LOCKS the
 * best one with an explicit confidence in [0,1] and a content-hash staleness
 * check:
 *
 *   1. dom    — a preview element mapped back to the source that rendered it
 *               (a `data-shadrox-file`/line hint the host attaches);
 *   2. symbol — the compiler language service resolving a symbol to file:line
 *               (see ./codeIntel.ts, which owns the actual LSP calls);
 *   3. style  — a class/selector heuristic that points at the file most likely
 *               to own a style, used only as a weak tie-breaker.
 *
 * This file does NOT call the language service or read the DOM — the host feeds
 * it the per-layer hints plus the current content hash of each candidate file,
 * and it returns the ranked lock. That keeps the scoring pure and testable and
 * avoids a second resolver: codeIntel stays the only thing that talks to the LSP.
 *
 * Staleness: a hint carries the content hash it was derived from. If the file's
 * CURRENT hash differs, the hint is stale (the code moved under it) and is
 * demoted below the lock threshold rather than trusted.
 */

export type TargetLayer = 'dom' | 'symbol' | 'style';

export interface TargetHint {
  layer: TargetLayer;
  /** Workspace-relative path. */
  path: string;
  /** 1-based line, when the layer could pin one. */
  line?: number;
  /** 0-based column, when known. */
  column?: number;
  symbol?: string;
  /** Style layer only: the selector/class the hint came from. */
  selector?: string;
  /** Hash of the source content this hint was derived from. */
  contentHash?: string;
}

export interface TargetLockCandidate extends TargetHint {
  /** 0..1 — how much to trust this candidate. */
  confidence: number;
  /** True when the file's current hash no longer matches the hint's hash. */
  stale: boolean;
  /** Every layer that independently pointed at this same path. */
  agreedBy: TargetLayer[];
}

export interface TargetLockResult {
  /** The winning candidate, or null when nothing clears the threshold. */
  best: TargetLockCandidate | null;
  /** All candidates, strongest first. */
  candidates: TargetLockCandidate[];
  /** The subset demoted for staleness. */
  stale: TargetLockCandidate[];
}

/** How much a single layer's hint is trusted on its own, before agreement. */
const BASE_CONFIDENCE: Record<TargetLayer, number> = {
  dom: 0.95,
  symbol: 0.9,
  style: 0.55
};

/** A hint that could not pin a line or symbol is weaker than one that did. */
const VAGUE_PENALTY = 0.15;
/** Each additional layer that agrees on the same path adds this much. */
const AGREEMENT_BONUS = 0.05;
/** A stale candidate is capped here — below any sane lock threshold. */
const STALE_CAP = 0.3;
export const DEFAULT_LOCK_THRESHOLD = 0.5;

/** FNV-1a, 32-bit, hex. Deterministic and dependency-free content identity. */
export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizePath(path: string): string {
  // Lowercase to match normalizeContextPath (contextDedup) and canonicalPathKey:
  // the rest of the pipeline treats paths case-insensitively, so the staleness
  // hash lookup must too — otherwise a case difference silently fails open and a
  // moved file is never demoted.
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

function baseConfidence(hint: TargetHint): number {
  let confidence = BASE_CONFIDENCE[hint.layer];
  const pinned = (hint.line !== undefined && hint.line >= 1) || Boolean(hint.symbol);
  if (!pinned) confidence -= VAGUE_PENALTY;
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Natural UI section words a vibe-coding prompt uses without naming a file. A
 * component whose filename contains one of these is the likely target, so the
 * lock can fire on round 1 instead of the model spending a search round.
 */
const VIBE_WORDS = [
  'hero', 'navbar', 'nav', 'header', 'footer', 'sidebar', 'pricing', 'banner',
  'cta', 'card', 'grid', 'gallery', 'testimonial', 'faq', 'contact', 'about',
  'features', 'signup', 'login', 'waitlist', 'modal', 'toast', 'dropdown', 'menu',
  'dashboard', 'settings', 'profile', 'auth', 'checkout', 'billing', 'table', 'chart'
] as const;

const COMPONENT_EXT = /\.(?:tsx|jsx|ts|js|vue|svelte|html)$/i;

export interface VibeMatch {
  path: string;
  /** Distinct vibe words the query and this filename share. */
  words: string[];
  score: number;
}

/**
 * Match vibe words in the query against component filenames. Pure: the caller
 * passes the workspace file list. Each match scores by how many distinct vibe
 * words it shares with the query (a `HeroSection.tsx` hit on "hero" + "section"
 * beats a lone `Card.tsx`).
 */
export function matchVibeComponents(query: string, files: readonly string[]): VibeMatch[] {
  const words = new Set(
    (query.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => (VIBE_WORDS as readonly string[]).includes(word))
  );
  if (words.size === 0) return [];
  const matches: VibeMatch[] = [];
  for (const file of files) {
    if (!COMPONENT_EXT.test(file)) continue;
    const base = file.split('/').pop()!.replace(COMPONENT_EXT, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = [...words].filter((word) => base.includes(word));
    if (hit.length > 0) matches.push({ path: file, words: hit, score: hit.length });
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return matches;
}

/**
 * The single best vibe target, or null when the top score is a tie across
 * distinct files (ambiguity — the caller must NOT emit a blind lock and should
 * let search_text disambiguate).
 */
export function bestVibeTarget(query: string, files: readonly string[]): VibeMatch | null {
  const matches = matchVibeComponents(query, files);
  if (matches.length === 0) return null;
  const top = matches[0];
  const tied = matches.filter((match) => match.score === top.score);
  return tied.length === 1 ? top : null;
}

/**
 * Combine per-layer hints into a ranked, confidence-scored, staleness-checked
 * lock. Candidates that point at the same path are merged so agreement across
 * layers raises confidence; a candidate whose file hash moved is marked stale
 * and demoted. `best` is the strongest non-stale candidate at or above the
 * threshold, or null.
 */
export function resolveTargetLock(input: {
  hints: readonly TargetHint[];
  currentHashes?: Readonly<Record<string, string>>;
  threshold?: number;
}): TargetLockResult {
  const threshold = input.threshold ?? DEFAULT_LOCK_THRESHOLD;
  const currentHashes = input.currentHashes ?? {};
  const byPath = new Map<string, TargetLockCandidate>();

  for (const hint of input.hints) {
    if (!hint.path) continue;
    const key = normalizePath(hint.path);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, {
        ...hint,
        path: hint.path,
        confidence: baseConfidence(hint),
        stale: false,
        agreedBy: [hint.layer]
      });
      continue;
    }
    // Same path from another layer: keep the strongest hint's fields, record
    // the agreement, and add the bonus once per distinct layer.
    if (!existing.agreedBy.includes(hint.layer)) {
      existing.agreedBy.push(hint.layer);
      existing.confidence = Math.min(1, existing.confidence + AGREEMENT_BONUS);
    }
    if (existing.confidence < baseConfidence(hint)) {
      existing.confidence = baseConfidence(hint);
      if (hint.line !== undefined) existing.line = hint.line;
      if (hint.column !== undefined) existing.column = hint.column;
      if (hint.symbol) existing.symbol = hint.symbol;
    }
  }

  const candidates = [...byPath.values()];
  const stale: TargetLockCandidate[] = [];
  for (const candidate of candidates) {
    // currentHashes may be keyed by the raw path or a normalized one; try both.
    const current = currentHashes[normalizePath(candidate.path)] ?? currentHashes[candidate.path];
    if (candidate.contentHash && current && candidate.contentHash !== current) {
      candidate.stale = true;
      candidate.confidence = Math.min(candidate.confidence, STALE_CAP);
      stale.push(candidate);
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
  const best = candidates.find((candidate) => !candidate.stale && candidate.confidence >= threshold) ?? null;
  return { best, candidates, stale };
}