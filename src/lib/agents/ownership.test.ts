import assert from 'node:assert/strict';
import test from 'node:test';

import { nextRunnable } from '../autonomy/dag';
import {
  conflictSummary,
  detectConflicts,
  fileClaims,
  normalizeOwnedPath,
  serialiseConflicts,
  touchedFilesContext,
  type OwnedTask,
  type TouchedTask
} from './ownership';

function task(id: string, expectedFiles: string[], dependsOn: string[] = [], title = id): OwnedTask {
  return { id, title, expectedFiles, dependsOn };
}

test('paths are compared repo-relative, slash-normalised and case-insensitively', () => {
  assert.equal(normalizeOwnedPath('.\\src\\Api.ts'), 'src/api.ts');
  assert.equal(normalizeOwnedPath('./src//api.ts'), 'src/api.ts');
  const claims = fileClaims([task('t1', ['src/api.ts']), task('t2', ['.\\SRC\\API.ts'])]);
  assert.deepEqual(claims.get('src/api.ts')?.map((entry) => entry.id), ['t1', 't2']);
});

test('a task listing the same file twice does not collide with itself', () => {
  const conflicts = detectConflicts([task('t1', ['src/a.ts', 'src/a.ts'])]);
  assert.deepEqual(conflicts, []);
});

test('no shared file means no conflict and no touched dependsOn', () => {
  const tasks = [task('t1', ['src/a.ts']), task('t2', ['src/b.ts'])];
  const result = serialiseConflicts(tasks);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.tasks.map((entry) => entry.dependsOn), [[], []]);
});

test('two tasks claiming one file are serialised in plan order', () => {
  const result = serialiseConflicts([task('t1', ['src/a.ts']), task('t2', ['src/a.ts'])]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].taskIds, ['t1', 't2']);
  assert.deepEqual(result.tasks[1].dependsOn, ['t1']);
  assert.match(result.notes[0], /t1 then t2/);
});

test('three claimants chain one way only, in list order', () => {
  const result = serialiseConflicts([
    task('t1', ['src/a.ts']),
    task('t2', ['src/a.ts']),
    task('t3', ['src/a.ts'])
  ]);
  assert.deepEqual(result.tasks.map((entry) => entry.dependsOn), [[], ['t1'], ['t2']]);
});

test('the input array is never mutated', () => {
  const tasks = [task('t1', ['src/a.ts']), task('t2', ['src/a.ts'])];
  serialiseConflicts(tasks);
  assert.deepEqual(tasks[1].dependsOn, []);
});

test('only one of two colliding tasks is runnable at a time', () => {
  const result = serialiseConflicts([task('t1', ['src/a.ts']), task('t2', ['src/a.ts'])]);
  const scheduled = result.tasks.map((entry) => ({ ...entry, status: 'pending' }));
  assert.equal(nextRunnable(scheduled)?.id, 't1');
  scheduled[0].status = 'passed';
  assert.equal(nextRunnable(scheduled)?.id, 't2');
});

test('an edge that would close a cycle is refused and reported instead of corrupting the plan', () => {
  // t1 already depends on t2, so t2 cannot also depend on t1.
  const result = serialiseConflicts([
    task('t1', ['src/a.ts'], ['t2']),
    task('t2', ['src/a.ts'])
  ]);
  assert.deepEqual(result.tasks[1].dependsOn, []);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /neither order is possible/);
});

test('a duplicate dependency is not added twice', () => {
  const result = serialiseConflicts([
    task('t1', ['src/a.ts']),
    task('t2', ['src/a.ts'], ['t1'])
  ]);
  assert.deepEqual(result.tasks[1].dependsOn, ['t1']);
});

test('the conflict summary names the files, not the tasks', () => {
  const conflicts = detectConflicts([
    task('t1', ['src/a.ts', 'src/b.ts']),
    task('t2', ['src/a.ts', 'src/b.ts'])
  ]);
  assert.match(conflictSummary(conflicts), /^2 files claimed by more than one task: src\/a\.ts, src\/b\.ts/);
  assert.equal(conflictSummary([]), '');
});

function touched(overrides: Partial<TouchedTask> & { id: string }): TouchedTask {
  return { status: 'passed', assignee: 'backend', ...overrides };
}

test('the touched-file context says what changed, what is held back, and by whom', () => {
  const context = touchedFilesContext([
    touched({ id: 't1', touchedFiles: ['src/api.ts'], summary: 'Added the POST route.' }),
    touched({ id: 't2', assignee: 'frontend', touchedFiles: ['src/ui.tsx'], pendingReview: ['src/form.tsx'] })
  ], 't3');
  assert.match(context, /t1 \(backend\) changed src\/api\.ts — Added the POST route\./);
  assert.match(context, /t2 \(frontend\) changed src\/ui\.tsx; awaiting review: src\/form\.tsx/);
  assert.doesNotMatch(context, /t3/);
});

test('a task that changed nothing contributes no line', () => {
  assert.equal(touchedFilesContext([touched({ id: 't1', touchedFiles: [] })]), '');
});

test('a pending task is not described as something that already happened', () => {
  const context = touchedFilesContext([{ id: 't1', status: 'pending', touchedFiles: ['src/a.ts'] }]);
  assert.equal(context, '');
});

test('long file lists are counted, not dumped', () => {
  const many = Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`);
  const context = touchedFilesContext([touched({ id: 't1', touchedFiles: many })]);
  assert.match(context, /\(\+6 more\)/);
  assert.ok(context.length < 950, `context stayed bounded: ${context.length}`);
});
