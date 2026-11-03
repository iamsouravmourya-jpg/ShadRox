import assert from 'node:assert/strict';
import test from 'node:test';

import { dependenciesSatisfied, dependenciesUnsatisfiable, findBlocked, findCycles, nextRunnable } from './dag';
import type { Milestone, MilestoneStatus } from './types';

function milestone(id: string, dependsOn: string[] = [], status: MilestoneStatus = 'pending'): Milestone {
  return { id, title: `${id} title`, instruction: `do ${id}`, expectedFiles: [], dependsOn, status, attempts: [] };
}

test('nextRunnable returns the first pending milestone whose dependencies passed', () => {
  const list = [milestone('m1', [], 'passed'), milestone('m2', ['m1']), milestone('m3', ['m2'])];
  assert.equal(nextRunnable(list)?.id, 'm2');
});

test('nextRunnable skips a pending milestone whose dependency has not passed', () => {
  const list = [milestone('m1'), milestone('m2', ['m1'])];
  assert.equal(nextRunnable(list)?.id, 'm1');
  assert.equal(dependenciesSatisfied(list[1], list), false);
});

test('nextRunnable returns null when nothing is runnable', () => {
  const list = [milestone('m1', [], 'passed'), milestone('m2', ['m1'], 'passed')];
  assert.equal(nextRunnable(list), null);
});

test('findBlocked reports pending milestones behind a failed or blocked dependency', () => {
  const list = [milestone('m1', [], 'failed'), milestone('m2', ['m1']), milestone('m3', ['m2'])];
  const blocked = findBlocked(list).map((m) => m.id);
  assert.deepEqual(blocked, ['m2']);
  assert.equal(dependenciesUnsatisfiable(list[2], list), false, 'a dependency that is merely pending is not unsatisfiable yet');
});

test('findCycles names every milestone in the cycle, and is empty for a DAG', () => {
  assert.deepEqual(findCycles([milestone('m1'), milestone('m2', ['m1'])]), []);
  const cyclic = findCycles([milestone('m1', ['m3']), milestone('m2', ['m1']), milestone('m3', ['m2'])]);
  assert.deepEqual([...cyclic].sort(), ['m1', 'm2', 'm3']);
});
