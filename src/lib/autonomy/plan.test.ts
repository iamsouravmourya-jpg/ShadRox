import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlannerPrompt,
  coalesceSingleFileMilestones,
  computeElasticRunBudget,
  consolidateSmallTaskMilestones,
  createPlanGoal,
  isSafeRelativePath,
  parsePlanReply,
  selectPrioritizedWorkspaceFiles,
  validatePlan
} from './plan';
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

test('buildPlannerPrompt tolerates an empty workspace and includes single-file grouping guidance', () => {
  const prompt = buildPlannerPrompt('goal', [], BUDGET);
  assert.match(prompt, /no files yet/);
  assert.match(prompt, /1-2 structured milestones/);
});

test('coalesceSingleFileMilestones groups fragmented UI section updates targeting one existing file into 1-2 structured milestones', async () => {
  const raw = JSON.stringify([
    { id: 'm1', title: 'Setup theme CSS', instruction: 'update styles', expectedFiles: ['src/index.css'], dependsOn: [] },
    { id: 'm2', title: 'Add Hero section', instruction: 'build hero', expectedFiles: ['src/App.jsx'], dependsOn: ['m1'] },
    { id: 'm3', title: 'Add Features grid', instruction: 'build features', expectedFiles: ['src/App.jsx'], dependsOn: ['m2'] },
    { id: 'm4', title: 'Add Stats strip', instruction: 'build stats', expectedFiles: ['src/App.jsx'], dependsOn: ['m3'] },
    { id: 'm5', title: 'Add Pricing cards', instruction: 'build pricing', expectedFiles: ['src/App.jsx'], dependsOn: ['m4'] },
    { id: 'm6', title: 'Add Testimonials', instruction: 'build reviews', expectedFiles: ['src/App.jsx'], dependsOn: ['m5'] },
    { id: 'm7', title: 'Add Footer', instruction: 'build footer', expectedFiles: ['src/App.jsx'], dependsOn: ['m6'] },
    { id: 'm8', title: 'Verify build', instruction: 'check bundle', expectedFiles: ['package.json'], dependsOn: ['m7'], verifyCommand: 'npm run build' }
  ]);
  const planGoal = createPlanGoal(async () => raw);
  const parsed = await planGoal('Redesign landing page', ['src/index.css', 'src/App.jsx', 'package.json'], BUDGET);
  assert.equal(parsed.errors.length, 0);
  // m2..m7 (6 milestones all on src/App.jsx) coalesce into 2 structured milestones, preserving m1 and m8.
  assert.equal(parsed.milestones.length, 4);
  assert.deepEqual(parsed.milestones.map((m) => m.id), ['m1', 'm2', 'm5', 'm8']);
  assert.deepEqual(parsed.milestones[1].dependsOn, ['m1']);
  assert.deepEqual(parsed.milestones[2].dependsOn, ['m2']);
  assert.deepEqual(parsed.milestones[3].dependsOn, ['m5']);
  assert.deepEqual(validatePlan(parsed.milestones, ['src/index.css', 'src/App.jsx', 'package.json'], BUDGET), []);

  // 3-4 fragmented milestones on one existing file coalesce into a single milestone.
  const fourSingle = coalesceSingleFileMilestones(
    [
      milestone({ id: 'a1', title: 'Hero', expectedFiles: ['src/App.jsx'], dependsOn: [] }),
      milestone({ id: 'a2', title: 'Body', expectedFiles: ['src/App.jsx'], dependsOn: ['a1'] }),
      milestone({ id: 'a3', title: 'Footer', expectedFiles: ['src/App.jsx'], dependsOn: ['a2'] })
    ],
    ['src/App.jsx']
  );
  assert.equal(fourSingle.length, 1);
  assert.match(fourSingle[0].instruction, /Hero[\s\S]*Body[\s\S]*Footer/);
});

