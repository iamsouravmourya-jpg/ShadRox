import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreditTracker } from '../autonomy/budget';
import { CREDIT_RATES } from '../plans';
import type { PlanError, TurnResult, TurnUnit, VerifiableUnit, VerificationReport } from '../autonomy/types';
import { runTeam, type TeamDeps } from './team-run';
import {
  DEFAULT_TEAM_BUDGET,
  type TeamBudget,
  type TeamEvent,
  type TeamPlan,
  type TeamPorts,
  type TeamState,
  type TeamTask
} from './types';

const PASSED: VerificationReport = { verdict: 'passed', diagnostics: [], notes: [] };
const FAILED: VerificationReport = {
  verdict: 'failed',
  diagnostics: [{ path: 'src/a.ts', line: 3, column: 1, message: "Cannot find name 'x'.", severity: 'error' }],
  notes: ['one type error']
};

/** A planned task, in the shape `planTeam` returns before the driver resets it. */
function plannedTask(overrides: Partial<TeamTask> = {}): TeamTask {
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

interface Harness {
  deps: TeamDeps;
  events: TeamEvent[];
  states: TeamState[];
  turns: { id: string; attempt: number; instruction: string; feedbackText?: string }[];
  checkpoints: () => number;
  validateCalls: () => number;
  setVerify: (fn: (unit: VerifiableUnit) => VerificationReport) => void;
  setTurn: (fn: (unit: TurnUnit, attempt: number) => TurnResult) => void;
  setValidate: (fn: () => PlanError[]) => void;
  cancelAfter: (count: number) => void;
  run: (goal: string) => Promise<TeamState>;
}

function harness(plan: TeamPlan, budget: TeamBudget = DEFAULT_TEAM_BUDGET): Harness {
  const events: TeamEvent[] = [];
  const states: TeamState[] = [];
  const turns: Harness['turns'] = [];
  let verifyImpl = (_unit: VerifiableUnit): VerificationReport => PASSED;
  let turnImpl = (_unit: TurnUnit, _attempt: number): TurnResult => ({
    reply: 'ok',
    patchesApplied: 1,
    patchFailures: [],
    creditsSpent: 1,
    aborted: false
  });
  let validateImpl = (): PlanError[] => [];
  let cancelAfterTurn = Infinity;
  let turnCount = 0;
  let checkpointCount = 0;
  let validateCount = 0;
  /** The port hands the loop a `TurnUnit`, which has no attempts array, so the
   *  fake counts them itself rather than reading them back off the request. */
  const attemptCounts = new Map<string, number>();

  const ports: TeamPorts = {
    runTurn: async (request) => {
      turnCount += 1;
      const attempt = (attemptCounts.get(request.milestone.id) ?? 0) + 1;
      attemptCounts.set(request.milestone.id, attempt);
      turns.push({
        id: request.milestone.id,
        attempt,
        instruction: request.milestone.instruction,
        feedbackText: request.feedbackText
      });
      return turnImpl(request.milestone, attempt);
    },
    verify: async (unit) => verifyImpl(unit),
    listFiles: () => ['src/a.ts'],
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => turnCount >= cancelAfterTurn
  };

  const deps: TeamDeps = {
    ports,
    budget,
    planTeam: async () => plan,
    validate: () => {
      validateCount += 1;
      return validateImpl();
    },
    tracker: createCreditTracker({ maxCredits: budget.maxCredits }),
    checkpoint: () => {
      checkpointCount += 1;
    },
    persist: (state) => states.push(state),
    now: () => 1000
  };

  return {
    deps,
    events,
    states,
    turns,
    checkpoints: () => checkpointCount,
    validateCalls: () => validateCount,
    setVerify: (fn) => {
      verifyImpl = fn;
    },
    setTurn: (fn) => {
      turnImpl = fn;
    },
    setValidate: (fn) => {
      validateImpl = fn;
    },
    cancelAfter: (count) => {
      cancelAfterTurn = count;
    },
    run: (goal) => runTeam(goal, deps)
  };
}

test('a planning error fails the team before any turn and never checkpoints', async () => {
  const h = harness({ tasks: [], errors: [{ milestoneId: null, reason: 'empty', message: 'the coordinator produced no tasks' }] });
  const state = await h.run('do a thing');
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /produced no tasks/);
  assert.equal(h.turns.length, 0);
  assert.equal(h.checkpoints(), 0);
  // A plan that already failed is not re-validated.
  assert.equal(h.validateCalls(), 0);
});

