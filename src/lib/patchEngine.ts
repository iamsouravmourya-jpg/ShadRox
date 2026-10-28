import { resolveTarget, type FilePatch, type KnownFile } from './markdown';

/**
 * Multi-file unified patch engine.
 *
 * Ported from Void's Fast Apply (reference/void-main/.../common/helpers/
 * extractCodeFromResult.ts and browser/editCodeService.ts), stripped of every
 * VS Code dependency:
 *
 * - The model may emit SEARCH/REPLACE blocks instead of whole files:
 *
 *       <<<<<<< ORIGINAL
 *       // exact lines from the file
 *       =======
 *       // replacement lines
 *       >>>>>>> UPDATED
 *
 * - ORIGINAL must match the file exactly; a whitespace-stripped unique match
 *   is accepted as a fallback. Blocks must be disjoint.
 * - A block that matches more than one place is refused as `ambiguous` rather
 *   than silently applied to the first hit.
 * - Every patch carries its target path, so one reply can touch many files and
 *   the UI reviews/accepts them as a single set.
 */

export const SEARCH_ORIGINAL_MARKER = '<<<<<<< ORIGINAL';
export const SEARCH_DIVIDER_MARKER = '=======';
export const SEARCH_FINAL_MARKER = '>>>>>>> UPDATED';

export interface SearchReplaceBlock {
  original: string;
  updated: string;
}

export type UnifiedPatch =
  | { path: string; kind: 'rewrite'; content: string }
  | { path: string; kind: 'searchReplace'; blocks: SearchReplaceBlock[] };

export interface ApplyFailure {
  blockIndex: number;
  reason: 'not-found' | 'not-unique' | 'ambiguous' | 'overlap';
  /** How many places the ORIGINAL matched; only set for 'ambiguous'. */
  matches?: number;
}

export interface ApplySearchReplaceResult {
  content: string;
  failures: ApplyFailure[];
}

/** Parses S/R blocks out of raw text, tolerating an unfinished trailing block. */
export function parseSearchReplaceBlocks(text: string): SearchReplaceBlock[] {
  const lines = text.split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let state: 'idle' | 'original' | 'final' = 'idle';
  let original: string[] = [];
  let updated: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (state === 'idle') {
      if (trimmed === SEARCH_ORIGINAL_MARKER) {
        state = 'original';
        original = [];
        updated = [];
      }
      continue;
    }

    if (state === 'original') {
      if (trimmed === SEARCH_DIVIDER_MARKER) {
        state = 'final';
      } else if (trimmed === SEARCH_ORIGINAL_MARKER) {
        // A new block started before the previous one finished — drop the
        // malformed block and start over (streams sometimes do this).
        original = [];
      } else {
        original.push(line);
      }
      continue;
    }

    // state === 'final'
    if (trimmed === SEARCH_FINAL_MARKER) {
      blocks.push({ original: original.join('\n'), updated: updated.join('\n') });
      state = 'idle';
    } else {
      updated.push(line);
    }
  }

  return blocks;
}

export type BlockRange = { start: number; end: number };
export type BlockLookup = BlockRange | 'not-found' | 'not-unique' | 'ambiguous';

export type BlockMatch =
  | { status: 'found'; range: BlockRange; matches: number }
  | { status: 'not-found'; matches: 0 }
  /** Matched in more than one place: the engine cannot know which one was meant. */
  | { status: 'ambiguous'; matches: number; occurrences: BlockRange[] }
  /** Matched in more than one place only after whitespace normalisation. */
  | { status: 'not-unique'; matches: number };

/** Every start index of `needle` in `haystack` (non-overlapping). */
function allIndexes(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return found;
    found.push(index);
    from = index + needle.length;
  }
}

/**
 * Maps an index in whitespace-stripped text back to the original offset. */
function mapStrippedIndex(content: string, strippedIndex: number): number {
  let stripped = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== ' ' && content[index] !== '\t') {
      if (stripped === strippedIndex) return index;
      stripped += 1;
    }
  }
  return content.length;
}

/**
 * Locates a block's ORIGINAL inside a file and — this is the whole point —
 * reports *every* place it matches.
 *
 * The first version of this engine took the first match and stayed silent,
 * which for an auto-apply feature is a wrong-edit generator: `x(1);\nx(1);\n`
 * with SEARCH `x(1);` silently rewrote line 1. A block that fits more than one
 * location is refused as `ambiguous` so the model (or the user) has to add
 * surrounding context.
 *
 * Exact duplicates are counted directly, not inferred from the
 * whitespace-normalised fallback: the fallback is only reached when the block
 * does not match verbatim at all, and it still requires a unique match.
 */
