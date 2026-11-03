import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreditTracker } from '../autonomy/budget';
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

test('the team stops at the credit cap and leaves the rest pending', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] }, { ...DEFAULT_TEAM_BUDGET, maxCredits: 1 });
  const state = await h.run('goal');
  assert.equal(state.status, 'stopped-budget');
  assert.equal(state.tasks[0].status, 'passed');
  assert.equal(state.tasks[1].status, 'pending');
  assert.match(state.error ?? '', /1-credit cap/);
});

test('the team stops before a turn that would exceed the cap, returning the task to pending', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] }, { ...DEFAULT_TEAM_BUDGET, maxCredits: 0.5 });
  const state = await h.run('goal');
  assert.equal(state.status, 'stopped-budget');
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(h.turns.length, 0);
  assert.match(state.error ?? '', /estimated at 1 credits/);
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
