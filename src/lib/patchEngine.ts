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
  reason: 'not-found' | 'not-unique' | 'overlap';
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
export type BlockLookup = BlockRange | 'not-found' | 'not-unique';

/** Maps an index in whitespace-stripped text back to the original offset. */
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
 * Finds a block's ORIGINAL inside the file. Exact substring first (with and
 * without a trailing newline), then a whitespace-stripped unique match.
 */
export function findBlockRange(content: string, original: string): BlockLookup {
  const candidates = [original, `${original}\n`, `\n${original}`];
  for (const candidate of candidates) {
    const index = content.indexOf(candidate);
    if (index !== -1) return { start: index, end: index + candidate.length };
  }

  const strip = (value: string) => value.replace(/[ \t]+/g, '');
  const strippedFile = strip(content);
  const strippedOriginal = strip(original);
  if (!strippedOriginal) return 'not-found';
  const first = strippedFile.indexOf(strippedOriginal);
  if (first === -1) return 'not-found';
  if (strippedFile.indexOf(strippedOriginal, first + strippedOriginal.length) !== -1) return 'not-unique';
  // Snap to whole lines so the replacement keeps the original indentation
  // and the surrounding newlines stay intact.
  const rawStart = mapStrippedIndex(content, first);
  const rawEnd = mapStrippedIndex(content, first + strippedOriginal.length);
  const start = content.lastIndexOf('\n', rawStart - 1) + 1;
  const lineEnd = content.indexOf('\n', rawEnd);
  const end = lineEnd === -1 ? content.length : lineEnd;
  return { start, end };
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
    const lookup = findBlockRange(content, block.original);
    if (lookup === 'not-found') {
      failures.push({ blockIndex, reason: 'not-found' });
      return;
    }
    if (lookup === 'not-unique') {
      failures.push({ blockIndex, reason: 'not-unique' });
      return;
    }
    placed.push({ ...lookup, blockIndex });
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

/** Convenience alias so callers keep using the existing rewrite shape. */
export function toRewritePatch(patch: UnifiedPatch, newContent: string): FilePatch {
  return { path: patch.path, content: newContent };
}