export function locateBlock(content: string, original: string): BlockMatch {
  // An empty/whitespace-only ORIGINAL has no meaning as an anchor; refusing it
  // also stops a match-at-index-0 from rewriting the head of the file.
  if (!original.trim()) return { status: 'not-found', matches: 0 };

  const occurrences = allIndexes(content, original);
  if (occurrences.length > 1) {
    return {
      status: 'ambiguous',
      matches: occurrences.length,
      occurrences: occurrences.map((start) => ({ start, end: start + original.length }))
    };
  }
  if (occurrences.length === 1) {
    return {
      status: 'found',
      range: { start: occurrences[0], end: occurrences[0] + original.length },
      matches: 1
    };
  }

  const strip = (value: string) => value.replace(/[ \t]+/g, '');
  const strippedFile = strip(content);
  const strippedOriginal = strip(original);
  if (!strippedOriginal) return { status: 'not-found', matches: 0 };
  const first = strippedFile.indexOf(strippedOriginal);
  if (first === -1) return { status: 'not-found', matches: 0 };
  if (strippedFile.indexOf(strippedOriginal, first + strippedOriginal.length) !== -1) {
    return { status: 'not-unique', matches: 2 };
  }
  // Snap to whole lines so the replacement keeps the original indentation
  // and the surrounding newlines stay intact.
  const rawStart = mapStrippedIndex(content, first);
  const rawEnd = mapStrippedIndex(content, first + strippedOriginal.length);
  const start = content.lastIndexOf('\n', rawStart - 1) + 1;
  const lineEnd = content.indexOf('\n', rawEnd);
  const end = lineEnd === -1 ? content.length : lineEnd;
  return { status: 'found', range: { start, end }, matches: 1 };
}

/**
 * Finds a block's ORIGINAL inside the file. Exact substring first (with and
 * without a trailing newline), then a whitespace-stripped unique match.
 * `'ambiguous'` means the text fits more than one place in the file.
 */
export function findBlockRange(content: string, original: string): BlockLookup {
  const match = locateBlock(content, original);
  if (match.status === 'found') return match.range;
  return match.status;
}

/**
 * Applies S/R blocks to the file content, right-to-left, refusing overlaps.
 * Blocks that cannot be placed are skipped and reported, so one bad block
 * never blocks the rest of a multi-file change.
 */
export function applySearchReplaceBlocks(
  content: string,
  blocks: SearchReplaceBlock[]
): ApplySearchReplaceResult {
  const placed: Array<{ start: number; end: number; blockIndex: number }> = [];
  const failures: ApplyFailure[] = [];

  blocks.forEach((block, blockIndex) => {
    const match = locateBlock(content, block.original);

    if (match.status === 'not-found') {
      failures.push({ blockIndex, reason: 'not-found' });
      return;
    }
    if (match.status === 'not-unique') {
      failures.push({ blockIndex, reason: 'not-unique', matches: match.matches });
      return;
    }
    if (match.status === 'ambiguous') {
      // The one safe case: a block that "replaces" text with itself produces
      // byte-identical output wherever it lands, so any location is correct.
      if (block.updated === block.original) {
        placed.push({ ...match.occurrences[0], blockIndex });
        return;
      }
      failures.push({ blockIndex, reason: 'ambiguous', matches: match.matches });
      return;
    }
    placed.push({ ...match.range, blockIndex });
  });

  const sorted = [...placed].sort((a, b) => a.start - b.start);
  const overlapping = new Set<number>();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) {
      overlapping.add(sorted[index].blockIndex);
      overlapping.add(sorted[index - 1].blockIndex);
    }
  }
  overlapping.forEach((blockIndex) => failures.push({ blockIndex, reason: 'overlap' }));

  const failedIndexes = new Set(failures.map((failure) => failure.blockIndex));
  const applicable = sorted.filter((range) => !failedIndexes.has(range.blockIndex));

  let result = content;
  for (let index = applicable.length - 1; index >= 0; index -= 1) {
    const range = applicable[index];
    const block = blocks[range.blockIndex];
    result = result.slice(0, range.start) + block.updated + result.slice(range.end);
  }

  return { content: result, failures };
}

/**
 * Turns a failure into the sentence the review UI shows. `ambiguous` gets the
 * match count and the instruction the user actually needs — add context lines —
 * because "it did not apply" alone tells them nothing.
 */
export function formatApplyFailure(failure: ApplyFailure): string {
  const label = `block ${failure.blockIndex + 1}`;
  switch (failure.reason) {
    case 'not-found':
      return `${label}: text not found in the file`;
    case 'not-unique':
      return `${label}: matches several places once whitespace is ignored — add surrounding lines`;
    case 'ambiguous':
      return `${label}: matches ${failure.matches ?? 'several'} places — add surrounding lines to make it unique`;
    case 'overlap':
      return `${label}: overlaps another block`;
  }
}

