import assert from 'node:assert/strict';
import test from 'node:test';

import { runAutonomous, type DriverDeps } from './run-loop';
import { DEFAULT_RUN_BUDGET, type AutonomyEvent, type Milestone, type PlanError, type RunBudget, type RunState, type TurnUnit, type VerifiableUnit, type VerificationReport, type AutonomyPorts, type TurnResult } from './types';

function milestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
  return {
    id,
    title: `${id} title`,
    instruction: `do ${id}`,
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    status: 'pending',
    attempts: [],
    ...overrides
  };
}

const PASSED: VerificationReport = { verdict: 'passed', diagnostics: [], notes: [] };
const FAILED: VerificationReport = {
  verdict: 'failed',
  diagnostics: [{ path: 'src/a.ts', line: 3, column: 1, message: "Cannot find name 'x'.", severity: 'error' }],
  notes: ['one type error']
};

interface Harness {
  deps: DriverDeps;
  events: AutonomyEvent[];
  states: RunState[];
  turns: { milestone: string; attempt: number; feedbackText?: string }[];
  rollbacks: string[];
  checkpoints: () => number;
  setVerify(fn: (m: VerifiableUnit) => Promise<VerificationReport>): void;
  setTurn(fn: (m: TurnUnit, attempt: number) => TurnResult): void;
  setRollbackResult(ok: boolean): void;
  cancelAfter(count: number): void;
  spendAfter(count: number): void;
}

function harness(milestones: Milestone[], budget: RunBudget = DEFAULT_RUN_BUDGET): Harness {
  const events: AutonomyEvent[] = [];
  /** Dependency-aware, like the real dag: a pending node runs only when its
   *  dependencies passed, and stays blocked when one of them failed. */
  const satisfied = (m: Milestone, list: Milestone[]) =>
    m.dependsOn.every((dep) => {
      const source = list.find((candidate) => candidate.id === dep);
      return source ? source.status === 'passed' : false;
    });
  const unsatisfiable = (m: Milestone, list: Milestone[]) =>
    m.dependsOn.some((dep) => list.find((candidate) => candidate.id === dep)?.status === 'failed');
  const states: RunState[] = [];
  const turns: Harness['turns'] = [];
  const rollbacks: string[] = [];
  let rollbackResult = true;
  let verifyImpl = async (_m: VerifiableUnit): Promise<VerificationReport> => PASSED;
  let turnImpl = (_unit: TurnUnit, _attempt: number): TurnResult => ({ reply: 'ok', patchesApplied: 1, patchFailures: [], creditsSpent: 1, aborted: false });
  let cancelAfterTurn = Infinity;
  let inflateSpendFrom = Infinity;
  let turnCount = 0;
  let checkpointCount = 0;
  let spent = 0;
  /** The port hands the loop a `TurnUnit`, which has no attempts array, so the
   *  fake counts them itself rather than reading them back off the request. */
  const attemptCounts = new Map<string, number>();

  const ports: AutonomyPorts = {
    runTurn: async (request) => {
      turnCount += 1;
      const attempt = (attemptCounts.get(request.milestone.id) ?? 0) + 1;
      attemptCounts.set(request.milestone.id, attempt);
      turns.push({ milestone: request.milestone.id, attempt, feedbackText: request.feedbackText });
      const result = turnImpl(request.milestone, attempt);
      if (turnCount >= inflateSpendFrom) spent += 1000;
      return result;
    },
    verify: (m) => verifyImpl(m),
    listFiles: () => ['src/a.ts', 'src/b.ts'],
    askPlan: async () => '[]',
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => turnCount >= cancelAfterTurn
  };

  const deps: DriverDeps = {
    ports,
    budget,
    planGoal: async () => ({ milestones, errors: [] as PlanError[] }),
    validate: () => [] as PlanError[],
    nextRunnable: (list) => list.find((m) => m.status === 'pending' && satisfied(m, list)) ?? null,
    findBlocked: (list) => list.filter((m) => m.status === 'pending' && unsatisfiable(m, list)),
    tracker: {
      credit: (cost) => {
        spent += cost;
        return { allowed: spent <= budget.maxCredits, spent };
      },
      spent: () => spent,
      exhausted: () => spent >= budget.maxCredits
    },
    feedbackFor: (m, report, failures, attempt) =>
      `${m.id}: ${report.diagnostics.map((d) => d.message).join('|')} refused=${failures.join('|')} n=${attempt}`,
    estimateTurn: () => 1,
    checkpoint: async () => {
      checkpointCount += 1;
      return `checkpoint-${checkpointCount}`;
    },
    rollback: async (checkpointId) => {
      rollbacks.push(checkpointId);
      return rollbackResult;
    },
    persist: (state) => states.push({ ...state, milestones: state.milestones.map((m) => ({ ...m })) }),
    now: () => 1000
  };

  return {
    deps,
    events,
    states,
    turns,
    rollbacks,
    checkpoints: () => checkpointCount,
    setVerify: (fn) => {
      verifyImpl = fn;
    },
    setTurn: (fn) => {
      turnImpl = fn;
    },
    setRollbackResult: (ok) => {
      rollbackResult = ok;
    },
    cancelAfter: (count) => {
      cancelAfterTurn = count;
    },
    spendAfter: (count) => {
      inflateSpendFrom = count;
    }
  };
}