test('a clean parse is still validated, and a validation error fails the team', async () => {
  const h = harness({ tasks: [plannedTask({ assignee: 'coordinator' as TeamTask['assignee'] })], errors: [] });
  h.setValidate(() => [{ milestoneId: 't1', reason: 'unknown-assignee', message: 'assigned to nobody' }]);
  const state = await h.run('goal');
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /assigned to nobody/);
  assert.equal(h.turns.length, 0);
  assert.equal(h.validateCalls(), 1);
});

test('two independent tasks run, pass, and settle the credits', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2', assignee: 'tests' })], errors: [] });
  const state = await h.run('build it');
  assert.equal(state.status, 'done');
  assert.deepEqual(state.tasks.map((task) => task.status), ['passed', 'passed']);
  assert.equal(state.creditsSpent, 2);
  assert.equal(state.messages.length, 2);
  assert.equal(h.checkpoints(), 1);
  assert.equal(h.events.some((event) => event.type === 'team:planned'), true);
  assert.equal(h.events.at(-1)?.type, 'team:done');
});

test('review-held files and tool context survive into the team task state', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  h.setTurn(() => ({
    reply: 'Updated the file.',
    patchesApplied: 0,
    patchFailures: [],
    creditsSpent: 0.4,
    aborted: false,
    touchedFiles: [],
    filesRead: ['src/a.ts'],
    pendingReview: ['src/a.ts']
  }));
  const state = await h.run('goal');
  assert.deepEqual(state.tasks[0].filesRead, ['src/a.ts']);
  assert.deepEqual(state.tasks[0].pendingReview, ['src/a.ts']);
  assert.ok(h.events.some((event) => event.type === 'task:review' && event.paths[0] === 'src/a.ts'));
});

test('the instruction handed to the agent carries the role brief and shared context', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', expectedFiles: [] }), plannedTask({ id: 't2' })], errors: [] });
  h.setTurn((unit) => ({ reply: `reply for ${unit.id}`, patchesApplied: 0, patchFailures: [], creditsSpent: 1, aborted: false }));
  await h.run('goal');
  assert.match(h.turns[0].instruction, /Backend agent/);
  assert.doesNotMatch(h.turns[0].instruction, /WHAT THE OTHER AGENTS REPORTED/);
  assert.match(h.turns[1].instruction, /WHAT THE OTHER AGENTS REPORTED/);
  assert.match(h.turns[1].instruction, /reply for t1/);
});

test('a failed check is retried with a repair brief, and the retry can pass', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  let checks = 0;
  h.setVerify(() => (++checks === 1 ? FAILED : PASSED));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'passed');
  assert.equal(state.tasks[0].attempts, 2);
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[0].feedbackText, undefined);
  assert.match(h.turns[1].feedbackText ?? '', /repair attempt 2/);
  assert.match(h.turns[1].feedbackText ?? '', /Cannot find name 'x'/);
});

test('a task that never passes fails, and its dependent is blocked', async () => {
  const h = harness({
    tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2', dependsOn: ['t1'] })],
    errors: []
  });
  h.setVerify(() => FAILED);
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[1].status, 'blocked');
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /did not complete/);
  // t1 ran its two attempts; t2 never ran.
  assert.equal(h.turns.length, 2);
});

test('an unverified file-changing task advances but is never reported as proven', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  h.setVerify(() => ({ verdict: 'unverified', diagnostics: [], notes: ['no checker could run'] }));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'passed');
  assert.equal(state.tasks[0].lastReport?.verdict, 'unverified');
  assert.equal(state.status, 'done');
  assert.match(state.error ?? '', /without a check that could prove them/);
});

test('an unverified investigation task is not flagged — there were no files to prove', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', expectedFiles: [] })], errors: [] });
  h.setVerify(() => ({ verdict: 'unverified', diagnostics: [], notes: ['nothing to check'] }));
  const state = await h.run('goal');
  assert.equal(state.status, 'done');
  assert.equal(state.error, undefined);
});

test('an aborted turn fails the task and is not retried', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], creditsSpent: 0, aborted: true }));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(h.turns.length, 1);
});

test('the team stops at the spend cap and leaves the rest pending', async () => {
  // One turn costs exactly one edit, so a one-edit cap must stop before task two.
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] }, { ...DEFAULT_TEAM_BUDGET, maxCredits: CREDIT_RATES.codeEdit });
  h.setTurn((unit) => ({ reply: `reply for ${unit.id}`, patchesApplied: 0, patchFailures: [], creditsSpent: CREDIT_RATES.codeEdit, aborted: false }));
  const state = await h.run('goal');
  assert.equal(state.status, 'stopped-budget');
  assert.equal(state.tasks[0].status, 'passed');
  assert.equal(state.tasks[1].status, 'pending');
  assert.match(state.error ?? '', /spend cap of 1\.2/);
});

