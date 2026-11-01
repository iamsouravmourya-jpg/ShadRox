import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckpointMeta } from './history';
import {
  buildTimeline,
  checkpointAtRatio,
  describeCheckpoint,
  diffSince,
  formatCheckpointTime,
  timelinePosition,
  truncateCheckpointLabel
} from './timeline';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function checkpoint(
  id: string,
  createdAt: number,
  fileCount = 1,
  label = `Checkpoint ${id}`
): CheckpointMeta {
  return { id, messageId: `message-${id}`, label, createdAt, fileCount };
}

// ---------------------------------------------------------------- ordering

test('buildTimeline orders newest first and leaves the input untouched', () => {
  const input = [checkpoint('b', NOW - 2_000), checkpoint('c', NOW - 1_000), checkpoint('a', NOW - 3_000)];
  const ordered = buildTimeline(input);

  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ['c', 'b', 'a']
  );
  assert.deepEqual(
    input.map((entry) => entry.id),
    ['b', 'c', 'a'],
    'the caller array is not reordered'
  );
});

test('buildTimeline is stable for equal timestamps', () => {
  const input = [checkpoint('first', NOW), checkpoint('second', NOW), checkpoint('third', NOW)];
  assert.deepEqual(
    buildTimeline(input).map((entry) => entry.id),
    ['first', 'second', 'third']
  );
});

test('buildTimeline collapses duplicate ids to their newest entry', () => {
  const input = [checkpoint('same', NOW - 5_000), checkpoint('other', NOW - 1_000), checkpoint('same', NOW)];
  const ordered = buildTimeline(input);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ['same', 'other']
  );
  assert.equal(ordered[0].createdAt, NOW);
});

test('buildTimeline handles an empty list', () => {
  assert.deepEqual(buildTimeline([]), []);
});

// ------------------------------------------------------------- ratio math

test('timelinePosition spreads nodes evenly from 0 to 1', () => {
  assert.equal(timelinePosition(0, 5), 0);
  assert.equal(timelinePosition(1, 5), 0.25);
  assert.equal(timelinePosition(2, 5), 0.5);
  assert.equal(timelinePosition(3, 5), 0.75);
  assert.equal(timelinePosition(4, 5), 1);
});

test('timelinePosition centres a lone node and guards empty timelines', () => {
  assert.equal(timelinePosition(0, 1), 0.5);
  assert.equal(timelinePosition(0, 0), 0);
  assert.equal(timelinePosition(3, 0), 0);
});

test('timelinePosition clamps out-of-range and malformed indexes', () => {
  assert.equal(timelinePosition(-4, 5), 0);
  assert.equal(timelinePosition(99, 5), 1);
  assert.equal(timelinePosition(Number.NaN, 5), 0);
  assert.equal(timelinePosition(2, Number.POSITIVE_INFINITY), 0);
});

// -------------------------------------------------------- nearest selection

test('checkpointAtRatio picks oldest at 0, middle at 0.5 and newest at 1', () => {
  const points = buildTimeline([
    checkpoint('old', NOW - 3 * HOUR),
    checkpoint('new', NOW),
    checkpoint('mid', NOW - HOUR)
  ]);
  assert.deepEqual(
    points.map((entry) => entry.id),
    ['new', 'mid', 'old']
  );

  assert.equal(checkpointAtRatio(points, 0)?.id, 'old');
  assert.equal(checkpointAtRatio(points, 0.5)?.id, 'mid');
  assert.equal(checkpointAtRatio(points, 1)?.id, 'new');
});

test('checkpointAtRatio clamps negative, oversized and NaN ratios', () => {
  const points = [checkpoint('new', NOW), checkpoint('mid', NOW - HOUR), checkpoint('old', NOW - HOUR * 2)];
  assert.equal(checkpointAtRatio(points, -1)?.id, 'old');
  assert.equal(checkpointAtRatio(points, 4)?.id, 'new');
  assert.equal(checkpointAtRatio(points, Number.NaN)?.id, 'old');
});

test('checkpointAtRatio snaps to a real node between positions', () => {
  const points = [checkpoint('d', NOW), checkpoint('c', NOW - 1), checkpoint('b', NOW - 2), checkpoint('a', NOW - 3)];
  assert.equal(checkpointAtRatio(points, 0.1)?.id, 'a');
  assert.equal(checkpointAtRatio(points, 0.9)?.id, 'd');
});

test('checkpointAtRatio handles empty and single-point timelines', () => {
  assert.equal(checkpointAtRatio([], 0.5), null);
  const only = checkpoint('only', NOW);
  assert.equal(checkpointAtRatio([only], 0)?.id, 'only');
  assert.equal(checkpointAtRatio([only], 1)?.id, 'only');
});

// ---------------------------------------------------------- time formatting

test('formatCheckpointTime keeps sub-minute ages as "just now"', () => {
  assert.equal(formatCheckpointTime(NOW, NOW), 'just now');
  assert.equal(formatCheckpointTime(NOW - 59_000, NOW), 'just now');
});

