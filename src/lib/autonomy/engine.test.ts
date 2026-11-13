import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreditTracker, estimateTurn } from './budget';
import { createDriverDeps, runGoal } from './engine';
import { buildRepairBrief } from './feedback';
import { CREDIT_RATES } from '../plans';
import {
  DEFAULT_RUN_BUDGET,
  type AutonomyEvent,
  type AutonomyPorts,
  type Milestone,
  type RunState,
  type TurnResult,
  type TurnUnit,
  type VerifiableUnit,
  type VerificationReport
} from './types';

const PASSED: VerificationReport = { verdict: 'passed', diagnostics: [], notes: [] };
const FAILED: VerificationReport = {
  verdict: 'failed',
  diagnostics: [{ path: 'src/a.ts', line: 3, column: 1, message: "Cannot find name 'x'.", severity: 'error' }],
  notes: ['one type error']
};

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return { id: 'm1', title: 'add a file', instruction: 'create src/a.ts', expectedFiles: ['src/a.ts'], dependsOn: [], status: 'pending', attempts: [], ...overrides };
}

interface Harness {
  ports: AutonomyPorts;
  events: AutonomyEvent[];
  states: RunState[];
  turns: string[];
  run: (goal: string) => Promise<RunState>;
}

function harness(planJson: string, reply: (m: TurnUnit) => TurnResult, verify: (m: VerifiableUnit) => VerificationReport): Harness {
  const events: AutonomyEvent[] = [];
  const states: RunState[] = [];
  const turns: string[] = [];
  const ports: AutonomyPorts = {
    runTurn: async (request) => {
      turns.push(request.milestone.id);
      return reply(request.milestone);
    },
    verify: async (m) => verify(m),
    listFiles: () => ['src/a.ts', 'src/b.ts'],
    askPlan: async () => planJson,
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => false
  };
  const options = {
    ports,
    askPlan: async () => planJson,
    checkpoint: () => undefined,
    persist: (state: RunState) => states.push(state)
  };
  return { ports, events, states, turns, run: (goal) => runGoal(goal, options) };
}

const OK_TURN = (): TurnResult => ({ reply: 'ok', patchesApplied: 1, patchFailures: [], creditsSpent: 1, aborted: false });

/** Two extra files add half an edit each — one whole code-edit rate. */
const TWO_EXTRA_FILES = CREDIT_RATES.codeEdit;

test('estimateTurn is the base edit rate and grows with touched files, up to the premium ceiling', () => {
  assert.equal(estimateTurn(milestone({ expectedFiles: [] })), CREDIT_RATES.codeEdit, 'a single file is the base rate');
  assert.equal(
    estimateTurn(milestone({ expectedFiles: ['a.ts', 'b.ts', 'c.ts'] })),
    CREDIT_RATES.codeEdit + TWO_EXTRA_FILES,
    'two extra files add one edit'
  );
  assert.equal(
    estimateTurn(milestone({ expectedFiles: Array.from({ length: 40 }, (_, i) => `f${i}.ts`) })),
    CREDIT_RATES.premiumRefactor,
    'the estimate never exceeds the premium ceiling'
  );
});

test('createCreditTracker accumulates, clamps negatives, and reports exhaustion', () => {
  const tracker = createCreditTracker({ maxCredits: 2 });
  assert.equal(tracker.spent(), 0);
  assert.equal(tracker.credit(-5).spent, 0, 'a negative cost cannot refund the run');
  assert.equal(tracker.credit(1.5).spent, 1.5);
  assert.equal(tracker.exhausted(), false);
  assert.deepEqual(tracker.credit(0.5), { allowed: true, spent: 2 });
  assert.equal(tracker.exhausted(), true);
});

test('buildRepairBrief hands the model the diagnostics verbatim and the refused patches', () => {
  const brief = buildRepairBrief(milestone(), FAILED, ['src/a.ts: search block not found'], 1);
  assert.match(brief, /Cannot find name 'x'\./);
  assert.match(brief, /repair attempt 2/);
  assert.match(brief, /search block not found/);
  assert.match(brief, /create src\/a\.ts/);
});

