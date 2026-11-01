import type { CheckpointMeta } from './history';

/**
 * Pure helpers behind the visual checkpoint timeline. Nothing here touches the
 * DOM or the checkpoint store: the component feeds it the list from
 * `useWorkspace().checkpoints` and gets an ordered, measurable timeline back.
 *
 * Canonical order is *newest first* (the same order `listCheckpoints` and
 * `workspace.checkpoints` use). The rail UI reverses it so older nodes sit on
 * the left and the newest node is on the right.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_DAYS = 7;
const DEFAULT_LABEL_CHARS = 48;

/** Stable timestamp used for sorting; malformed values are treated as epoch 0. */
function safeTime(createdAt: number): number {
  return Number.isFinite(createdAt) ? createdAt : 0;
}

/**
 * Orders checkpoints newest first. The sort is stable for equal timestamps
 * (insertion order is kept) and duplicate ids are collapsed to their newest
 * entry so React keys and id-based selection stay unambiguous.
 */
export function buildTimeline(checkpoints: CheckpointMeta[]): CheckpointMeta[] {
  const decorated = checkpoints.map((checkpoint, index) => ({ checkpoint, index }));
  decorated.sort(
    (left, right) =>
      safeTime(right.checkpoint.createdAt) - safeTime(left.checkpoint.createdAt) ||
      left.index - right.index
  );

  const seen = new Set<string>();
  const timeline: CheckpointMeta[] = [];
  for (const entry of decorated) {
    if (seen.has(entry.checkpoint.id)) continue;
    seen.add(entry.checkpoint.id);
    timeline.push(entry.checkpoint);
  }
  return timeline;
}

/**
 * Horizontal position of node `index` in a rail of `total` nodes, as 0..1.
 * A lone node is centred; an empty or malformed timeline collapses to 0.
 */
export function timelinePosition(index: number, total: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) return 0;
  if (total === 1) return 0.5;
  const clamped = Math.min(Math.max(index, 0), total - 1);
  return clamped / (total - 1);
}

/**
 * Nearest checkpoint for a 0..1 slider position. Input is expected newest
 * first (see `buildTimeline`), so ratio 1 is the newest checkpoint and ratio 0
 * the oldest. Out-of-range and NaN ratios are clamped to a real node.
 */
export function checkpointAtRatio(points: CheckpointMeta[], ratio: number): CheckpointMeta | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];

  const safeRatio = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  const index = Math.round((1 - safeRatio) * (points.length - 1));
  return points[index];
}

/**
 * Relative label for a checkpoint age: "just now", "4m ago", "2h ago",
 * "3d ago", then a locale date once the checkpoint is a week old. Future
 * timestamps (clock skew) read as "just now".
 */
export function formatCheckpointTime(createdAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) return 'just now';
  const elapsed = Math.max(0, now - createdAt);

  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < RELATIVE_DAYS * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(createdAt).toLocaleDateString();
}

/**
 * Compact one-line description for the rail: "12 files • 2h ago". The stored
 * label is intentionally not included (or modified) here; the component shows
 * it separately and truncates it for display with `truncateCheckpointLabel`.
 */
export function describeCheckpoint(meta: CheckpointMeta, now?: number): string {
  const fileCount = Number.isFinite(meta.fileCount) ? Math.max(0, meta.fileCount) : 0;
  const files = `${fileCount} file${fileCount === 1 ? '' : 's'}`;
  return `${files} • ${formatCheckpointTime(meta.createdAt, now)}`;
}

/** Display-only truncation; never assign the result back onto the checkpoint. */
export function truncateCheckpointLabel(label: string, max = DEFAULT_LABEL_CHARS): string {
  const text = typeof label === 'string' ? label.trim() : '';
  const limit = Math.max(4, Math.floor(max));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * How many checkpoints sit on each side of the selection. `newer` drives the
 * "reverts N later change(s)" warning; equal timestamps count as neither.
 * Unknown/empty selections and duplicate ids are safe no-ops.
 */
export function diffSince(
  points: CheckpointMeta[],
  selectedId: string | null
): { older: number; newer: number } {
  const result = { older: 0, newer: 0 };
  if (!selectedId) return result;

  const selected = points.find((checkpoint) => checkpoint.id === selectedId);
  if (!selected) return result;

  const selectedTime = safeTime(selected.createdAt);
  for (const checkpoint of points) {
    if (checkpoint.id === selectedId) continue;
    const time = safeTime(checkpoint.createdAt);
    if (time < selectedTime) result.older += 1;
    else if (time > selectedTime) result.newer += 1;
  }
  return result;
}
