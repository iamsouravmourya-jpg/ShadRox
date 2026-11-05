import { resolveTarget, type FilePatch, type KnownFile } from './markdown';
import { canonicalize, calculateSimilarity, SIMILARITY_THRESHOLD } from './patch/clineDiff';
import {
	clineSectionsToPatches,
	parseClinePatchSections,
	refusalBlock,
	refusalReason,
	type ClinePatchEntry,
	type ClineRefusalCode,
} from './patch/clinePatchApply';
import { PATCH_MARKERS, DiffError } from './patch/clinePatchParser';

/**
 * Multi-file unified patch engine.
 *
 * Ported from Void's Fast Apply (reference/void-main/.../common/helpers/
 * extractCodeFromResult.ts and browser/editCodeService.ts), stripped of every
 * VS Code dependency, and extended with Cline's apply-patch algorithm
 * (Apache-2.0; see src/lib/patch/*.ts for the attribution headers):
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
 * - NEW (Cline port): the model may also emit Cline's `*** Begin Patch`
 *   apply_patch grammar (Update/Add with @@ context hunks, tolerant of the
 *   legacy %%bash apply_patch <<'EOF' wrapper). Hunks are converted to
 *   SEARCH/REPLACE blocks so ShadRox's own anchor verification — never
 *   Cline's write-now fuzz — positions and validates them.
 * - NEW (Cline port): locateBlock grows a fourth level, `fuzzy`: a unique
 *   Levenshtein-similar line window (similarity >= 0.66 over >= 3 lines, the
 *   same math Cline's findContext uses). Two or more similar windows are
 *   refused as `not-unique`; a short block never reaches this level.
 * - SAFETY vs Cline: computeClinePatchChanges (the fuzz-anchored executor
 *   Cline itself uses) is exported from './patch/clinePatchApply' as a seam
 *   but is NOT wired into auto-apply — its similarity pass can place a hunk
 *   on a merely *similar* window. Anything that fails verification writes
 *   zero bytes.
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

/** How forgiving a match was: verbatim, whole lines trimmed, all whitespace ignored, or Cline's similarity pass. */
export type LocateLevel = 'exact' | 'lines' | 'stripped' | 'fuzzy';

export type BlockMatch =
  | { status: 'found'; range: BlockRange; matches: number; via: LocateLevel }
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

type TrimmedLineLookup = { range: BlockRange } | 'not-found' | 'not-unique';

/**
 * Line-level fallback: compare the block against the file one trimmed line at a
 * time. A model that re-indents a snippet, or whose fence strips the blank line
 * it was anchored to, still names the right text — this catches that without
 * going as far as ignoring every whitespace difference in the file.
 * Blank lines at either end of the block carry no signal, so they are dropped.
 */
