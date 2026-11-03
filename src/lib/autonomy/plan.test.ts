import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPlannerPrompt, createPlanGoal, isSafeRelativePath, parsePlanReply, validatePlan } from './plan';
import { DEFAULT_RUN_BUDGET, type Milestone, type PlanError, type RunBudget } from './types';

const BUDGET: RunBudget = DEFAULT_RUN_BUDGET;

function reason(errors: PlanError[], wanted: PlanError['reason']): PlanError | undefined {
  return errors.find((error) => error.reason === wanted);
}

function milestone(overrides: Partial<Milestone>): Milestone {
  return {
    id: 'm1',
    title: 'a title',
    instruction: 'do it',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    status: 'pending',
    attempts: [],
    ...overrides
  };
}

test('parsePlanReply reads a fenced JSON array and assigns ids when the model omits them', () => {
  const reply = 'Here you go:\n```json\n[{"title":"a","instruction":"do a"},{"id":"x","title":"b","instruction":"do b"}]\n```';
  const { milestones, errors } = parsePlanReply(reply);
  assert.deepEqual(errors, []);
  assert.deepEqual(milestones.map((m) => m.id), ['m1', 'x']);
  assert.equal(milestones[0].instruction, 'do a');
});

test('parsePlanReply never invents a milestone from an unreadable reply', () => {
  const { milestones, errors } = parsePlanReply('I will now write some code.');
  assert.deepEqual(milestones, []);
  assert.equal(errors[0].reason, 'unparseable');

  const broken = parsePlanReply('[{"title": "a",}]');
  assert.deepEqual(broken.milestones, []);
  assert.equal(broken.errors[0].reason, 'unparseable');
});

test('validatePlan flags an empty plan and an oversized plan', () => {
  assert.equal(reason(validatePlan([], ['src/a.ts'], BUDGET), 'empty')?.reason, 'empty');
  const many = Array.from({ length: BUDGET.maxMilestones + 1 }, (_, i) => milestone({ id: `m${i}` }));
  assert.ok(reason(validatePlan(many, [], BUDGET), 'too-many'));
});

test('validatePlan flags duplicate ids, blank fields and unknown dependencies', () => {
  const errors = validatePlan(
    [milestone({ id: 'dup' }), milestone({ id: 'dup', title: '', instruction: '', dependsOn: ['ghost'] })],
    ['src/a.ts'],
    BUDGET
  );
  assert.ok(reason(errors, 'duplicate-id'));
  assert.ok(reason(errors, 'blank-field'));
  assert.ok(reason(errors, 'unknown-dependency'));
});

test('validatePlan refuses a path outside the workspace before anything runs', () => {
  const errors = validatePlan([milestone({ expectedFiles: ['/etc/passwd'] })], ['src/a.ts'], BUDGET);
  const bad = reason(errors, 'bad-path');
  assert.ok(bad, 'absolute paths are rejected');
  assert.match(bad?.message ?? '', /outside the workspace: \/etc\/passwd/);
});

test('validatePlan refuses a dependency cycle', () => {
  const errors = validatePlan(
    [milestone({ id: 'm1', dependsOn: ['m2'] }), milestone({ id: 'm2', dependsOn: ['m1'] })],
    [],
    BUDGET
  );
  assert.ok(reason(errors, 'cycle'));
});

test('isSafeRelativePath accepts workspace paths and rejects escapes', () => {
  assert.equal(isSafeRelativePath('src/lib/a.ts'), true);
  assert.equal(isSafeRelativePath('a\\b\\c.ts'), true);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:\\Windows\\system32'), false);
  assert.equal(isSafeRelativePath('../../secrets.env'), false);
  assert.equal(isSafeRelativePath(''), false);
});

test('createPlanGoal hands the model the goal and the run constraints, and parses the reply', async () => {
  let seenPrompt = '';
  const planGoal = createPlanGoal(async (prompt) => {
    seenPrompt = prompt;
    return '[{"id":"m1","title":"t","instruction":"i","expectedFiles":["src/a.ts"]}]';
  });
  const planned = await planGoal('add a hello route', ['src/a.ts'], BUDGET);
  assert.match(seenPrompt, /add a hello route/);
  assert.match(seenPrompt, new RegExp(`at most ${BUDGET.maxMilestones} milestones`));
  assert.deepEqual(planned.milestones.map((m) => m.id), ['m1']);
  assert.deepEqual(planned.errors, []);
});

test('buildPlannerPrompt tolerates an empty workspace', () => {
  assert.match(buildPlannerPrompt('goal', [], BUDGET), /no files yet/);
});
