/**
 * Deterministic requirement checklist extraction and end-of-run coverage audit.
 *
 * Mega-prompts often list 5-20 concrete requirements across numbered sections,
 * headings and bullet lists. Extracting those items deterministically gives the
 * planner an explicit ledger to cover and lets the run/team drivers detect
 * dropped requirements before declaring victory.
 */

import { canonicalPathKey, hasTrackedPath, isCaseInsensitivePlatform, normalizeRepoPath } from '../paths';

export type RequirementStatus = 'pending' | 'covered' | 'unverified';

export interface RequirementItem {
  id: string;
  title: string;
  text: string;
  explicitPaths: string[];
  keywords: string[];
  status: RequirementStatus;
  evidence?: string;
}

export interface AuditedUnitEvidence {
  id: string;
  title: string;
  instruction: string;
  status: string;
  expectedFiles: string[];
  touchedFiles?: string[];
  summary?: string;
}

const EXPLICIT_PATH_RE =
  /(?:^|[\s`'"(\[,])((?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,10}|[a-zA-Z0-9._-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|html|css|yml|yaml|toml))(?=$|[\s`'")\],:;?!])/g;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where',
  'what', 'which', 'will', 'must', 'should', 'could', 'would', 'make', 'sure',
  'ensure', 'all', 'any', 'each', 'every', 'only', 'also', 'than', 'then',
  'them', 'they', 'their', 'have', 'has', 'been', 'being', 'about', 'after',
  'before', 'across', 'using', 'used', 'uses', 'file', 'files', 'code', 'work',
  'new', 'existing', 'current', 'without', 'within', 'between', 'across'
]);

const READ_ONLY_AUDIT_RE = /\b(?:inspect|review|audit|read|check|analyze)\b/i;
const MUTATE_OR_CREATE_RE = /\b(?:create|add|scaffold|generate|write|modify|update|edit|fix|refactor|patch|change|rewrite|extend|repair|replace|rename|bump|upgrade|wire|implement|build|remove|delete|exclude)\b/i;

function isValidPathCandidate(raw: string): boolean {
  const clean = normalizeRepoPath(raw);
  if (!clean) return false;
  if (clean.startsWith('http://') || clean.startsWith('https://')) return false;
  if (clean.startsWith('/') || clean.startsWith('..')) return false;
  if (/^\d+\.\d+\.\d+/.test(clean)) return false;
  if (/^v?\d+\.\d+/i.test(clean) && !clean.includes('/')) return false;
  return true;
}

export function extractExplicitPathsFromText(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  EXPLICIT_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_PATH_RE.exec(text)) !== null) {
    const clean = normalizeRepoPath(match[1]);
    if (!isValidPathCandidate(clean)) continue;
    const key = canonicalPathKey(clean, true);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(clean);
  }
  return paths;
}

function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(tokens)].slice(0, 12);
}

function clipTitle(text: string, maxLen = 96): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Extracts structured requirement items from a user goal or mega-prompt.
 * Single-paragraph prompts cleanly return 1 item so lightweight runs do not
 * receive artificial catch-up overhead.
 */
export function extractRequirements(goal: string): RequirementItem[] {
  const trimmed = goal.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/);
  const blocks: Array<{ heading?: string; text: string }> = [];
  let currentHeading = '';
  let activeBullet: { heading?: string; text: string } | null = null;

  const flushBullet = () => {
    if (activeBullet) {
      blocks.push(activeBullet);
      activeBullet = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) {
      flushBullet();
      continue;
    }

    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      flushBullet();
      currentHeading = headingMatch[1].replace(/\*\*/g, '').trim();
      continue;
    }

    const numberedMatch = line.match(/^(?:\d+)[.)]\s+(.+)$/);
    const bulletMatch = line.match(/^[-*•]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    const matchedBody = numberedMatch?.[1] ?? bulletMatch?.[1];
    if (matchedBody) {
      const cleanBody = matchedBody.replace(/\*\*/g, '').trim();
      if (cleanBody.length < 8 && extractExplicitPathsFromText(cleanBody).length === 0) continue;
      // Treat bolded section-like numbered headers without files and ending in ":" as headings.
      if (numberedMatch && /:\s*$/.test(cleanBody) && extractExplicitPathsFromText(cleanBody).length === 0 && cleanBody.length < 80) {
        flushBullet();
        currentHeading = cleanBody.replace(/:$/, '').trim();
        continue;
      }
      flushBullet();
      activeBullet = {
        heading: currentHeading || undefined,
        text: cleanBody
      };
      continue;
    }

    if (activeBullet) {
      activeBullet.text = `${activeBullet.text} ${line.replace(/\*\*/g, '')}`.trim();
    }
  }
  flushBullet();

  // Also split inline semicolon/clause lists only if no structured blocks were extracted and there are explicit multiple targets.
  if (blocks.length <= 1) {
    return [
      {
        id: 'r1',
        title: clipTitle(trimmed),
        text: trimmed,
        explicitPaths: extractExplicitPathsFromText(trimmed),
        keywords: extractKeywords(trimmed),
        status: 'pending'
      }
    ];
  }

  const deduped: RequirementItem[] = [];
  const seenText = new Set<string>();
  for (const block of blocks) {
    const fullText = block.heading ? `${block.heading}: ${block.text}` : block.text;
    const key = fullText.toLowerCase();
    if (seenText.has(key)) continue;
    seenText.add(key);
    deduped.push({
      id: `r${deduped.length + 1}`,
      title: clipTitle(block.text),
      text: fullText,
      explicitPaths: extractExplicitPathsFromText(fullText),
      keywords: extractKeywords(fullText),
      status: 'pending'
    });
    if (deduped.length >= 24) break;
  }

  return deduped;
}