test('formatCheckpointTime switches to minutes at 60 seconds', () => {
  assert.equal(formatCheckpointTime(NOW - 60_000, NOW), '1m ago');
  assert.equal(formatCheckpointTime(NOW - 4 * MINUTE, NOW), '4m ago');
  assert.equal(formatCheckpointTime(NOW - 59 * MINUTE, NOW), '59m ago');
});

test('formatCheckpointTime switches to hours at 60 minutes', () => {
  assert.equal(formatCheckpointTime(NOW - 60 * MINUTE, NOW), '1h ago');
  assert.equal(formatCheckpointTime(NOW - 2 * HOUR, NOW), '2h ago');
  assert.equal(formatCheckpointTime(NOW - 23 * HOUR, NOW), '23h ago');
});

test('formatCheckpointTime switches to days at 24 hours', () => {
  assert.equal(formatCheckpointTime(NOW - 24 * HOUR, NOW), '1d ago');
  assert.equal(formatCheckpointTime(NOW - 3 * DAY, NOW), '3d ago');
  assert.equal(formatCheckpointTime(NOW - 6 * DAY, NOW), '6d ago');
});

test('formatCheckpointTime falls back to a locale date after a week', () => {
  const then = NOW - 8 * DAY;
  assert.equal(formatCheckpointTime(then, NOW), new Date(then).toLocaleDateString());
  assert.ok(!formatCheckpointTime(then, NOW).includes('ago'));
});

test('formatCheckpointTime tolerates future timestamps and bad input', () => {
  assert.equal(formatCheckpointTime(NOW + 5 * MINUTE, NOW), 'just now');
  assert.equal(formatCheckpointTime(Number.NaN, NOW), 'just now');
  assert.equal(formatCheckpointTime(NOW, Number.NaN), 'just now');
});

// ------------------------------------------------------ checkpoint summary

test('describeCheckpoint reports files, pluralisation and age', () => {
  assert.equal(describeCheckpoint(checkpoint('a', NOW - 2 * HOUR, 12), NOW), '12 files • 2h ago');
  assert.equal(describeCheckpoint(checkpoint('b', NOW - MINUTE, 1), NOW), '1 file • 1m ago');
  assert.equal(describeCheckpoint(checkpoint('c', NOW, 0), NOW), '0 files • just now');
});

test('describeCheckpoint leaves long stored labels untouched', () => {
  const longLabel = 'Refactor the authentication middleware, session storage and token refresh paths '.repeat(3);
  const meta = checkpoint('long', NOW - HOUR, 7, longLabel);
  const before = meta.label;

  assert.equal(describeCheckpoint(meta, NOW), '7 files • 1h ago');
  assert.equal(meta.label, before, 'the stored label is never rewritten');
});

test('truncateCheckpointLabel shortens for display without mutating input', () => {
  const longLabel = 'a'.repeat(120);
  const shortened = truncateCheckpointLabel(longLabel, 20);
  assert.equal(shortened.length, 20);
  assert.ok(shortened.endsWith('…'));
  assert.equal(longLabel.length, 120);
  assert.equal(truncateCheckpointLabel('  Fix login  '), 'Fix login');
});

// ------------------------------------------------------------------ diffs

test('diffSince counts checkpoints on each side of the selection', () => {
  const points = buildTimeline([
    checkpoint('old', NOW - 3 * HOUR),
    checkpoint('new', NOW),
    checkpoint('mid', NOW - HOUR)
  ]);

  assert.deepEqual(diffSince(points, 'mid'), { older: 1, newer: 1 });
  assert.deepEqual(diffSince(points, 'new'), { older: 2, newer: 0 });
  assert.deepEqual(diffSince(points, 'old'), { older: 0, newer: 2 });
});

test('diffSince is independent of input order', () => {
  const points = [
    checkpoint('a', NOW - 3_000),
    checkpoint('c', NOW - 1_000),
    checkpoint('b', NOW - 2_000)
  ];
  assert.deepEqual(diffSince(points, 'b'), { older: 1, newer: 1 });
});

test('diffSince handles null, unknown, empty and duplicate-id selections', () => {
  const points = [checkpoint('new', NOW), checkpoint('old', NOW - HOUR), checkpoint('new', NOW - HOUR * 2)];
  assert.deepEqual(diffSince(points, null), { older: 0, newer: 0 });
  assert.deepEqual(diffSince(points, 'missing'), { older: 0, newer: 0 });
  assert.deepEqual(diffSince([], 'anything'), { older: 0, newer: 0 });
  assert.deepEqual(diffSince(points, 'new'), { older: 1, newer: 0 });
});

test('diffSince ignores equal timestamps on both sides', () => {
  const points = [checkpoint('a', NOW), checkpoint('b', NOW), checkpoint('c', NOW)];
  assert.deepEqual(diffSince(points, 'b'), { older: 0, newer: 0 });
});
