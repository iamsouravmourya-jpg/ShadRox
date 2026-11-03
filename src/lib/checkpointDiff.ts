import { computeHunks } from './editor/hunks';
import type { WorkspaceFile } from './types';

/**
 * What restoring a checkpoint would do to the workspace *now*.
 *
 * A checkpoint stores whole file bodies, so the honest question is not "what
 * changed since the checkpoint was taken" but "what will change if we go back".
 * Restoring deletes files that appeared after it and brings back files that
 * were since removed, which is exactly what a user needs to see before
 * confirming.
 */
export type CheckpointChangeKind = 'edit' | 'restore' | 'delete';

export interface CheckpointFileChange {
  path: string;
  kind: CheckpointChangeKind;
  added: number;
  removed: number;
  /** Set when a file was too large to diff line by line. */
  approximate: boolean;
}

export interface CheckpointDiff {
  changes: CheckpointFileChange[];
  edited: number;
  restored: number;
  deleted: number;
  linesAdded: number;
  linesRemoved: number;
  /** True when more files changed than `maxChanges` allows listing. */
  truncated: boolean;
  clean: boolean;
}

const DEFAULT_MAX_CHANGES = 120;
/** Line counting is quadratic in the worst case, so huge files report "modified" only. */
const MAX_DIFF_CHARS = 400_000;

function keyOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function tally(
  before: string,
  after: string
): { added: number; removed: number; approximate: boolean } {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) {
    return { added: 0, removed: 0, approximate: true };
  }
  let added = 0;
  let removed = 0;
  for (const hunk of computeHunks(before, after)) {
    removed += hunk.beforeEnd - hunk.beforeStart;
    added += hunk.afterLines.length;
  }
  return { added, removed, approximate: false };
}

/**
 * Diff the live buffers against a checkpoint's stored files. Order is by path so
 * the same two states always render the same list.
 */
export function diffToCheckpoint(
  current: ReadonlyArray<Pick<WorkspaceFile, 'name' | 'content'>>,
  checkpoint: ReadonlyArray<Pick<WorkspaceFile, 'name' | 'content'>>,
  options: { maxChanges?: number } = {}
): CheckpointDiff {
  const maxChanges = Math.max(1, Math.floor(options.maxChanges ?? DEFAULT_MAX_CHANGES));
  const currentByKey = new Map(current.map((file) => [keyOf(file.name), file]));
  const checkpointByKey = new Map(checkpoint.map((file) => [file.name, keyOf(file.name)]));
  const changes: CheckpointFileChange[] = [];
  let edited = 0;
  let restored = 0;
  let deleted = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let omitted = 0;

  const record = (change: CheckpointFileChange, kindCounts: () => void) => {
    kindCounts();
    linesAdded += change.added;
    linesRemoved += change.removed;
    if (changes.length < maxChanges) changes.push(change);
    else omitted += 1;
  };

  for (const file of checkpoint) {
    const key = keyOf(file.name);
    const live = currentByKey.get(key);
    if (!live) {
      const lines = file.content.length > MAX_DIFF_CHARS ? 0 : file.content.split('\n').length;
      record({ path: file.name, kind: 'restore', added: lines, removed: 0, approximate: lines === 0 }, () => {
        restored += 1;
      });
      continue;
    }
    if (live.content === file.content) continue;
    const counts = tally(live.content, file.content);
    record(
      { path: file.name, kind: 'edit', added: counts.added, removed: counts.removed, approximate: counts.approximate },
      () => {
        edited += 1;
      }
    );
  }

  for (const file of current) {
    if (checkpointByKey.has(keyOf(file.name))) continue;
    const lines = file.content.length > MAX_DIFF_CHARS ? 0 : file.content.split('\n').length;
    record({ path: file.name, kind: 'delete', added: 0, removed: lines, approximate: lines === 0 }, () => {
      deleted += 1;
    });
  }

  changes.sort((a, b) => a.path.replace(/\\/g, '/').localeCompare(b.path.replace(/\\/g, '/')));

  return {
    changes,
    edited,
    restored,
    deleted,
    linesAdded,
    linesRemoved,
    truncated: omitted > 0,
    clean: edited + restored + deleted === 0
  };
}

/** One honest sentence for the rail, e.g. `3 files change: 2 edited, 1 new since (+42 −7)`. */
export function describeCheckpointDiff(diff: CheckpointDiff): string {
  if (diff.clean) return 'Same files as now — restoring changes nothing';
  const parts: string[] = [];
  if (diff.edited) parts.push(`${diff.edited} edited`);
  if (diff.restored) parts.push(`${diff.restored} came back`);
  if (diff.deleted) parts.push(`${diff.deleted} deleted by restore`);
  const files = diff.edited + diff.restored + diff.deleted;
  const lineText =
    diff.linesAdded || diff.linesRemoved ? ` (+${diff.linesAdded} −${diff.linesRemoved})` : '';
  return `${files} file${files === 1 ? '' : 's'} change: ${parts.join(', ')}${lineText}${
    diff.truncated ? ' · list capped' : ''
  }`;
}
