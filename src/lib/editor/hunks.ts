/**
 * Line-level diffing for the review UI.
 *
 * An assistant rewrite used to be accepted or rejected as a whole, so a good
 * edit buried under one bad line had to be thrown away. Hunking the change lets
 * the user keep the lines they agree with and leave the rest alone.
 *
 * The algorithm trims the common prefix/suffix first (which is what makes an
 * edit in the middle of a large file cheap) and only runs the quadratic LCS on
 * what is left, falling back to a single hunk when even that is too big.
 */

export interface DiffHunk {
  id: string;
  /** 0-based inclusive start line in the original text. */
  beforeStart: number;
  /** Exclusive end line in the original text; equals `beforeStart` for a pure insertion. */
  beforeEnd: number;
  /** The lines that replace `beforeStart..beforeEnd` when the hunk is accepted. */
  afterLines: string[];
}

/** ~4M cells keeps the LCS table under 16 MB. */
const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.split('\n');
}

export function computeHunks(before: string, after: string): DiffHunk[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const n = beforeLines.length;
  const m = afterLines.length;

  if (before === after) return [];

  let prefix = 0;
  while (prefix < n && prefix < m && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && beforeLines[n - 1 - suffix] === afterLines[m - 1 - suffix]) {
    suffix += 1;
  }

  const beforeMiddle = n - prefix - suffix;
  const afterMiddle = m - prefix - suffix;

  if (beforeMiddle * afterMiddle > MAX_DIFF_CELLS) {
    return [
      {
        id: 'hunk-1',
        beforeStart: prefix,
        beforeEnd: n - suffix,
        afterLines: afterLines.slice(prefix, m - suffix)
      }
    ];
  }

  // dp[i][j] = LCS length of beforeLines[prefix+i ..] and afterLines[prefix+j ..].
  const width = afterMiddle + 1;
  const dp = new Uint32Array((beforeMiddle + 1) * width);
  const at = (i: number, j: number) => i * width + j;
  for (let i = beforeMiddle - 1; i >= 0; i -= 1) {
    for (let j = afterMiddle - 1; j >= 0; j -= 1) {
      dp[at(i, j)] =
        beforeLines[prefix + i] === afterLines[prefix + j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const hunks: DiffHunk[] = [];
  const push = (i0: number, i1: number, j0: number, j1: number) => {
    hunks.push({
      id: `hunk-${hunks.length + 1}`,
      beforeStart: prefix + i0,
      beforeEnd: prefix + i1,
      afterLines: afterLines.slice(prefix + j0, prefix + j1)
    });
  };

  let i = 0;
  let j = 0;
  while (i < beforeMiddle || j < afterMiddle) {
    if (i < beforeMiddle && j < afterMiddle && beforeLines[prefix + i] === afterLines[prefix + j]) {
      i += 1;
      j += 1;
      continue;
    }
    const startI = i;
    const startJ = j;
    while (i < beforeMiddle || j < afterMiddle) {
      if (i < beforeMiddle && j < afterMiddle && beforeLines[prefix + i] === afterLines[prefix + j]) break;
      // An exhausted side must keep advancing the other one, otherwise the lines
      // left over on that side get split into a spurious hunk of their own.
      if (i >= beforeMiddle) j += 1;
      else if (j >= afterMiddle) i += 1;
      else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i += 1;
      else j += 1;
    }
    push(startI, i, startJ, j);
  }

  return hunks;
}

export function allHunkIds(hunks: DiffHunk[]): Set<string> {
  return new Set(hunks.map((hunk) => hunk.id));
}

/**
 * Rebuild the file keeping only the accepted hunks. Every other stretch of the
 * original text is copied through verbatim, so a rejected hunk cannot leave a
 * half-applied line behind.
 */
export function acceptedContent(before: string, hunks: DiffHunk[], accepted: ReadonlySet<string>): string {
  const beforeLines = splitLines(before);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    for (; cursor < hunk.beforeStart; cursor += 1) output.push(beforeLines[cursor]);
    if (accepted.has(hunk.id)) {
      output.push(...hunk.afterLines);
    } else {
      for (; cursor < hunk.beforeEnd; cursor += 1) output.push(beforeLines[cursor]);
    }
    cursor = hunk.beforeEnd;
  }
  for (; cursor < beforeLines.length; cursor += 1) output.push(beforeLines[cursor]);

  return output.join('\n');
}

export function groupedHunkId(groupIndex: number, hunkId: string): string {
  return `${groupIndex}:${hunkId}`;
}

export interface ReplacementBlock {
  original: string;
  updated: string;
}

/**
 * Keeps only replacement blocks with accepted hunks and merges the accepted
 * lines into each block's original text. Unknown ids mean the review went stale.
 */
export function acceptedReplacementBlocks<T extends ReplacementBlock>(
  blocks: readonly T[],
  acceptedIds: readonly string[]
): { blocks: T[]; unknownIds: string[] } {
  const accepted = new Set(acceptedIds);
  const known = new Set<string>();
  const result: T[] = [];

  blocks.forEach((block, groupIndex) => {
    const hunks = computeHunks(block.original, block.updated);
    const acceptedForGroup = new Set<string>();
    for (const hunk of hunks) {
      const id = groupedHunkId(groupIndex, hunk.id);
      known.add(id);
      if (accepted.has(id)) acceptedForGroup.add(hunk.id);
    }
    if (acceptedForGroup.size === 0) return;
    const updated = acceptedContent(block.original, hunks, acceptedForGroup);
    if (updated !== block.original) result.push({ ...block, updated });
  });

  return {
    blocks: result,
    unknownIds: acceptedIds.filter((id) => !known.has(id))
  };
}

export interface HunkStats {
  added: number;
  removed: number;
}

export function hunkStats(hunks: DiffHunk[]): HunkStats {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.afterLines.length;
    removed += hunk.beforeEnd - hunk.beforeStart;
  }
  return { added, removed };
}
