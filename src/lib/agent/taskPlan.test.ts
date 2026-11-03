import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTaskUpdates,
  completionGuard,
  openTasks,
  renderTaskPlan,
  type TaskPlan
} from './taskPlan';

const started: TaskPlan = [
  { id: 'read-folder', subject: 'read the folder', status: 'done' },
  { id: 'add-export', subject: 'add the export', status: 'doing' },
  { id: 'update-tests', subject: 'update tests', status: 'pending' }
];

test('a tasks array becomes the plan', () => {
  const result = applyTaskUpdates([], {
    tasks: [
      { id: '1', subject: 'read the folder', status: 'done' },
      { id: '2', subject: 'add the export', status: 'pending' }
    ]
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.plan, [
    { id: '1', subject: 'read the folder', status: 'done' },
    { id: '2', subject: 'add the export', status: 'pending' }
  ]);
});

test('the statuses the model really writes are aliased', () => {
  const { plan } = applyTaskUpdates([], {
    tasks: [
      { subject: 'a', status: 'IN_PROGRESS' },
      { subject: 'b', status: 'completed' },
      { subject: 'c', status: 'stuck' },
      { subject: 'd', status: 'todo' }
    ]
  });
  assert.deepEqual(plan.map((item) => item.status), ['doing', 'done', 'blocked', 'pending']);
});

test('a list of bare strings becomes pending tasks with stable ids', () => {
  const { plan, error } = applyTaskUpdates([], ['read the folder', 'add the export']);
  assert.equal(error, null);
  assert.deepEqual(plan, [
    { id: 'read-the-folder', subject: 'read the folder', status: 'pending' },
    { id: 'add-the-export', subject: 'add the export', status: 'pending' }
  ]);
});

test('an id plus a status updates a task without restating its subject', () => {
  const { plan, error } = applyTaskUpdates(started, { tasks: [{ id: 'update-tests', status: 'done' }] });
  assert.equal(error, null);
  assert.deepEqual(plan[2], { id: 'update-tests', subject: 'update tests', status: 'done' });
});

test('the same id twice in one batch stays one item and the last write wins', () => {
  const { plan } = applyTaskUpdates(started, {
    tasks: [
      { id: 'add-export', status: 'blocked' },
      { id: 'add-export', subject: 'add the csv export', status: 'done' }
    ]
  });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[1], { id: 'add-export', subject: 'add the csv export', status: 'done' });
});

test('an unknown status is forgiven and reported in one line', () => {
  const { plan, error } = applyTaskUpdates(started, { tasks: [{ subject: 'add the export', status: 'exploring' }] });
  assert.equal(plan[1].status, 'doing');
  assert.equal(plan.length, 3);
  assert.match(error as string, /not understood/);
  assert.match(error as string, /pending, doing, done or blocked/);
});

test('a new task with an unreadable status starts pending', () => {
  const { plan } = applyTaskUpdates([], { tasks: [{ subject: 'write the docs', status: 'halfway' }] });
  assert.deepEqual(plan, [{ id: 'write-the-docs', subject: 'write the docs', status: 'pending' }]);
});

test('unusable entries are dropped while the usable ones still land', () => {
  const { plan, error } = applyTaskUpdates([], { tasks: [7, null, [], { status: 'done' }, { subject: 'real task' }] });
  assert.deepEqual(plan, [{ id: 'real-task', subject: 'real task', status: 'pending' }]);
  assert.match(error as string, /4 entries were unusable/);
});

test('a payload that holds no task list is refused, not thrown', () => {
  for (const junk of [null, undefined, 42, true, {}, { nope: 1 }, '{"tasks":[{"subject"', '']) {
    const result = applyTaskUpdates(started, junk);
    assert.deepEqual(result.plan, started);
    assert.match(result.error as string, /update_tasks expects/);
  }
});

test('nothing usable at all keeps the previous plan and says so', () => {
  const { plan, error } = applyTaskUpdates(started, { tasks: [null, 3] });
  assert.deepEqual(plan, started);
  assert.match(error as string, /unusable/);
});

test('a re-emitted subject updates the item instead of duplicating it', () => {
  const { plan, error } = applyTaskUpdates(started, { tasks: [{ subject: 'Update Tests', status: 'done' }] });
  assert.equal(error, null);
  assert.equal(plan.length, 3);
  assert.equal(plan[2].status, 'done');
});

test('updated items keep their position and new items append', () => {
  const { plan } = applyTaskUpdates(started, {
    tasks: [
      { id: 'add-export', status: 'done' },
      { id: 'write-docs', subject: 'write the docs', status: 'doing' }
    ]
  });
  assert.deepEqual(plan.map((item) => item.id), ['read-folder', 'add-export', 'update-tests', 'write-docs']);
  assert.deepEqual(plan.map((item) => item.status), ['done', 'done', 'pending', 'doing']);
});

test('the previous plan is never mutated', () => {
  const before = structuredClone(started);
  applyTaskUpdates(started, { tasks: [{ id: 'add-export', status: 'blocked' }] });
  assert.deepEqual(started, before);
});

test('a long subject is clipped so the plan stays compact', () => {
  const { plan } = applyTaskUpdates([], { tasks: [{ subject: 'x'.repeat(500) }] });
  assert.ok(plan[0].subject.length <= 140);
});

test('the rendered plan uses the four markers and skips blank subjects', () => {
  const rendered = renderTaskPlan([
    { id: '1', subject: 'read the folder', status: 'done' },
    { id: '2', subject: 'add the export', status: 'doing' },
    { id: '3', subject: 'update tests', status: 'pending' },
    { id: '4', subject: 'ship it', status: 'blocked' },
    { id: '5', subject: '   ', status: 'pending' }
  ]);
  assert.equal(rendered, '[x] read the folder  [>] add the export  [ ] update tests  [!] ship it');
  assert.equal(renderTaskPlan([]), '');
});

test('open tasks are everything not done, blocked included', () => {
  assert.deepEqual(openTasks(started).map((item) => item.id), ['add-export', 'update-tests']);
  assert.deepEqual(openTasks([{ id: 'a', subject: 'a', status: 'blocked' }]).length, 1);
});

test('an all-done plan lets the model finish', () => {
  const done: TaskPlan = [{ id: 'a', subject: 'a', status: 'done' }];
  assert.equal(completionGuard(done, true), null);
});

test('a blocked plan lets the model finish too, since blocking is the escape hatch', () => {
  const blocked: TaskPlan = [
    { id: 'a', subject: 'a', status: 'done' },
    { id: 'b', subject: 'wait on the missing key', status: 'blocked' }
  ];
  assert.equal(completionGuard(blocked, true), null);
});

test('finishing without finishing the work is refused by name', () => {
  const message = completionGuard(started, true) as string;
  assert.match(message, /"add the export" \(doing\)/);
  assert.match(message, /"update tests" \(pending\)/);
  assert.doesNotMatch(message, /read the folder" \(done\)/);
  assert.match(message, /mark each one done/);
  assert.match(message, /blocked/);
  assert.match(message, /\[x\] read the folder/);
});

test('the guard stays quiet while the turn is still running', () => {
  assert.equal(completionGuard(started, false), null);
  assert.equal(completionGuard([], true), null);
});