test('runGoal plans, runs every milestone through the ports, and finishes', async () => {
  const plan = JSON.stringify([
    { id: 'm1', title: 'first', instruction: 'do first', expectedFiles: ['src/a.ts'] },
    { id: 'm2', title: 'second', instruction: 'do second', expectedFiles: ['src/b.ts'], dependsOn: ['m1'] }
  ]);
  const h = harness(plan, OK_TURN, () => PASSED);
  const state = await h.run('build the feature');

  assert.equal(state.status, 'done');
  assert.deepEqual(state.milestones.map((m) => m.status), ['passed', 'passed']);
  assert.deepEqual(h.turns, ['m1', 'm2'], 'dependencies gate the execution order');
  assert.equal(state.creditsSpent, 2);
  assert.ok(h.events.some((event) => event.type === 'plan:created'));
  assert.ok(h.events.some((event) => event.type === 'run:done'));
});

test('the engine hands each turn the caller abort signal, and Pause halts the run', async () => {
  const plan = JSON.stringify([
    { id: 'm1', title: 'first', instruction: 'do first', expectedFiles: ['src/a.ts'] },
    { id: 'm2', title: 'second', instruction: 'do second', expectedFiles: ['src/b.ts'], dependsOn: ['m1'] }
  ]);
  const signals: (AbortSignal | undefined)[] = [];
  const turns: string[] = [];
  let paused = false;
  const ports: AutonomyPorts = {
    runTurn: async (request) => {
      turns.push(request.milestone.id);
      signals.push(request.signal);
      if (turns.length === 1) paused = true;
      return OK_TURN();
    },
    verify: async () => PASSED,
    listFiles: () => ['src/a.ts', 'src/b.ts'],
    askPlan: async () => plan,
    onEvent: () => undefined,
    isCancellationRequested: () => false,
    isPauseRequested: () => paused
  };
  const controller = new AbortController();
  const states: RunState[] = [];
  const state = await runGoal('build it', {
    ports,
    askPlan: async () => plan,
    checkpoint: () => undefined,
    persist: (live) => states.push(live),
    turnSignal: () => controller.signal
  });

  assert.deepEqual(turns, ['m1'], 'a pause takes no further turn');
  assert.equal(state.status, 'paused');
  assert.equal(state.milestones[1].status, 'pending');
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal, 'the engine passes the caller signal to the turn');
});

test('runGoal refuses a plan with a path outside the workspace without running a turn', async () => {
  const plan = JSON.stringify([{ id: 'm1', title: 'escape', instruction: 'write it', expectedFiles: ['/etc/passwd'] }]);
  const h = harness(plan, OK_TURN, () => PASSED);
  const state = await h.run('escape the workspace');

  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /outside the workspace/);
  assert.deepEqual(h.turns, []);
});

test('runGoal repairs a failing milestone from the verifier report, then gives up at the cap', async () => {
  const plan = JSON.stringify([{ id: 'm1', title: 'flaky', instruction: 'try', expectedFiles: ['src/a.ts'] }]);
  const seenFeedback: (string | undefined)[] = [];
  const events: AutonomyEvent[] = [];
  const ports: AutonomyPorts = {
    runTurn: async (request) => {
      seenFeedback.push(request.feedbackText);
      return OK_TURN();
    },
    verify: async () => FAILED,
    listFiles: () => ['src/a.ts'],
    askPlan: async () => plan,
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => false
  };
  const state = await runGoal('try the flaky thing', {
    ports,
    askPlan: async () => plan,
    checkpoint: () => undefined,
    persist: () => undefined
  });

  assert.equal(state.status, 'failed');
  assert.equal(state.milestones[0].status, 'failed');
  assert.equal(state.milestones[0].attempts.length, DEFAULT_RUN_BUDGET.maxAttemptsPerMilestone);
  assert.equal(seenFeedback[0], undefined, 'the first attempt has nothing to repair');
  assert.match(seenFeedback[1] ?? '', /Cannot find name 'x'\./);
});

test('createDriverDeps wires the pure deps and keeps the caller ports', () => {
  const ports: AutonomyPorts = {
    runTurn: async () => OK_TURN(),
    verify: async () => PASSED,
    listFiles: () => [],
    askPlan: async () => '[]',
    onEvent: () => undefined,
    isCancellationRequested: () => false
  };
  const deps = createDriverDeps({ ports, askPlan: async () => '[]', checkpoint: () => undefined, persist: () => undefined });
  assert.equal(deps.ports, ports);
  assert.equal(typeof deps.planGoal, 'function');
  assert.equal(typeof deps.validate, 'function');
  assert.equal(typeof deps.nextRunnable, 'function');
  assert.equal(typeof deps.findBlocked, 'function');
  assert.equal(deps.budget, DEFAULT_RUN_BUDGET);
  assert.equal(typeof deps.tracker.spent, 'function');
});