test('selectPrioritizedWorkspaceFiles preserves explicit targets, root manifests, and stratified dirs past 400 files', () => {
  const manySrc = Array.from({ length: 650 }, (_, i) => `src/generated/file${i}.ts`);
  const all = [
    ...manySrc,
    'package.json',
    'electron/main.cjs',
    'landing/index.html',
    'api/ai/_endpoint.ts'
  ];
  const selected = selectPrioritizedWorkspaceFiles(
    'Update api/ai/_endpoint.ts and landing/index.html plus electron/main.cjs',
    all,
    100
  );
  assert.equal(selected.length, 100);
  assert.ok(selected.includes('api/ai/_endpoint.ts'));
  assert.ok(selected.includes('landing/index.html'));
  assert.ok(selected.includes('electron/main.cjs'));
  assert.ok(selected.includes('package.json'));
});

test('computeElasticRunBudget scales budgets for multi-workstream prompts without shrinking small runs', () => {
  assert.deepEqual(computeElasticRunBudget('Fix button color in src/App.tsx', BUDGET), BUDGET);
  const mega = Array.from({ length: 12 }, (_, i) => `${i + 1}. Update file${i}.ts behavior`).join('\n');
  const scaled = computeElasticRunBudget(mega, BUDGET);
  assert.ok(scaled.maxMilestones > BUDGET.maxMilestones);
  assert.ok(scaled.maxTurns > BUDGET.maxTurns);
  assert.ok(scaled.maxToolCalls >= BUDGET.maxToolCalls);
});

test('createPlanGoal retries once when validation fails and repairs the plan', async () => {
  const prompts: string[] = [];
  let call = 0;
  const planGoal = createPlanGoal(async (prompt) => {
    prompts.push(prompt);
    call += 1;
    if (call === 1) {
      return JSON.stringify([
        { id: 'm1', title: 'Bad dep', instruction: 'do', expectedFiles: ['src/a.ts'], dependsOn: ['missing'] }
      ]);
    }
    return JSON.stringify([
      { id: 'm1', title: 'Good plan', instruction: 'do', expectedFiles: ['src/a.ts'], dependsOn: [] }
    ]);
  });
  const result = await planGoal('Fix src/a.ts', ['src/a.ts'], BUDGET);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /PREVIOUS PLAN FAILED VALIDATION/);
  assert.equal(result.errors.length, 0);
  assert.equal(result.milestones[0].title, 'Good plan');
});

test('consolidateSmallTaskMilestones compresses bloated <=2-file plans to at most 3 milestones with valid dependencies', async () => {
  const bloated = [
    milestone({ id: 'm1', title: 'Inspect files', instruction: 'Read files', expectedFiles: [], dependsOn: [], category: 'read_only' }),
    milestone({ id: 'm2', title: 'Step 1', instruction: 'Edit header', expectedFiles: ['src/App.tsx'], dependsOn: ['m1'], category: 'file_mutation' }),
    milestone({ id: 'm3', title: 'Step 2', instruction: 'Edit footer', expectedFiles: ['src/App.tsx'], dependsOn: ['m2'], category: 'file_mutation' }),
    milestone({ id: 'm4', title: 'Step 3', instruction: 'Add styles', expectedFiles: ['src/App.css'], dependsOn: ['m3'], category: 'file_mutation' }),
    milestone({ id: 'm5', title: 'Verify', instruction: 'Run build check', expectedFiles: ['src/App.tsx'], dependsOn: ['m4'], verifyCommand: 'npm run build' })
  ];
  const consolidated = consolidateSmallTaskMilestones(bloated, 'Update App header, footer, and styles');
  assert.ok(consolidated.length <= 3, `expected <= 3 milestones, got ${consolidated.length}`);
  assert.deepEqual(validatePlan(consolidated, ['src/App.tsx', 'src/App.css'], BUDGET), []);

  const planGoal = createPlanGoal(async () => JSON.stringify(bloated));
  const planned = await planGoal('Update App header, footer, and styles', ['src/App.tsx', 'src/App.css'], BUDGET);
  assert.equal(planned.errors.length, 0);
  assert.ok(planned.milestones.length <= 3);
  assert.equal(planned.milestones[0].category, 'read_only');
});