test('the team stops before a turn that would exceed the cap, returning the task to pending', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] }, { ...DEFAULT_TEAM_BUDGET, maxCredits: 0.5 });
  const state = await h.run('goal');
  assert.equal(state.status, 'stopped-budget');
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(h.turns.length, 0);
  assert.match(state.error ?? '', /estimated at 1\.2 spend/);
});

test('cancellation stops between tasks and marks the run cancelled', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  h.cancelAfter(1);
  const state = await h.run('goal');
  assert.equal(state.status, 'cancelled');
  assert.equal(state.tasks[0].status, 'passed');
  assert.equal(state.tasks[1].status, 'pending');
  assert.match(state.error ?? '', /Cancelled with 1 task/);
});

/* ── the closing integration turn ─────────────────────────────────────────── */

/** A merge check that finds breakage no single task's check could see. */
const BROKEN_MERGE: VerificationReport = {
  verdict: 'failed',
  diagnostics: [
    { path: 'src/api.ts', line: 7, column: 3, message: "Property 'onRename' is missing.", severity: 'error' }
  ],
  notes: ['one type error']
};

/** Each task writes its own file(s), so the changed set is never empty. */
function writes(files: Record<string, string[]>) {
  return (unit: TurnUnit): TurnResult => ({
    reply: `did ${unit.id}`,
    patchesApplied: 1,
    patchFailures: [],
    creditsSpent: 1,
    aborted: false,
    touchedFiles: files[unit.id] ?? []
  });
}

test('a run that changed files ends with an integration turn and a per-role merge report', async () => {
  const h = harness({
    tasks: [
      plannedTask({ id: 't1', assignee: 'frontend', expectedFiles: ['src/ui.ts'] }),
      plannedTask({ id: 't2', assignee: 'backend', expectedFiles: ['src/api.ts'] })
    ],
    errors: []
  });
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'] }));
  const state = await h.run('build it');

  assert.equal(state.status, 'done');
  assert.equal(h.turns.at(-1)?.id, 'integration');

  const report = state.mergeReport;
  assert.ok(report);
  assert.equal(report.role, 'coordinator');
  assert.equal(report.verdict, 'clean');
  assert.equal(report.ran, true);
  assert.deepEqual(report.files, ['src/ui.ts', 'src/api.ts']);
  assert.deepEqual(report.byRole, [
    { role: 'frontend', taskIds: ['t1'], files: ['src/ui.ts'] },
    { role: 'backend', taskIds: ['t2'], files: ['src/api.ts'] }
  ]);
  assert.deepEqual(report.overlaps, []);

  // The closing turn is told what each role changed and who owned each file.
  const instruction = h.turns.at(-1)?.instruction ?? '';
  assert.match(instruction, /WHAT EACH ROLE CHANGED/);
  assert.match(instruction, /frontend \(t1\): src\/ui\.ts/);
  assert.match(instruction, /OWNERSHIP MAP/);
  assert.match(instruction, /- src\/api\.ts: t2 \(backend\)/);
  assert.match(instruction, /OVERLAPS: none/);

  assert.equal(h.events.some((event) => event.type === 'team:integration'), true);
  assert.equal(state.messages.at(-1)?.from, 'coordinator');
  assert.match(state.messages.at(-1)?.text ?? '', /Integration \(coordinator\) verdict clean/);
  assert.equal(state.summaryReport?.mergeVerdict, 'clean');
  assert.deepEqual(state.summaryReport?.filesModified, ['src/ui.ts', 'src/api.ts']);
  assert.equal(state.creditsSpent, 3);
});

test('two roles writing one file is flagged as a conflict and fails the run', async () => {
  const h = harness({
    tasks: [
      plannedTask({ id: 't1', assignee: 'frontend', expectedFiles: ['src/shared.ts'] }),
      plannedTask({ id: 't2', assignee: 'backend', expectedFiles: ['src/shared.ts'] })
    ],
    errors: []
  });
  h.setTurn(writes({ t1: ['src/shared.ts'], t2: ['src/shared.ts'] }));
  const state = await h.run('build it');

  const report = state.mergeReport;
  assert.ok(report);
  assert.equal(report.overlaps.length, 1);
  assert.equal(report.overlaps[0].file, 'src/shared.ts');
  assert.deepEqual(report.overlaps[0].roles, ['frontend', 'backend']);
  assert.deepEqual(report.overlaps[0].taskIds, ['t1', 't2']);
  assert.equal(report.verdict, 'conflicts');
  assert.equal(report.notes[0], report.overlaps[0].note);

  // Never silently accepted: the run does not end `done` on a conflict, and the
  // overlap lands in the panel's existing conflicts list.
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.conflicts, [report.overlaps[0].note]);
  assert.match(state.error ?? '', /written by more than one role: src\/shared\.ts/);
  assert.deepEqual(state.summaryReport?.mergeConflicts, [report.overlaps[0].note]);
  assert.equal(state.messages.at(-1)?.kind, 'blocked');
  assert.match(h.turns.at(-1)?.instruction ?? '', /OVERLAPS — more than one task wrote these files/);
  assert.match(h.turns.at(-1)?.instruction ?? '', /src\/shared\.ts was written by t1 \(frontend\) then t2 \(backend\)/);
});

