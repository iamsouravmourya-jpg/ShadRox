import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvedSharedModel,
  manualModelAllowed,
  roleBudgetRupees,
  routeRequest,
  routeSharedTask,
  type SharedTaskClass
} from './modelRouter';
import { costRupees, isPriced } from './modelRates';

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

/**
 * The calibrated router's output reaches price-routing as an ordered preference
 * list. The ranking is a tie-break inside the budget, never a licence to spend
 * past it — a model the plan cannot afford stays unchosen however well it has
 * performed.
 */
const EDIT_KEY = [
  'openai/gpt-6-luna',
  'deepseek/deepseek-v4-flash',
  'qwen/qwen3-coder-next',
  'qwen/qwen3-coder-30b',
  'qwen/qwen3-coder-flash'
];
const EDIT_TURN = { inputTokens: 16_000, outputTokens: 1_200 };

test('with no preference list the cheapest model in the role still wins', () => {
  const plain = routeRequest('edit', EDIT_TURN, EDIT_KEY);
  assert.equal(plain.model, 'openai/gpt-6-luna');
  assert.equal(plain.rupees, 0.22);
  assert.equal(plain.withinBudget, true);
  assert.match(plain.reason, /^cheapest edit model inside ₹0\.42$/);
  assert.equal(routeRequest('edit', EDIT_TURN, EDIT_KEY, []).model, plain.model);
});

test('a verified model one rank above the cheapest is allowed to cost more, inside the budget', () => {
  const proven = routeRequest('edit', EDIT_TURN, EDIT_KEY, ['qwen/qwen3-coder-30b', 'openai/gpt-6-luna']);
  assert.equal(proven.model, 'qwen/qwen3-coder-30b');
  assert.equal(proven.withinBudget, true);
  assert.match(proven.reason, /best-proven edit model inside ₹0\.42 — ₹0\.31, ₹0\.09 above the cheapest/);
  // The budget ceiling came from plans.ts, never from this file's own numbers.
  assert.ok(proven.rupees <= roleBudgetRupees('edit'));
  assert.ok(costRupees(proven.model!, EDIT_TURN) <= roleBudgetRupees('edit'));
});

test('a preferred model the role budget cannot afford is never bought', () => {
  // Qwen3 Coder Flash is ₹0.43 for this turn and the edit budget is ₹0.42, so
  // the best record on the key still loses to price discipline.
  assert.ok(costRupees('qwen/qwen3-coder-flash', EDIT_TURN) > roleBudgetRupees('edit'));
  const route = routeRequest('edit', EDIT_TURN, EDIT_KEY, ['qwen/qwen3-coder-flash']);
  assert.equal(route.model, 'openai/gpt-6-luna');
  assert.equal(route.withinBudget, true);
  assert.match(route.reason, /^cheapest edit model inside ₹0\.42$/);
});

test('a preference naming a model that is not on the key changes nothing', () => {
  const absent = routeRequest('edit', EDIT_TURN, EDIT_KEY, ['anthropic/claude-opus-5.5', 'qwen/qwen3-coder-next']);
  assert.equal(absent.model, 'qwen/qwen3-coder-next');
  assert.match(absent.reason, /best-proven edit model/);
  assert.equal(routeRequest('edit', EDIT_TURN, EDIT_KEY, ['anthropic/claude-opus-5.5']).model, 'openai/gpt-6-luna');
});

test('the no-model-in-class fallback keeps taking the cheapest, ranked list or not', () => {
  const premiumKey = ['anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4-pro'];
  const fallback = routeRequest('edit', EDIT_TURN, premiumKey, ['anthropic/claude-sonnet-5.5']);
  assert.equal(fallback.model, 'deepseek/deepseek-v4-pro');
  assert.equal(fallback.withinBudget, false);
  assert.match(fallback.reason, /this key serves no edit-class model/);
});