/** The known files the user currently has open, for patch target resolution. */
export interface PatchWorkspaceFile extends KnownFile {}
interface BlockScan {
  info: string;
  context: string;
  body: string;
  terminated: boolean;
}

function scanFencedBlocks(content: string): BlockScan[] {
  const lines = content.split('\n');
  const blocks: BlockScan[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim().startsWith('```')) {
      index += 1;
      continue;
    }

    const info = lines[index].trim().slice(3);
    const bodyLines: string[] = [];
    let close = index + 1;
    while (close < lines.length && !lines[close].trim().startsWith('```')) {
      bodyLines.push(lines[close]);
      close += 1;
    }
    const terminated = close < lines.length;

    let context = '';
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      if (lines[scan].trim()) {
        context = lines[scan].trim();
        break;
      }
    }

    blocks.push({ info, context, body: bodyLines.join('\n'), terminated });
    index = close + 1;
  }

  return blocks;
}

/**
 * Pulls every intended file change out of a reply: S/R blocks inside fenced
 * code blocks become searchReplace patches, other fenced bodies become
 * whole-file rewrites. An S/R fence may carry the path on the first line
 * (Void's chat convention) or in the fence info.
 */
export function extractUnifiedPatches(content: string, files: KnownFile[] = []): UnifiedPatch[] {
  const patches: UnifiedPatch[] = [];

  for (const block of scanFencedBlocks(content)) {
    if (!block.terminated) continue;

    let body = block.body.replace(/\s+$/, '');
    const info = block.info;
    let context = block.context;

    // Void's chat convention: the first line of the block is the FULL PATH.
    const bodyLines = body.split('\n');
    const firstLine = bodyLines[0]?.trim() ?? '';
    if (firstLine && !firstLine.startsWith('<') && resolveTarget(firstLine, '', '', files)) {
      body = bodyLines.slice(1).join('\n');
      context = `${context} ${firstLine}`;
    }

    if (!body.trim()) continue;

    const blocks = parseSearchReplaceBlocks(body);
    if (blocks.length > 0) {
      const target = resolveTarget(info, context, body, files);
      if (target) patches.push({ path: target, kind: 'searchReplace', blocks });
      continue;
    }

    const target = resolveTarget(info, context, body, files);
    if (target) patches.push({ path: target, kind: 'rewrite', content: body });
  }

  return patches;
}

/**
 * Computes the final file content for a patch against the file's CURRENT
 * content. Search/replace failures leave the file untouched and are reported.
 */
export function resolvePatchContent(
  patch: { kind: 'rewrite' | 'searchReplace'; content?: string; blocks?: SearchReplaceBlock[] },
  currentContent: string
): { content: string; failures: ApplyFailure[] } {
  if (patch.kind === 'rewrite') {
    return { content: patch.content ?? '', failures: [] };
  }
  const result = applySearchReplaceBlocks(currentContent, patch.blocks ?? []);
  return { content: result.content, failures: result.failures };
}

/**
 * Whole-file rewrites are the one patch kind that can silently delete a user's
 * code: a small model asked to "fix the form" often returns the four lines it
 * touched, and the old behaviour replaced the whole 142-line file with them.
 *
 * Auto-apply therefore refuses a rewrite that would erase most of an existing
 * file. An explicit Accept in the review UI overrides it — the user may really
 * want to rewrite the file — but nothing destructive happens without either a
 * click or a warning.
 */
export function assessRewriteRisk(
  path: string,
  newContent: string,
  currentContent: string | undefined
): string | null {
  if (currentContent === undefined) return null;

  const nonBlankLines = (value: string) => value.split('\n').filter((line) => line.trim()).length;
  const before = nonBlankLines(currentContent);
  const after = nonBlankLines(newContent);
  if (before < 12) return null;

  const kept = currentContent
    .split('\n')
    .filter((line) => line.trim() && newContent.includes(line.trim()))
    .length;
  if (kept / before >= 0.4) return null;
  if (after >= before * 0.4) return null;

  return `${path}: the model returned a ${after}-line replacement for a ${before}-line file and reused almost none of it. Auto-apply refused this whole-file rewrite — click Accept to confirm it, or ask for targeted SEARCH/REPLACE edits ("only change the submit handler").`;
}
/** Convenience alias so callers keep using the existing rewrite shape. */
export function toRewritePatch(patch: UnifiedPatch, newContent: string): FilePatch {
  return { path: patch.path, content: newContent };
}