test('two milestones that verify clean finish the run and checkpoint once', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  const state = await runAutonomous('do the thing', h.deps);
  assert.equal(state.status, 'done');
  assert.deepEqual(state.milestones.map((m) => m.status), ['passed', 'passed']);
  assert.equal(h.checkpoints(), 1, 'one checkpoint before the first write, not one per milestone');
  assert.equal(h.turns.length, 2);
  assert.deepEqual(
    h.events.filter((e) => e.type === 'milestone:done').map((e) => (e as { id: string }).id),
    ['m1', 'm2']
  );
});

test('review-held files and touched paths survive into the run state', async () => {
  const h = harness([milestone('m1')]);
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
  const state = await runAutonomous('goal', h.deps);
  assert.deepEqual(state.milestones[0].pendingReview, ['src/a.ts']);
  assert.ok(h.events.some((event) => event.type === 'milestone:review' && event.paths[0] === 'src/a.ts'));
});

test('a failing milestone repairs up to the cap then fails and blocks dependents', async () => {
  const h = harness([milestone('m1'), milestone('m2', { dependsOn: ['m1'] })]);
  h.setVerify(async () => FAILED);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.equal(state.milestones[0].status, 'failed');
  assert.equal(state.milestones[0].attempts.length, DEFAULT_RUN_BUDGET.maxAttemptsPerMilestone);
  assert.equal(state.milestones[1].status, 'blocked');
  assert.match(state.error ?? '', /2 of 2 milestones did not complete/, 'the blocked dependent counts as not completed');
});

test('the repair attempt is handed the report verbatim, not a paraphrase', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED);
  await runAutonomous('goal', h.deps);
  assert.equal(h.turns[0].feedbackText, undefined, 'a first attempt has nothing to repair');
  assert.match(h.turns[1].feedbackText ?? '', /Cannot find name 'x'\./);
  assert.match(h.turns[1].feedbackText ?? '', /n=1/);
});

test('an interrupted turn is not retried', async () => {
  const h = harness([milestone('m1')]);
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], creditsSpent: 0.4, aborted: true }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[0].status, 'failed');
  assert.equal(state.milestones[0].attempts.length, 1, 'no repair loop after a turn that never finished');
});

test('Stop cancels between milestones and says how many were left', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.cancelAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'cancelled');
  assert.match(state.error ?? '', /1 milestone\(s\) left/);
  assert.equal(state.milestones[1].status, 'pending');
});

test('the budget stops the run rather than overrunning it', async () => {
  const h = harness([milestone('m1'), milestone('m2')], { ...DEFAULT_RUN_BUDGET, maxCredits: 2 });
  h.spendAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'stopped-budget');
  assert.match(state.error ?? '', /credit cap/);
  assert.equal(h.turns.length, 1, 'no turn is started once the cap is gone');
});

test('an expensive next turn is refused before it is spent', async () => {
  const h = harness([milestone('m1')], { ...DEFAULT_RUN_BUDGET, maxCredits: 3 });
  const estimate = h.deps.estimateTurn;
  h.deps.estimateTurn = () => 5;
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'stopped-budget');
  assert.match(state.error ?? '', /estimated at 5 credits/);
  assert.equal(h.turns.length, 0);
  assert.equal(state.milestones[0].status, 'pending');
  h.deps.estimateTurn = estimate;
});