test('diagnostics that only appear across the merged files make the verdict broken', async () => {
  const h = harness({
    tasks: [plannedTask({ id: 't1', assignee: 'frontend' }), plannedTask({ id: 't2', assignee: 'backend' })],
    errors: []
  });
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'] }));
  h.setVerify((unit) => (unit.id === 'integration' ? BROKEN_MERGE : PASSED));
  const state = await h.run('build it');

  const report = state.mergeReport;
  assert.ok(report);
  assert.equal(report.verdict, 'broken');
  assert.equal(report.errors, 1);
  assert.equal(report.diagnostics[0].path, 'src/api.ts');
  assert.match(report.notes.join('\n'), /1 error diagnostic\(s\) remain across 2 changed file\(s\)/);
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /src\/api\.ts:7/);
  assert.match(state.error ?? '', /does not fit together/);
});

test('the merge turn re-checks what it repaired, and its own files join the report', async () => {
  const h = harness({
    tasks: [plannedTask({ id: 't1', assignee: 'frontend' }), plannedTask({ id: 't2', assignee: 'backend' })],
    errors: []
  });
  let checks = 0;
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'], integration: ['src/ui.ts', 'src/bridge.ts'] }));
  h.setVerify((unit) => {
    if (unit.id !== 'integration') return PASSED;
    checks += 1;
    // Broken before the closing turn, clean after it repaired the pair.
    return checks === 1 ? BROKEN_MERGE : PASSED;
  });
  const state = await h.run('build it');

  const report = state.mergeReport;
  assert.ok(report);
  assert.equal(report.verdict, 'clean');
  assert.deepEqual(report.files, ['src/ui.ts', 'src/api.ts', 'src/bridge.ts']);
  assert.deepEqual(report.byRole.at(-1), { role: 'coordinator', taskIds: ['integration'], files: ['src/bridge.ts'] });
  assert.equal(checks, 2);
});

test('the closing turn can be handed to the reviewer instead of the coordinator', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', assignee: 'backend' })], errors: [] });
  h.deps.integrationRole = 'reviewer';
  h.setTurn(writes({ t1: ['src/api.ts'] }));
  const state = await h.run('goal');

  assert.equal(state.mergeReport?.role, 'reviewer');
  assert.equal(state.messages.at(-1)?.from, 'reviewer');
  assert.match(h.turns.at(-1)?.instruction ?? '', /You are the Reviewer agent/);
});

test('a run with no credit left for the closing turn is still judged, and says it was not merged', async () => {
  const h = harness(
    { tasks: [plannedTask({ id: 't1', assignee: 'frontend' }), plannedTask({ id: 't2', assignee: 'backend' })], errors: [] },
    { ...DEFAULT_TEAM_BUDGET, maxCredits: 2.2 }
  );
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'] }));
  const state = await h.run('goal');

  assert.equal(h.turns.length, 2);
  assert.equal(state.status, 'done');
  assert.equal(state.mergeReport?.ran, false);
  assert.equal(state.mergeReport?.verdict, 'clean');
  assert.match(state.mergeReport?.notes.join(' ') ?? '', /the closing turn did not run/);
});

test('a run that wrote nothing has no end to merge, so there is no closing turn', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', expectedFiles: [] })], errors: [] });
  h.setTurn((unit) => ({ reply: `did ${unit.id}`, patchesApplied: 0, patchFailures: [], creditsSpent: 1, aborted: false }));
  const state = await h.run('goal');

  assert.equal(state.status, 'done');
  assert.equal(state.mergeReport, undefined);
  assert.equal(h.turns.length, 1);
});

test('a stopped team reports what it has instead of merging a half run', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', assignee: 'frontend' }), plannedTask({ id: 't2', assignee: 'backend' })], errors: [] });
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'] }));
  h.cancelAfter(1);
  const state = await h.run('goal');

  assert.equal(state.status, 'cancelled');
  assert.equal(state.mergeReport, undefined);
});