function locateByTrimmedLines(content: string, original: string): TrimmedLineLookup {
  const wanted = original.split('\n').map((line) => line.replace(/\r$/, '').trim());
  while (wanted.length && wanted[0] === '') wanted.shift();
  while (wanted.length && wanted[wanted.length - 1] === '') wanted.pop();
  if (!wanted.length) return 'not-found';

  const lines = content.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const normalized = lines.map((line) => line.replace(/\r$/, '').trim());

  let hit = -1;
  for (let start = 0; start + wanted.length <= normalized.length; start += 1) {
    let matches = true;
    for (let index = 0; index < wanted.length; index += 1) {
      if (normalized[start + index] !== wanted[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (hit !== -1) return 'not-unique';
    hit = start;
  }
  if (hit === -1) return 'not-found';
  const last = hit + wanted.length - 1;
  if (last + 1 >= starts.length) return { range: { start: starts[hit], end: content.length } };
  let end = starts[last + 1] - 1;
  if (content[end - 1] === '\r') end -= 1;
  return { range: { start: starts[hit], end } };
}

type SimilarityLookup =
  | { kind: 'found'; range: BlockRange }
  | { kind: 'not-unique'; candidates: number }
  | { kind: 'none' };

/**
 * Fourth-level fallback, ported in spirit from Cline's findContext()
 * similarity pass (Levenshtein ratio >= 0.66, canonicalized punctuation —
 * src/lib/patch/clineDiff.ts). Two ShadRox safety changes over Cline:
 *  - EVERY window at or over the threshold is collected, not just the first;
 *    two or more candidates means the block cannot say which place it meant,
 *    so it is refused as `not-unique` (Cline would silently take the first).
 *  - Only multi-line blocks (>= 3 lines, >= 40 non-whitespace characters)
 *    reach this level. On one short line a 0.66 ratio is a coin flip —
 *    `callC();` is 0.875 similar to `callA();` — and a coin flip is not an
 *    anchor. Cheap first/last-line pre-checks keep the O(n·m) distance math
 *    off windows that cannot possibly pass.
 */
function locateBySimilarity(content: string, original: string): SimilarityLookup {
  const wantedLines = original.split('\n').map((line) => line.replace(/\r$/, ''));
  while (wantedLines.length && wantedLines[0].trim() === '') wantedLines.shift();
  while (wantedLines.length && wantedLines[wantedLines.length - 1].trim() === '') wantedLines.pop();
  if (wantedLines.length < 3) return { kind: 'none' };
  if (wantedLines.join('').replace(/\s/g, '').length < 40) return { kind: 'none' };

  const rawLines = content.split('\n');
  if (rawLines.length > 20000) return { kind: 'none' };
  const starts: number[] = [];
  let offset = 0;
  for (const line of rawLines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lines = rawLines.map((line) => line.replace(/\r$/, ''));

  const canonWanted = canonicalize(wantedLines.join('\n'));
  const firstWanted = canonWanted.split('\n')[0] ?? '';
  const lastWanted = canonWanted.split('\n')[canonWanted.split('\n').length - 1] ?? '';
  const window = wantedLines.length;

  const candidates: number[] = [];
  for (let start = 0; start + window <= lines.length; start += 1) {
    const firstLine = canonicalize((lines[start] ?? '').trimEnd());
    if (calculateSimilarity(firstLine, firstWanted) < SIMILARITY_THRESHOLD) continue;
    const lastLine = canonicalize((lines[start + window - 1] ?? '').trimEnd());
    if (calculateSimilarity(lastLine, lastWanted) < SIMILARITY_THRESHOLD) continue;
    const segment = canonicalize(lines.slice(start, start + window).join('\n'));
    if (calculateSimilarity(segment, canonWanted) >= SIMILARITY_THRESHOLD) {
      candidates.push(start);
      if (candidates.length > 1) return { kind: 'not-unique', candidates: candidates.length };
    }
  }
  if (!candidates.length) return { kind: 'none' };

  // Snap to whole lines, exactly like the trimmed-line level, so the
  // replacement keeps the file's own surrounding newlines.
  const hit = candidates[0];
  const last = hit + window - 1;
  if (last + 1 >= starts.length) return { kind: 'found', range: { start: starts[hit], end: content.length } };
  let end = starts[last + 1] - 1;
  if (content[end - 1] === '\r') end -= 1;
  return { kind: 'found', range: { start: starts[hit], end } };
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
      matches: 1,
      via: 'exact'
    };
  }

  const byLines = locateByTrimmedLines(content, original);
  if (typeof byLines !== 'string') {
    return { status: 'found', range: byLines.range, matches: 1, via: 'lines' };
  }

  const strip = (value: string) => value.replace(/[ \t]+/g, '');
  const strippedFile = strip(content);
  const strippedOriginal = strip(original);
  if (!strippedOriginal) return byLines === 'not-unique' ? { status: 'not-unique', matches: 2 } : { status: 'not-found', matches: 0 };
  const first = strippedFile.indexOf(strippedOriginal);
  if (first === -1) {
    if (byLines !== 'not-unique') {
      const fuzzy = locateBySimilarity(content, original);
      if (fuzzy.kind === 'found') {
        return { status: 'found', range: fuzzy.range, matches: 1, via: 'fuzzy' };
      }
      if (fuzzy.kind === 'not-unique') {
        return { status: 'not-unique', matches: fuzzy.candidates };
      }
    }
    return byLines === 'not-unique' ? { status: 'not-unique', matches: 2 } : { status: 'not-found', matches: 0 };
  }
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
  return { status: 'found', range: { start, end }, matches: 1, via: 'stripped' };
}

/**
 * Finds a block's ORIGINAL inside the file. Exact substring first, then whole
 * trimmed lines, then a whitespace-stripped unique match. `'ambiguous'` means
 * the text fits more than one place in the file.
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

/** A declared file operation the patch pipeline could not express. */
export interface RejectedPatch {
  path: string;
  code: ClineRefusalCode;
  /** User-readable reason; safe to show in a toast or a review row. */
  reason: string;
}

export interface UnifiedPatchScan {
  patches: UnifiedPatch[];
  rejected: RejectedPatch[];
}

function patchPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Pulls every intended file change out of a reply: S/R blocks inside fenced
 * code blocks become searchReplace patches, other fenced bodies become
 * whole-file rewrites. An S/R fence may carry the path on the first line
 * (Void's chat convention) or in the fence info.
 *
 * A fenced body carrying Cline's `*** Begin Patch` grammar (Update/Add/Delete
 * File with @@ context hunks, with or without the legacy %%bash wrapper)
 * becomes searchReplace/rewrite patches per file through the same engine;
 * operations the pipeline cannot express (Delete, Move) and parse failures
 * become guaranteed-refusal patches, never silent drops.
 *
 * Two rules stop a reply from turning into a lie about what happened:
 *  - ONE patch per file. A model that re-emits the same block in two tool
 *    rounds used to produce two review rows for one file ("Changes · 2
 *    files" for a single create). The LAST block for a path wins, because it
 *    reflects the model's final state; earlier duplicates are dropped.
 *  - A fence that names a file and writes nothing is a deletion attempt, not a
 *    no-op. It used to `continue` silently, so "I deleted test.txt" produced
 *    zero patches, zero errors and no verification. It now becomes a refusal
 *    patch (the plan fails with a readable reason) and is reported in
 *    `rejected` so a caller can surface it directly.
 */
export function extractUnifiedPatchScan(content: string, files: KnownFile[] = []): UnifiedPatchScan {
  const entries: Array<{ patch: UnifiedPatch; rejected?: RejectedPatch }> = [];
  const indexByPath = new Map<string, number>();

  const add = (patch: UnifiedPatch, rejected?: RejectedPatch) => {
    const key = patchPathKey(patch.path);
    const existing = indexByPath.get(key);
    if (existing === undefined) {
      indexByPath.set(key, entries.length);
      entries.push({ patch, rejected });
      return;
    }
    // Same file named twice: keep the later block (final state) but the first
    // path spelling, so the review row label stays stable.
    const firstPath = entries[existing].patch.path;
    entries[existing] = { patch: { ...patch, path: firstPath }, rejected };
  };

  for (const block of scanFencedBlocks(content)) {
    if (!block.terminated) continue;

    let body = block.body.replace(/\s+$/, '');
    const info = block.info;
    let context = block.context;

    if (looksLikeClinePatch(body)) {
      for (const entry of clinePatchBodyToUnifiedPatches(body, info, context, files)) {
        add(entry.patch, entry.rejected);
      }
      continue;
    }

    // Void's chat convention: the first line of the block is the FULL PATH.
    const bodyLines = body.split('\n');
    const firstLine = bodyLines[0]?.trim() ?? '';
    if (firstLine && !firstLine.startsWith('<') && resolveTarget(firstLine, '', '', files)) {
      body = bodyLines.slice(1).join('\n');
      context = `${context} ${firstLine}`;
    }

    if (!body.trim()) {
      const target = resolveTarget(info, context, body, files);
      if (!target) continue;
      const reason = `The reply declared ${target} but supplied an empty body. An empty body is a deletion, and deletions are not applied from a patch — the file was left untouched. Delete it from the file tree, or ask the agent to delete it.`;
      add(
        { path: target, kind: 'searchReplace', blocks: [refusalBlock(reason, 'EMPTY_BODY')] },
        { path: target, code: 'EMPTY_BODY', reason }
      );
      continue;
    }

    const blocks = parseSearchReplaceBlocks(body);
    if (blocks.length > 0) {
      const target = resolveTarget(info, context, body, files);
      if (target) add({ path: target, kind: 'searchReplace', blocks });
      continue;
    }

    const target = resolveTarget(info, context, body, files);
    if (target) add({ path: target, kind: 'rewrite', content: body });
  }

  const rejected: RejectedPatch[] = [];
  for (const entry of entries) if (entry.rejected) rejected.push(entry.rejected);
  return { patches: entries.map((entry) => entry.patch), rejected };
}

/** The patches a reply intends, deduplicated by path. See extractUnifiedPatchScan. */
export function extractUnifiedPatches(content: string, files: KnownFile[] = []): UnifiedPatch[] {
  return extractUnifiedPatchScan(content, files).patches;
}

/** True when any line of the body carries an apply_patch file operation marker. */
export function looksLikeClinePatch(body: string): boolean {
  for (const line of body.split('\n').slice(0, 8)) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith(PATCH_MARKERS.BEGIN) ||
      trimmed.startsWith(PATCH_MARKERS.ADD) ||
      trimmed.startsWith(PATCH_MARKERS.UPDATE) ||
      trimmed.startsWith(PATCH_MARKERS.DELETE)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalPatchPath(path: string, files: KnownFile[]): string {
  const wanted = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  for (const file of files) {
    if (file.name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() === wanted) return file.name;
  }
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function clinePatchBodyToUnifiedPatches(
  body: string,
  info: string,
  context: string,
  files: KnownFile[]
): Array<{ patch: UnifiedPatch; rejected?: RejectedPatch }> {
  const contents: Record<string, string> = {};
  for (const file of files) contents[file.name] = file.content;

  let entries: ClinePatchEntry[];
  try {
    entries = clineSectionsToPatches(parseClinePatchSections(body), contents);
  } catch (error) {
    if (!(error instanceof DiffError)) throw error;
    // A malformed or unanchorable patch must still BLOCK the plan; it can
    // never be dropped quietly, or the model claims edits that did not land.
    const target = resolveTarget(info, context, body, files) ?? canonicalPatchPath('apply-patch', files);
    return [{
      patch: { path: target, kind: 'searchReplace', blocks: [refusalBlock(error.message, 'PARSE_ERROR')] },
      rejected: { path: target, code: 'PARSE_ERROR', reason: error.message }
    }];
  }

  const patches: Array<{ patch: UnifiedPatch; rejected?: RejectedPatch }> = [];
  for (const entry of entries) {
    const target = canonicalPatchPath(entry.path, files);
    if (entry.kind === 'rewrite') {
      patches.push({ patch: { path: target, kind: 'rewrite', content: entry.content } });
    } else if (entry.kind === 'searchReplace') {
      patches.push({ patch: { path: target, kind: 'searchReplace', blocks: entry.blocks } });
    } else {
      // A refused operation stays a guaranteed-refusal patch (zero bytes) and
      // is ALSO reported as a typed rejection, so callers can explain it
      // without having to run the planner first.
      patches.push({
        patch: { path: target, kind: 'searchReplace', blocks: [refusalBlock(entry.reason, entry.code)] },
        rejected: { path: target, code: entry.code, reason: entry.reason }
      });
    }
  }
  return patches;
}

/**
 * Computes the final file content for a patch against the file's CURRENT
 * content. Search/replace failures leave the file untouched and are reported.
 *
 * A patch that carries a refusal block (deletion, move, unanchorable hunk,
 * empty body) still resolves to the unchanged content and `not-found`, but it
 * also reports `refusal` with the typed code and the human reason, so the
 * planner can say *why* instead of the generic "text not found" that a merely
 * stale anchor produces.
 */
export function resolvePatchContent(
  patch: { kind: 'rewrite' | 'searchReplace'; content?: string; blocks?: SearchReplaceBlock[] },
  currentContent: string
): { content: string; failures: ApplyFailure[]; refusal?: { code: string; reason: string } } {
  if (patch.kind === 'rewrite') {
    return { content: patch.content ?? '', failures: [] };
  }
  const blocks = patch.blocks ?? [];
  const result = applySearchReplaceBlocks(currentContent, blocks);
  const refusal = blocks.map((block) => refusalReason(block)).find((found) => found !== null) ?? undefined;
  return { content: result.content, failures: result.failures, refusal };
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

/* ------------------------------------------------------------------ *
 * Cline seams (see src/lib/patch/*.ts for the Apache-2.0 port headers).
 *
 * computeClinePatchChanges is Cline's own executor math — fuzz-anchored
 * hunks resolved against CURRENT contents, throwing before producing a
 * change set when any hunk fails every match level. It is exported for
 * callers that verify the result on disk with their own guards
 * (a future human-reviewed apply path); auto-apply deliberately does NOT
 * use it, it stays on the SEARCH/REPLACE verification pipeline above.
 * atomicApply must not be edited from this task, so this export IS its
 * seam: planAtomicApply can adopt it later without patchEngine changing.
 * ------------------------------------------------------------------ */
export {
	computeClinePatchChanges,
	findContent as findClineFileContent,
} from './patch/clinePatchApply';
export {
	DiffError as ClineDiffError,
	PATCH_MARKERS as CLINE_PATCH_MARKERS,
	PatchActionType as ClinePatchActionType,
	PatchParser as ClinePatchParser,
} from './patch/clinePatchParser';
export { makeUnifiedDiff, countDiffLines } from './patch/clineUiDiff';
export type { ClineChangeSet, ClineFileChange } from './patch/clinePatchApply';
export type { ClineParsedSections, ClinePatchEntry, ClineUpdateSection } from './patch/clinePatchApply';
