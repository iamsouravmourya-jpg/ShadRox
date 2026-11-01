import type { DesktopDiagnostic } from './desktop';

export interface TypeFixFile {
  name: string;
  content: string;
}

export interface TypeFixPrompt {
  system: string;
  user: string;
  diagnostics: DesktopDiagnostic[];
}

const FIXABLE_CODES = new Set<string>([
  'TS2304',
  'TS2307',
  'TS2322',
  'TS2339',
  'TS2345',
  'TS2551',
  'TS2554',
  'TS2769',
  'TS7006',
  'TS7031',
  'TS18048',
  'TS2531',
  'TS2532',
  'TS2741',
  'TS2739',
  'TS2353',
]);

const MAX_FILE_CHARS = 6000;
const TRUNCATION_MARKER = '\n… truncated';

function diagnosticKey(d: DesktopDiagnostic): string {
  return `${d.file}|${d.code}|${d.message}`;
}

/**
 * Keeps only error diagnostics in changed files that were not present before.
 * Line/character positions shift with edits, so they are excluded from the key.
 */
export function filterIntroducedDiagnostics(
  before: DesktopDiagnostic[],
  after: DesktopDiagnostic[],
  changedFiles: string[],
): DesktopDiagnostic[] {
  const changed = new Set(changedFiles);
  const seenBefore = new Set(before.map(diagnosticKey));
  const seenAfter = new Set<string>();
  const result: DesktopDiagnostic[] = [];

  for (const d of after) {
    if (d.severity !== 'error') continue;
    if (!changed.has(d.file)) continue;
    const key = diagnosticKey(d);
    if (seenBefore.has(key)) continue;
    if (seenAfter.has(key)) continue;
    seenAfter.add(key);
    result.push(d);
  }

  return result;
}

export function selectFixableDiagnostics(
  diagnostics: DesktopDiagnostic[],
  limit = 8,
): DesktopDiagnostic[] {
  const seen = new Set<string>();
  const result: DesktopDiagnostic[] = [];

  for (const d of diagnostics) {
    if (!FIXABLE_CODES.has(d.code)) continue;
    const key = diagnosticKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(d);
    if (result.length >= limit) break;
  }

  return result;
}

function clipContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return content.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER;
}

const SYSTEM_PROMPT = [
  'You are fixing TypeScript errors introduced by a previous edit.',
  'Reply with SEARCH/REPLACE blocks only; the app parses them directly.',
  'Each block must include a `path` that names one of the files included below.',
  'Fix only the listed diagnostics with minimal changes.',
  'Do not refactor, do not add dependencies, and do not write prose.',
].join('\n');

export function buildTypeFixPrompt(input: {
  files: TypeFixFile[];
  diagnostics: DesktopDiagnostic[];
  maxFiles?: number;
  maxChars?: number;
}): TypeFixPrompt | null {
  const { files, diagnostics } = input;
  const maxFiles = input.maxFiles ?? 3;
  const maxChars = input.maxChars ?? 24000;

  if (diagnostics.length === 0 || files.length === 0) return null;

  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    counts.set(d.file, (counts.get(d.file) ?? 0) + 1);
  }

  const ordered = [...files].sort((a, b) => {
    const diff = (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  const relevant = ordered.filter((f) => counts.has(f.name));
  const chosen = relevant.slice(0, Math.max(0, maxFiles));
  if (chosen.length === 0) return null;

  const includedNames = chosen.map((f) => f.name);
  const relevantDiagnostics = diagnostics.filter((d) => includedNames.includes(d.file));

  const header = '# Diagnostics';
  const diagnosticLines = relevantDiagnostics.map(
    (d) => `- ${d.file}:${d.line}:${d.character} ${d.code} ${d.message}`,
  );

  const renderFile = (file: TypeFixFile) =>
    `### ${file.name}\n\`\`\`\n${clipContent(file.content)}\n\`\`\``;

  // Drop lowest-priority files (highest index) until the prompt fits.
  let kept = chosen;
  let user = '';
  for (let count = chosen.length; count > 0; count -= 1) {
    const subset = chosen.slice(0, count);
    const names = new Set(subset.map((f) => f.name));
    const subsetDiagnostics = diagnostics.filter((d) => names.has(d.file));
    const body = [
      header,
      ...subsetDiagnostics.map(
        (d) => `- ${d.file}:${d.line}:${d.character} ${d.code} ${d.message}`,
      ),
      '',
      '# Files',
      ...subset.map(renderFile),
    ].join('\n');
    kept = subset;
    user = body;
    if (body.length <= maxChars) break;
  }

  if (user.length === 0) {
    user = [header, ...diagnosticLines, '', '# Files', ...kept.map(renderFile)].join('\n');
  }

  const keptNames = new Set(kept.map((f) => f.name));
  return {
    system: SYSTEM_PROMPT,
    user,
    diagnostics: diagnostics.filter((d) => keptNames.has(d.file)),
  };
}

export function summarizeTypeFix(
  beforeCount: number,
  remainingCount: number,
  attempt: number,
): { improved: boolean; remaining: number; message: string } {
  const improved = remainingCount < beforeCount;
  const fixed = Math.max(0, beforeCount - remainingCount);

  let message: string;
  if (attempt === 1 && improved) {
    message = `Fixed ${fixed} type error${fixed === 1 ? '' : 's'}`;
  } else if (!improved) {
    message = 'Type fix did not reduce the error count';
  } else {
    message = `Fixed ${fixed} type error${fixed === 1 ? '' : 's'}; ${remainingCount} remaining`;
  }

  return { improved, remaining: remainingCount, message };
}
