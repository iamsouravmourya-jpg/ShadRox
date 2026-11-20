import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTaskUpdates, completionGuard, type TaskPlan } from './taskPlan';

test('a task carries acceptance, evidence and files when given', () => {
  const { plan } = applyTaskUpdates([], { tasks: [{ id: 't', subject: 'build', status: 'doing', acceptance: 'typecheck passes', files: ['a.ts'] }] });
  assert.equal(plan[0].acceptance, 'typecheck passes');
  assert.deepEqual(plan[0].files, ['a.ts']);
});

test('a bare status flip keeps the {id, subject, status} shape (no empty keys)', () => {
  const { plan } = applyTaskUpdates([], { tasks: [{ id: 't', subject: 'build', status: 'doing' }] });
  assert.deepEqual(plan[0], { id: 't', subject: 'build', status: 'doing' });
});

test('a status flip preserves earlier acceptance and evidence', () => {
  let plan: TaskPlan = applyTaskUpdates([], { tasks: [{ id: 't', subject: 'build', status: 'doing', acceptance: 'tests pass', evidence: 'old' }] }).plan;
  plan = applyTaskUpdates(plan, { tasks: [{ id: 't', status: 'done' }] }).plan;
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[0].acceptance, 'tests pass');
  assert.equal(plan[0].evidence, 'old');
});

test('acceptance aliases are understood', () => {
  const { plan } = applyTaskUpdates([], { tasks: [{ subject: 'a', acceptance_criteria: 'c1' }, { subject: 'b', done_when: 'c2' }] });
  assert.equal(plan[0].acceptance, 'c1');
  assert.equal(plan[1].acceptance, 'c2');
});

test('a done task with acceptance but no evidence is challenged by the guard', () => {
  const plan: TaskPlan = [{ id: 't', subject: 'build the page', status: 'done', acceptance: 'preview renders' }];
  const warning = completionGuard(plan, true);
  assert.ok(warning);
  assert.match(warning, /Marked done without evidence/);
  assert.match(warning, /preview renders/);
  assert.match(warning, /evidence/);
});

test('evidence satisfies the acceptance guard', () => {
  const plan: TaskPlan = [{ id: 't', subject: 'build', status: 'done', acceptance: 'tests pass', evidence: 'verify: OK' }];
  assert.equal(completionGuard(plan, true), null);
});

test('a done task without acceptance needs no evidence', () => {
  const plan: TaskPlan = [{ id: 't', subject: 'read a.ts', status: 'done' }];
  assert.equal(completionGuard(plan, true), null);
});

test('open blockers and unproven done tasks both appear in the guard', () => {
  const plan: TaskPlan = [
    { id: 'a', subject: 'open one', status: 'doing' },
    { id: 'b', subject: 'claimed done', status: 'done', acceptance: 'it works' }
  ];
  const warning = completionGuard(plan, true)!;
  assert.match(warning, /Your task list is not finished/);
  assert.match(warning, /Marked done without evidence/);
});

test('the guard is silent when not finishing', () => {
  const plan: TaskPlan = [{ id: 't', subject: 'x', status: 'done', acceptance: 'y' }];
  assert.equal(completionGuard(plan, false), null);
});