test('a plan that will not validate never reaches the model', async () => {
  const h = harness([milestone('m1')]);
  h.deps.validate = () => [{ milestoneId: 'm1', reason: 'bad-path', message: 'm1 lists a path outside the workspace: /etc/passwd' }];
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /outside the workspace/);
  assert.equal(h.turns.length, 0);
});

test('an unprovable milestone advances the run but is named in the summary', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.setVerify(async (m) =>
    m.id === 'm1' ? { verdict: 'unverified', diagnostics: [], notes: ['no type checker for markdown files'] } : PASSED
  );
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(state.milestones[0].status, 'passed');
  assert.match(state.error ?? '', /1 milestone\(s\) finished without a check/);
  assert.match(state.error ?? '', /no type checker for markdown files/);
  assert.equal(
    h.events.filter((e) => e.type === 'milestone:verdict' && e.verdict === 'unverified').length,
    1,
    'the verdict event still carries the honest verdict'
  );
});

test('credits are settled from the real turn cost, not the estimate', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.setTurn(() => ({ reply: 'ok', patchesApplied: 2, patchFailures: [], creditsSpent: 0.6, aborted: false }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.creditsSpent, 1.2);
  assert.equal(h.events.filter((e) => e.type === 'credit').length, 2);
});

test('the final state is persisted after every verdict so a crash loses nothing', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  const state = await runAutonomous('goal', h.deps);
  const last = h.states[h.states.length - 1];
  assert.equal(last.status, state.status);
  assert.equal(last.milestones.filter((m) => m.attempts.length > 0).length, 2);
});

test('a dry run plans and validates without writing or checkpointing', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.deps.dryRun = true;
  h.setVerify(async () => FAILED);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'ready');
  assert.equal(state.milestones.length, 2);
  assert.equal(h.turns.length, 0, 'a dry run never calls the model for a turn');
  assert.equal(h.checkpoints(), 0, 'nothing was written, so nothing was checkpointed');
  assert.equal(h.rollbacks.length, 0);
});

test('a failed run that wrote files rolls back to the pre-run checkpoint', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.equal(h.checkpoints(), 1);
  assert.deepEqual(h.rollbacks, ['checkpoint-1']);
  assert.equal(state.rolledBack, true);
  assert.match(state.error ?? '', /rolled .*back to the pre-run checkpoint/i);
});

test('a rollback that fails keeps the checkpoint id and says so', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED);
  h.setRollbackResult(false);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.equal(state.rolledBack, false);
  assert.equal(state.checkpointId, 'checkpoint-1');
  assert.match(state.error ?? '', /Automatic rollback failed/);
});

test('a user stop does not roll back work already written', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.cancelAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'cancelled');
  assert.equal(h.rollbacks.length, 0, 'a stop keeps the work; only failures roll back');
});

test('resume continues a persisted plan instead of replanning', async () => {
  const resumed: RunState = {
    id: 'run-1',
    goal: 'goal',
    status: 'cancelled',
    creditsSpent: 5,
    startedAt: 1,
    milestones: [
      { ...milestone('m1'), status: 'passed' },
      { ...milestone('m2'), dependsOn: ['m1'] }
    ]
  };
  const h = harness([milestone('m1'), milestone('m2')]);
  const state = await runAutonomous('goal', h.deps, resumed);
  assert.equal(state.status, 'done');
  assert.deepEqual(h.turns.map((turn) => turn.milestone), ['m2'], 'the passed milestone is not rerun');
  assert.equal(h.checkpoints(), 1, 'resume still snapshots before its first write');
});

test('resume turns a milestone left running back into a runnable one', async () => {
  const resumed: RunState = {
    id: 'run-1',
    goal: 'goal',
    status: 'failed',
    creditsSpent: 1,
    startedAt: 1,
    milestones: [{ ...milestone('m1'), status: 'running' }]
  };
  const h = harness([milestone('m1')]);
  const state = await runAutonomous('goal', h.deps, resumed);
  assert.equal(state.status, 'done');
  assert.deepEqual(h.turns.map((turn) => turn.milestone), ['m1']);
});
