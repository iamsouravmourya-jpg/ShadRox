import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTeamPlannerPrompt, createTeamPlan, parseTeamPlan, validateTeamPlan } from './plan';
import { SPECIALIST_ROLES } from './roles';
import { DEFAULT_TEAM_BUDGET, type TeamTask } from './types';

/** A task that passes validation, so a test only changes what it is testing. */
function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    title: 'add a route',
    instruction: 'expose POST /x',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    assignee: 'backend',
    status: 'pending',
    attempts: 0,
    lastReport: null,
    report: '',
    patchesApplied: 0,
    patchFailures: [],
    creditsSpent: 0,
    ...overrides
  };
}

test('parseTeamPlan reads a bare JSON array into normalized tasks', () => {
  const plan = parseTeamPlan('[{"id":"t1","title":"a","instruction":"do a","assignee":"frontend"}]');
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.tasks[0].expectedFiles, []);
  assert.equal(plan.tasks[0].status, 'pending');
  assert.equal(plan.tasks[0].attempts, 0);
  assert.equal(plan.tasks[0].lastReport, null);
});

test('parseTeamPlan reads an array wrapped in prose', () => {
  const plan = parseTeamPlan('Here is the plan:\n[{"id":"t1","title":"a","assignee":"tests"}]\nThat is all.');
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.tasks.length, 1);
});

test('a reply with no JSON is an unparseable error, never an invented task', () => {
  const plan = parseTeamPlan('I could not plan this.');
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.errors[0].reason, 'unparseable');
  assert.equal(plan.errors[0].milestoneId, null);
});

test('invalid JSON is reported, not thrown', () => {
  const plan = parseTeamPlan('[{"id": }]');
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.errors[0].reason, 'unparseable');
});

test('a JSON object wrapping the array is read as that array', () => {
  const plan = parseTeamPlan('{"tasks":[{"id":"t1","title":"a","assignee":"backend"}]}');
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.tasks.length, 1);
});

test('a reply with JSON but no array is unparseable', () => {
  const plan = parseTeamPlan('{"tasks":{"a":1}}');
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.errors[0].reason, 'unparseable');
});

test('the normalizer fills missing fields and derives a title from description', () => {
  const plan = parseTeamPlan('[{"description":"fix the bug","assignee":"reviewer"}]');
  const [first] = plan.tasks;
  assert.equal(first.id, 't1');
  assert.equal(first.title, 'fix the bug');
  assert.equal(first.instruction, 'fix the bug');
});

test('an empty plan is rejected', () => {
  const errors = validateTeamPlan([], DEFAULT_TEAM_BUDGET);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'empty');
});

test('a plan over the task cap is rejected', () => {
  const tasks = Array.from({ length: DEFAULT_TEAM_BUDGET.maxTasks + 1 }, (_, index) => task({ id: `t${index}` }));
  const errors = validateTeamPlan(tasks, DEFAULT_TEAM_BUDGET);
  assert.equal(errors.some((error) => error.reason === 'too-many'), true);
});

test('duplicate ids are reported', () => {
  const errors = validateTeamPlan([task({ id: 't1' }), task({ id: 't1' })], DEFAULT_TEAM_BUDGET);
  assert.equal(errors.some((error) => error.reason === 'duplicate-id'), true);
});

test('a blank title or instruction is reported', () => {
  const errors = validateTeamPlan([task({ title: '', instruction: '' })], DEFAULT_TEAM_BUDGET);
  assert.equal(errors.some((error) => error.reason === 'blank-field'), true);
});

test('a task assigned to nobody or to the coordinator is rejected — the check unique to teams', () => {
  const nobody = validateTeamPlan([task({ assignee: '' as TeamTask['assignee'] })], DEFAULT_TEAM_BUDGET);
  assert.equal(nobody.some((error) => error.reason === 'unknown-assignee'), true);

  const coordinator = validateTeamPlan([task({ assignee: 'coordinator' as TeamTask['assignee'] })], DEFAULT_TEAM_BUDGET);
  assert.equal(coordinator.some((error) => error.reason === 'unknown-assignee'), true);
});

test('a path outside the workspace is reported', () => {
  const errors = validateTeamPlan([task({ expectedFiles: ['../secrets.env'] })], DEFAULT_TEAM_BUDGET);
  assert.equal(errors.some((error) => error.reason === 'bad-path'), true);
});

test('a dependency on an id that is not in the plan is reported', () => {
  const errors = validateTeamPlan([task({ dependsOn: ['ghost'] })], DEFAULT_TEAM_BUDGET);
  assert.equal(errors.some((error) => error.reason === 'unknown-dependency'), true);
});

test('a dependency cycle is reported', () => {
  const errors = validateTeamPlan(
    [task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })],
    DEFAULT_TEAM_BUDGET
  );
  assert.equal(errors.some((error) => error.reason === 'cycle'), true);
});

test('a valid plan has no errors', () => {
  const errors = validateTeamPlan(
    [task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'], assignee: 'tests' })],
    DEFAULT_TEAM_BUDGET
  );
  assert.deepEqual(errors, []);
});

test('the planner prompt names every specialist and the live task cap', () => {
  const prompt = buildTeamPlannerPrompt('build a thing', ['src/a.ts'], { ...DEFAULT_TEAM_BUDGET, maxTasks: 3 });
  for (const role of SPECIALIST_ROLES) assert.match(prompt, new RegExp(role));
  assert.match(prompt, /at most 3 tasks/);
  assert.match(prompt, /build a thing/);
  assert.match(prompt, /src\/a\.ts/);
});

test('createTeamPlan hands the prompt to askPlan and parses its answer', async () => {
  let seen = '';
  const planTeam = createTeamPlan(async (prompt) => {
    seen = prompt;
    return '[{"id":"t1","title":"a","assignee":"backend"}]';
  });
  const plan = await planTeam('goal', ['src/a.ts'], DEFAULT_TEAM_BUDGET);
  assert.match(seen, /goal/);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.errors.length, 0);
});