/**
 * Evaluates which requirement items have evidence of completion from passing or
 * unverified execution units and touched files.
 */
export function auditRequirementCoverage(
  items: readonly RequirementItem[],
  units: readonly AuditedUnitEvidence[],
  additionalTouchedFiles: readonly string[] = [],
  caseInsensitive: boolean = isCaseInsensitivePlatform()
): RequirementItem[] {
  if (items.length === 0) return [];

  const settledUnits = units.filter((unit) => unit.status === 'passed' || unit.status === 'unverified');
  const passedUnits = units.filter((unit) => unit.status === 'passed');
  const settledTouched = new Set<string>();
  const unverifiedOnlyTouched = new Set<string>();

  for (const file of additionalTouchedFiles) {
    const clean = normalizeRepoPath(file);
    if (clean) settledTouched.add(canonicalPathKey(clean, caseInsensitive));
  }
  for (const unit of settledUnits) {
    for (const file of unit.touchedFiles ?? []) {
      const clean = normalizeRepoPath(file);
      if (!clean) continue;
      const key = canonicalPathKey(clean, caseInsensitive);
      settledTouched.add(key);
      if (unit.status === 'unverified') unverifiedOnlyTouched.add(key);
    }
  }
  const allTouchedArray = [...settledTouched];

  return items.map((item) => {
    // Exclude purely audit/read-only path references if the requirement text does not ask to mutate them.
    const actionablePaths =
      READ_ONLY_AUDIT_RE.test(item.text) && !MUTATE_OR_CREATE_RE.test(item.text)
        ? []
        : item.explicitPaths;

    if (actionablePaths.length > 0) {
      const missingPaths: string[] = [];
      let hadUnverifiedTouch = false;
      for (const path of actionablePaths) {
        const key = canonicalPathKey(path, caseInsensitive);
        const touchedExact = settledTouched.has(key);
        const touchedTracked = hasTrackedPath(allTouchedArray, path, caseInsensitive);
        if (!touchedExact && !touchedTracked) {
          missingPaths.push(path);
        } else if (unverifiedOnlyTouched.has(key) && !passedUnits.some((u) => hasTrackedPath(u.touchedFiles ?? [], path, caseInsensitive))) {
          hadUnverifiedTouch = true;
        }
      }
      if (missingPaths.length === 0) {
        return {
          ...item,
          status: hadUnverifiedTouch ? 'unverified' : 'covered',
          evidence: `Touched: ${actionablePaths.join(', ')}`
        };
      }
      // If all non-readonly explicit paths weren't touched directly, check if any settled unit explicitly declared them AND passed verification.
      return {
        ...item,
        status: 'pending',
        evidence: `Missing untouched target(s): ${missingPaths.join(', ')}`
      };
    }

    // No explicit paths: match against settled unit title/instruction/summary using keyword overlap.
    let bestUnit: AuditedUnitEvidence | null = null;
    let bestHits = 0;
    const minHits = item.keywords.length <= 2 ? item.keywords.length : 2;

    for (const unit of settledUnits) {
      const unitTouchedCount = unit.touchedFiles?.length ?? 0;
      if (unitTouchedCount === 0 && MUTATE_OR_CREATE_RE.test(item.text)) continue;
      const corpus = `${unit.title} ${unit.instruction} ${unit.summary ?? ''}`.toLowerCase();
      let hits = 0;
      for (const kw of item.keywords) {
        if (corpus.includes(kw)) hits += 1;
      }
      if (hits > bestHits) {
        bestHits = hits;
        bestUnit = unit;
      }
    }

    if (bestUnit && bestHits >= Math.max(1, minHits)) {
      return {
        ...item,
        status: bestUnit.status === 'unverified' ? 'unverified' : 'covered',
        evidence: `Covered by ${bestUnit.id} (${bestUnit.title})`
      };
    }

    return {
      ...item,
      status: 'pending',
      evidence: 'No settled unit evidenced this requirement.'
    };
  });
}

/** Renders a concise checklist snippet for planner prompts when a goal has multiple items. */
export function formatRequirementChecklistForPrompt(items: readonly RequirementItem[]): string {
  if (items.length <= 1) return '';
  const lines = items.map((item) => {
    const files = item.explicitPaths.length > 0 ? ` [files: ${item.explicitPaths.join(', ')}]` : '';
    return `- [${item.id}] ${item.title}${files}`;
  });
  return ['REQUIREMENT CHECKLIST (every item MUST be mapped to at least one planned unit):', ...lines].join('\n');
}
