import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedSharedModel, manualModelAllowed, routeSharedTask, type SharedTaskClass } from './modelRouter';
import { isPriced } from './modelRates';

const split = { inputTokens: 25_000, outputTokens: 600 };

test('the shared stack is the approved exact IDs, not a family substitute', () => {
  assert.equal(approvedSharedModel('starter', 'localized-edit'), 'z-ai/glm-4.7-flash');
  assert.equal(approvedSharedModel('starter', 'file-selection'), 'amazon/nova-micro-v1');
  assert.equal(approvedSharedModel('starter', 'chat'), 'google/gemini-2.5-flash-lite');
});

test("Heavy's value and main writers differ, and Starter is not offered Heavy's", () => {
  const heavyValue = approvedSharedModel('heavy', 'localized-edit');
  const heavyMain = approvedSharedModel('heavy', 'multi-file');
  assert.equal(heavyValue, 'qwen/qwen3-coder-next');
  assert.equal(heavyMain, 'qwen/qwen3-coder-flash');
  assert.notEqual(heavyValue, heavyMain);
  // Starter keeps GLM for both, per the approved matrix.
  assert.equal(approvedSharedModel('starter', 'multi-file'), 'z-ai/glm-4.7-flash');
});

test('premium escalation is Heavy-only', () => {
  assert.equal(approvedSharedModel('heavy', 'premium'), 'deepseek/deepseek-v4-pro');
  assert.equal(approvedSharedModel('starter', 'premium'), null);
});

test('every approved shared model is priced in the registry', () => {
  const classes: SharedTaskClass[] = [
    'file-selection',
    'chat',
    'completion',
    'localized-edit',
    'multi-file',
    'refactor-escalation',
    'premium'
  ];
  for (const plan of ['starter', 'heavy'] as const) {
    for (const taskClass of classes) {
      const model = approvedSharedModel(plan, taskClass);
      if (model) assert.ok(isPriced(model), `${model} must have a rate`);
    }
  }
});

test('routing a shared task never substitutes a model the plan did not approve', () => {
  const none = routeSharedTask({ plan: 'starter', taskClass: 'premium', tokens: split });
  assert.equal(none.model, null);
  assert.equal(none.withinBudget, false);
  assert.match(none.reason, /no approved premium model/);

  // Nothing in the product can produce a plan key: the matrix is only ever
  // reachable from an operator-run shared key, and a class with no approved
  // model returns null instead of a substitute.
  assert.equal(approvedSharedModel('heavy', 'file-selection'), 'amazon/nova-micro-v1');
});

test('a shared route reports the approved model and its budget fit', () => {
  const route = routeSharedTask({ plan: 'heavy', taskClass: 'localized-edit', tokens: split });
  assert.equal(route.model, 'qwen/qwen3-coder-next');
  assert.equal(route.role, 'edit');
  assert.ok(route.rupees > 0);
  assert.equal(route.reason.includes('approved localized-edit model'), true);
});

test('manual model choice is BYOK-only', () => {
  assert.equal(manualModelAllowed('byok'), true);
  assert.equal(manualModelAllowed('shared'), false);
});
