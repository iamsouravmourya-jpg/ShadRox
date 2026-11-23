import assert from 'node:assert/strict';
import test from 'node:test';

import { runAutonomous, type DriverDeps } from './run-loop';
import { findBlocked, nextRunnable } from './dag';
import { createAutonomyPorts, type AutonomyHost } from './ports';
import { createFailureReceipt } from '../repairProof';
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
  /** The `signal` each turn was handed, so the abort wiring is observable. */
  signals: (AbortSignal | undefined)[];
  rollbacks: string[];
  checkpoints: () => number;
  setVerify(fn: (m: VerifiableUnit) => Promise<VerificationReport>): void;
  setTurn(fn: (m: TurnUnit, attempt: number) => TurnResult): void;
  setRollbackResult(ok: boolean): void;
  cancelAfter(count: number): void;
  pauseAfter(count: number): void;
  /** Moves the fake clock, so a wall-clock ceiling can be tested without waiting. */
  advanceClock(ms: number): void;
}

function harness(milestones: Milestone[], budget: RunBudget = DEFAULT_RUN_BUDGET): Harness {
  const events: AutonomyEvent[] = [];
  /* The real scheduler, wired exactly as engine.ts wires it — the driver's
   * dependency semantics are only worth testing against the dag the product
   * actually uses, not a copy that can drift from it. */
  const states: RunState[] = [];
  const turns: Harness['turns'] = [];
  const signals: Harness['signals'] = [];
  const rollbacks: string[] = [];
  let rollbackResult = true;
  let verifyImpl = async (_m: VerifiableUnit): Promise<VerificationReport> => PASSED;
  let turnImpl = (_unit: TurnUnit, _attempt: number): TurnResult => ({ reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false });
  let cancelAfterTurn = Infinity;
  let pauseAfterTurn = Infinity;
  let turnCount = 0;
  let checkpointCount = 0;
  let clockMs = 1000;
  /** Stands in for the controller's per-run AbortController. */
  const turnAbort = new AbortController();
  /** The port hands the loop a `TurnUnit`, which has no attempts array, so the
   *  fake counts them itself rather than reading them back off the request. */
  const attemptCounts = new Map<string, number>();

  const ports: AutonomyPorts = {
    runTurn: async (request) => {
      turnCount += 1;
      const attempt = (attemptCounts.get(request.milestone.id) ?? 0) + 1;
      attemptCounts.set(request.milestone.id, attempt);
      turns.push({ milestone: request.milestone.id, attempt, feedbackText: request.feedbackText });
      signals.push(request.signal);
      const result = turnImpl(request.milestone, attempt);
      return result;
    },
    verify: (m) => verifyImpl(m),
    listFiles: () => ['src/a.ts', 'src/b.ts'],
    askPlan: async () => '[]',
    onEvent: (event) => events.push(event),
    isCancellationRequested: () => turnCount >= cancelAfterTurn,
    isPauseRequested: () => turnCount >= pauseAfterTurn
  };

  const deps: DriverDeps = {
    ports,
    budget,
    planGoal: async () => ({ milestones, errors: [] as PlanError[] }),
    validate: () => [] as PlanError[],
    nextRunnable,
    findBlocked,
    feedbackFor: (m, report, failures, attempt) =>
      `${m.id}: ${report.diagnostics.map((d) => d.message).join('|')} refused=${failures.join('|')} n=${attempt}`,
    checkpoint: async () => {
      checkpointCount += 1;
      return `checkpoint-${checkpointCount}`;
    },
    rollback: async (checkpointId) => {
      rollbacks.push(checkpointId);
      return rollbackResult;
    },
    persist: (state) => states.push({ ...state, milestones: state.milestones.map((m) => ({ ...m })) }),
    turnSignal: () => turnAbort.signal,
    now: () => clockMs
  };

  return {
    deps,
    events,
    states,
    turns,
    signals,
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
    pauseAfter: (count) => {
      pauseAfterTurn = count;
    },
    advanceClock: (ms) => {
      clockMs += ms;
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
    aborted: false,
    touchedFiles: [],
    filesRead: ['src/a.ts'],
    pendingReview: ['src/a.ts']
  }));
  const state = await runAutonomous('goal', h.deps);
  assert.deepEqual(state.milestones[0].pendingReview, ['src/a.ts']);
  assert.ok(h.events.some((event) => event.type === 'milestone:review' && event.paths[0] === 'src/a.ts'));
});

test('a check failed by review-held files pauses the run instead of burning attempts and rolling back', async () => {
  const h = harness([milestone('m1'), milestone('m2', { dependsOn: ['m1'] })]);
  h.setVerify(async () => FAILED);
  h.setTurn(() => ({
    reply: 'Proposed the edit.',
    patchesApplied: 0,
    patchFailures: [],
    aborted: false,
    pendingReview: ['src/a.ts']
  }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'paused');
  assert.equal(state.milestones[0].status, 'stopped');
  assert.equal(h.turns.length, 1, 'no retry can accept a review for the user');
  assert.deepEqual(h.rollbacks, [], 'the work already landed stays on disk while the user reviews');
  assert.match(state.error ?? '', /waiting for your review/);
  assert.match(state.error ?? '', /resume the run/);
});

test('a held file unrelated to the failure does not pause the repair loop', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED); // the error is in src/a.ts, the held file is not
  h.setTurn(() => ({
    reply: 'Proposed an unrelated edit.',
    patchesApplied: 0,
    patchFailures: [],
    aborted: false,
    pendingReview: ['src/other.ts']
  }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.equal(state.milestones[0].attempts.length, DEFAULT_RUN_BUDGET.maxAttemptsPerMilestone);
  // The repair turn is told which files are NOT on disk so it stops building
  // against content only the review queue has seen.
  assert.match(h.turns[1].feedbackText ?? '', /held for user review/);
  assert.match(h.turns[1].feedbackText ?? '', /src\/other\.ts/);
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
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: true }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[0].status, 'failed');
  assert.equal(state.milestones[0].attempts.length, 1, 'no repair loop after a turn that never finished');
});

test('a turn the user stopped is filed as stopped, not as a failure', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.cancelAfter(1);
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: true, stopped: true }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[0].status, 'stopped', 'a stop is not a failure the model is blamed for');
  assert.equal(state.milestones[1].status, 'pending');
  assert.equal(state.status, 'cancelled');
  assert.equal(h.turns.length, 1, 'the run takes no further turn after a stop');
});

test('a stopped turn cannot leave a run claiming it finished', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  // A host that says "the user stopped this" without a Stop flag set: the run may
  // not resolve to `done` on that, because nothing proves the work ended well.
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: true, stopped: true }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'cancelled');
  assert.notEqual(state.status, 'done');
});

test('Stop hands its signal to the turn in flight, not only to the next one', async () => {
  const h = harness([milestone('m1')]);
  await runAutonomous('goal', h.deps);
  assert.equal(h.signals.length, 1);
  assert.equal(h.signals[0]?.aborted, false);
  assert.ok(h.signals[0] instanceof AbortSignal, 'the request carries the controller signal the panel can abort');
});

test('Pause halts between milestones, files the run as paused and leaves the work resumable', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.pauseAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'paused');
  assert.match(state.error ?? '', /Paused with 1 milestone\(s\) left/);
  assert.equal(state.milestones[0].status, 'passed', 'finished work is kept, not re-run');
  assert.equal(state.milestones[1].status, 'pending', 'the unstarted milestone stays runnable');
  assert.equal(h.turns.length, 1, 'a pause buys no further turn');
});

test('Pause files the milestone it interrupted as stopped, never left running', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.pauseAfter(2);
  h.setTurn((unit) =>
    unit.id === 'm2'
      ? { reply: '', patchesApplied: 1, patchFailures: [], aborted: true, stopped: true }
      : { reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false }
  );
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'paused');
  assert.equal(state.milestones[1].status, 'stopped', 'no milestone is persisted as running when nothing is running');
});

test('Stop outranks Pause when both were pressed', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.cancelAfter(1);
  h.pauseAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'cancelled', 'one ends the run, the other only waits');
});

test('Stop cancels between milestones and says how many were left', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.cancelAfter(1);
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'cancelled');
  assert.match(state.error ?? '', /1 milestone\(s\) left/);
  assert.equal(state.milestones[1].status, 'pending');
});

test('the turn cap stops the run and says which ceiling fired', async () => {
  const h = harness([milestone('m1'), milestone('m2')], { ...DEFAULT_RUN_BUDGET, maxTurns: 1 });
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'stopped');
  assert.match(state.error ?? '', /turn cap of 1/);
  assert.equal(h.turns.length, 1, 'a second turn would have started');
  assert.equal(state.milestones[1].status, 'pending');
});

test('the tool-call cap counts only what the host really reported', async () => {
  const silent = harness([milestone('m1'), milestone('m2')], { ...DEFAULT_RUN_BUDGET, maxToolCalls: 1 });
  const state = await runAutonomous('goal', silent.deps);
  assert.equal(state.status, 'done', 'a host that reports no tool calls is bounded by its turns, not by a guess');

  const counted = harness([milestone('m1'), milestone('m2')], { ...DEFAULT_RUN_BUDGET, maxToolCalls: 3 });
  counted.setTurn(() => ({ reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false, toolCalls: 3 }));
  const stopped = await runAutonomous('goal', counted.deps);
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.error ?? '', /tool-call cap of 3/);
  assert.equal(counted.turns.length, 1);
});

test('the wall-clock cap stops between units without waiting for one', async () => {
  const h = harness([milestone('m1'), milestone('m2')], { ...DEFAULT_RUN_BUDGET, maxWallClockMs: 1000 });
  h.setTurn((unit) => {
    h.advanceClock(1500);
    return { reply: unit.id, patchesApplied: 1, patchFailures: [], aborted: false };
  });
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'stopped');
  assert.match(state.error ?? '', /Stopped after 2s/);
  assert.equal(h.turns.length, 1);
});

test('a long turn does not buy the run another one — the clock is read before each attempt', async () => {
  const h = harness([milestone('m1')], { ...DEFAULT_RUN_BUDGET, maxAttemptsPerMilestone: 3, maxWallClockMs: 1000 });
  h.setVerify(async () => FAILED);
  h.setTurn(() => {
    h.advanceClock(1200);
    return { reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false };
  });
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'stopped');
  assert.match(state.error ?? '', /time limit is 1s/);
  assert.equal(h.turns.length, 1, 'the second attempt was refused before it started');
  assert.equal(state.milestones[0].status, 'stopped', 'it ran, so it is not filed back under pending');
});

test('a plan that will not validate never reaches the model', async () => {
  const h = harness([milestone('m1')]);
  h.deps.validate = () => [{ milestoneId: 'm1', reason: 'bad-path', message: 'm1 lists a path outside the workspace: /etc/passwd' }];
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /outside the workspace/);
  assert.equal(h.turns.length, 0);
});

test('an unprovable milestone is recorded as unverified, never as passed', async () => {
  const h = harness([milestone('m1'), milestone('m2')]);
  h.setVerify(async (m) =>
    m.id === 'm1' ? { verdict: 'unverified', diagnostics: [], notes: ['no type checker for markdown files'] } : PASSED
  );
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(state.milestones[0].status, 'unverified');
  assert.equal(
    state.milestones.filter((m) => m.status === 'passed').length,
    1,
    'only the milestone a checker actually cleared is claimed as passed'
  );
  assert.match(state.error ?? '', /1 of 2 milestones finished unverified/);
  assert.match(state.error ?? '', /no type checker for markdown files/);
  assert.equal(
    h.events.filter((e) => e.type === 'milestone:verdict' && e.verdict === 'unverified').length,
    1,
    'the verdict event still carries the honest verdict'
  );
});

test('an unverified dependency advances the plan but never vouches for what follows', async () => {
  const h = harness([milestone('m1'), milestone('m2', { dependsOn: ['m1'] })]);
  h.setVerify(async (m) =>
    m.id === 'm1' ? { verdict: 'unverified', diagnostics: [], notes: ['no checker could run'] } : PASSED
  );
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[1].status, 'passed', 'm2 still runs — a missing checker is not a failure');
  assert.equal(state.milestones[0].status, 'unverified');
  assert.equal(state.status, 'done');
  assert.match(state.error ?? '', /1 of 2 milestones finished unverified/);
});

test('a read-only milestone with no checker is unverified but raises no alarm', async () => {
  const h = harness([milestone('m1', { expectedFiles: [] }), milestone('m2')]);
  h.setVerify(async (m) =>
    m.id === 'm1' ? { verdict: 'unverified', diagnostics: [], notes: ['nothing to check'] } : PASSED
  );
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[0].status, 'unverified', 'still not claimed as passed');
  assert.equal(state.status, 'done');
  assert.equal(state.error, undefined, 'an unproven investigation has nothing to warn about');
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

test('a turn that mutated disk without patches still rolls back on a failed run', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED);
  // delete_file / run_command / MCP writes change the workspace without
  // applying a single patch: patchesApplied alone used to leave wrote=false.
  h.setTurn(() => ({ reply: 'ran a command', patchesApplied: 0, changedFiles: 2, patchFailures: [], aborted: false }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.deepEqual(h.rollbacks, ['checkpoint-1'], 'non-patch writes are writes');
  assert.equal(state.rolledBack, true);
});

test('a run whose turns wrote nothing at all does not roll back', async () => {
  const h = harness([milestone('m1')]);
  h.setVerify(async () => FAILED);
  h.setTurn(() => ({ reply: 'read only', patchesApplied: 0, changedFiles: 0, patchFailures: [], aborted: false }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'failed');
  assert.deepEqual(h.rollbacks, [], 'nothing was written, so there is nothing to restore');
  assert.equal(state.rolledBack, undefined);
});

test('the turn\'s command-failure receipt is filed on the attempt record', async () => {
  const receipt = createFailureReceipt({ source: 'test', target: 'npm test', errorMessage: '2 tests failed', exitCode: 1 });
  const h = harness([milestone('m1')]);
  h.setTurn(() => ({ reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false, failureProof: receipt }));
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.milestones[0].attempts[0].failureProof, receipt);
  const last = h.states[h.states.length - 1];
  assert.equal(last.milestones[0].attempts[0].failureProof?.id, receipt.id, 'the persisted state keeps the evidence too');
});

test('a zero-write pass is annotated and logged through the real verifier', async () => {
  const h = harness([milestone('m1')]);
  h.setTurn(() => ({ reply: 'looked around', patchesApplied: 0, changedFiles: 0, patchFailures: [], aborted: false }));
  // The real ports adapter and the real verifyMilestone, wired as the app
  // wires them: a clean checker answer must not hide that nothing was written.
  const host: AutonomyHost = {
    runTurn: async () => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: false }),
    getDiagnostics: async () => [],
    listFiles: () => ['src/a.ts'],
    askPlan: async () => '[]',
    runCommand: async () => ({ argv: '', exitCode: 0, stdoutTail: '', stderrTail: '', timedOut: false })
  };
  const realPorts = createAutonomyPorts(host, {
    rootPath: '/ws',
    onEvent: h.deps.ports.onEvent,
    isCancellationRequested: () => false
  });
  h.deps.ports.verify = realPorts.verify;
  const state = await runAutonomous('goal', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(state.milestones[0].status, 'unverified', 'a no-op turn is not a pass: the verifier cannot prove the files exist');
  const report = state.milestones[0].attempts[0].verification;
  assert.match(report?.notes.join(' ') ?? '', /touched nothing/);
  assert.ok(
    h.events.some((event) => event.type === 'log' && /touched nothing/.test(event.text)),
    'the panel log and journal see the caveat, not just the bare verdict'
  );
});

test('a zero-write turn on a pre-existing file fails verification and triggers repair', async () => {
  const h = harness([milestone('m1', { title: 'Update component', instruction: 'update src/a.ts' })]);
  let calls = 0;
  h.setTurn(() => {
    calls += 1;
    if (calls === 1) return { reply: 'no changes needed', patchesApplied: 0, changedFiles: 0, patchFailures: [], aborted: false };
    return { reply: 'patched src/a.ts', patchesApplied: 1, changedFiles: 0, patchFailures: [], aborted: false };
  });
  const realHost: AutonomyHost = {
    runTurn: async () => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: false }),
    getDiagnostics: async () => [],
    listFiles: () => ['src/a.ts'],
    readFile: async () => 'export const a = 1;',
    askPlan: async () => '[]',
    runCommand: async () => ({ argv: '', exitCode: 0, stdoutTail: '', stderrTail: '', timedOut: false })
  };
  const realPorts = createAutonomyPorts(realHost, {
    rootPath: '/ws',
    onEvent: h.deps.ports.onEvent,
    isCancellationRequested: () => false
  });
  h.deps.ports.verify = realPorts.verify;
  const state = await runAutonomous('update src/a.ts', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(calls, 2, 'zero-write modification attempt fails and runs repair attempt');
  assert.equal(state.milestones[0].attempts[0].verification?.verdict, 'failed');
  assert.equal(state.milestones[0].attempts[1].verification?.verdict, 'passed');
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
    startedAt: 1,
    milestones: [{ ...milestone('m1'), status: 'running' }]
  };
  const h = harness([milestone('m1')]);
  const state = await runAutonomous('goal', h.deps, resumed);
  assert.equal(state.status, 'done');
  assert.deepEqual(h.turns.map((turn) => turn.milestone), ['m1']);
});

test('resume re-runs the milestone a pause left stopped, and keeps what passed', async () => {
  const resumed: RunState = {
    id: 'run-1',
    goal: 'goal',
    status: 'paused',
    startedAt: 1,
    milestones: [
      { ...milestone('m1'), status: 'passed' },
      { ...milestone('m2'), status: 'stopped', attempts: [{ index: 1, reply: 'half a turn', patchesApplied: 1, patchFailures: [], verification: PASSED, startedAt: 2 }] },
      { ...milestone('m3'), dependsOn: ['m2'] }
    ]
  };
  const h = harness([milestone('m1'), milestone('m2'), milestone('m3')]);
  const state = await runAutonomous('goal', h.deps, resumed);
  assert.equal(state.status, 'done');
  assert.deepEqual(
    h.turns.map((turn) => turn.milestone),
    ['m2', 'm3'],
    'the stopped milestone is runnable again and the passed one is not run twice'
  );
  assert.equal(state.milestones[0].status, 'passed');
});

test('multi-requirement mega-prompt triggers bounded m-catchup turn when an explicit requirement was left pending', async () => {
  const h = harness([milestone('m1', { expectedFiles: ['src/a.ts'] })]);
  h.setTurn((unit) => ({
    reply: `finished ${unit.id}`,
    patchesApplied: 1,
    patchFailures: [],
    aborted: false,
    touchedFiles: unit.id === 'm1' ? ['src/a.ts'] : ['src/b.ts']
  }));
  const state = await runAutonomous('1. Create src/a.ts\n2. Update src/b.ts to wire the route', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(state.milestones.some((m) => m.id === 'm-catchup'), true);
  assert.equal(state.requirements?.every((r) => r.status === 'covered'), true);
  assert.ok(h.turns.some((t) => t.milestone === 'm-catchup'));
});

test('verifyWorkspace runs m-ws-repair when cross-file errors appear and rolls back if workspace remains broken', async () => {
  const h1 = harness([milestone('m1', { expectedFiles: ['src/a.ts'] })]);
  let wsChecks = 0;
  h1.deps.ports.verifyWorkspace = async () => {
    wsChecks += 1;
    return wsChecks === 1
      ? { verdict: 'failed', diagnostics: [{ path: 'src/other.ts', line: 4, column: 2, message: 'Bad import', severity: 'error' }], notes: ['1 ws error'] }
      : PASSED;
  };
  const repaired = await runAutonomous('fix src/a.ts', h1.deps);
  assert.equal(repaired.status, 'done');
  assert.equal(wsChecks, 2);
  assert.equal(repaired.milestones.some((m) => m.id === 'm-ws-repair'), true);

  const h2 = harness([milestone('m1', { expectedFiles: ['src/a.ts'] })]);
  h2.deps.ports.verifyWorkspace = async () => ({
    verdict: 'failed',
    diagnostics: [{ path: 'src/other.ts', line: 4, column: 2, message: 'Still broken', severity: 'error' }],
    notes: ['Workspace check failed']
  });
  const broken = await runAutonomous('fix src/a.ts', h2.deps);
  assert.equal(broken.status, 'failed');
  assert.equal(broken.rolledBack, true);
  assert.deepEqual(h2.rollbacks, ['checkpoint-1']);
});

test('scoped final verification ignores pre-existing unrelated errors when targeted files are clean and no regressions occur', async () => {
  const legacyErrors = Array.from({ length: 89 }, (_, i) => ({
    path: `src/legacy/mod${i}.ts`,
    line: 10,
    column: 1,
    message: `Legacy TS error #${i}`,
    severity: 'error' as const
  }));

  const h = harness([
    milestone('m1', {
      title: 'Fix platformFacade and rateLimiter',
      expectedFiles: ['src/services/platformFacade.ts', 'src/services/rateLimiter.ts']
    })
  ]);
  h.deps.ports.listFiles = () => [
    'src/services/platformFacade.ts',
    'src/services/rateLimiter.ts',
    ...legacyErrors.map((d) => d.path)
  ];
  h.setTurn(() => ({
    reply: 'Fixed targeted services cleanly.',
    patchesApplied: 2,
    patchFailures: [],
    aborted: false,
    touchedFiles: ['src/services/platformFacade.ts', 'src/services/rateLimiter.ts']
  }));
  h.deps.ports.captureBaselineDiagnostics = async () => [
    ...legacyErrors,
    { path: 'src/services/platformFacade.ts', line: 5, column: 2, message: 'Old target error', severity: 'error' }
  ];
  let wsChecks = 0;
  h.deps.ports.verifyWorkspace = async () => {
    wsChecks += 1;
    return {
      verdict: 'failed',
      diagnostics: legacyErrors,
      notes: ['89 workspace-wide error diagnostic(s) found']
    };
  };

  const state = await runAutonomous('Fix errors specifically inside platformFacade.ts and rateLimiter.ts', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(wsChecks, 1, 'should not re-run after skipping unnecessary m-ws-repair');
  assert.equal(state.milestones.some((m) => m.id === 'm-ws-repair'), false);
  assert.deepEqual(h.rollbacks, []);
  assert.equal(state.rolledBack, undefined);
});

test('scoped final verification triggers m-ws-repair when touched/targeted files still have errors or regressions exceed baseline', async () => {
  const legacyErrors = [
    { path: 'src/legacy/old.ts', line: 1, column: 1, message: 'Pre-existing error', severity: 'error' as const }
  ];

  // Case 1: Error remains inside touched target file even though postRunErrorCount <= preRunErrorCount.
  const hTarget = harness([
    milestone('m1', { expectedFiles: ['src/services/platformFacade.ts'] })
  ]);
  hTarget.deps.ports.listFiles = () => ['src/services/platformFacade.ts', 'src/legacy/old.ts'];
  hTarget.setTurn(() => ({
    reply: 'Attempted fix',
    patchesApplied: 1,
    patchFailures: [],
    aborted: false,
    touchedFiles: ['src/services/platformFacade.ts']
  }));
  hTarget.deps.ports.captureBaselineDiagnostics = async () => [
    ...legacyErrors,
    { path: 'src/services/platformFacade.ts', line: 8, column: 1, message: 'Missing export', severity: 'error' }
  ];
  let targetWsChecks = 0;
  hTarget.deps.ports.verifyWorkspace = async () => {
    targetWsChecks += 1;
    return {
      verdict: 'failed',
      diagnostics:
        targetWsChecks === 1
          ? [
              ...legacyErrors,
              { path: 'src/services/platformFacade.ts', line: 8, column: 1, message: 'Missing export', severity: 'error' }
            ]
          : legacyErrors,
      notes: ['target error check']
    };
  };
  const targetRes = await runAutonomous('Fix errors in platformFacade.ts', hTarget.deps);
  assert.equal(targetRes.status, 'done');
  assert.equal(targetWsChecks, 2);
  assert.equal(targetRes.milestones.some((m) => m.id === 'm-ws-repair'), true);

  // Case 2: New regression error appears above baseline count and remains unresolved -> fails and rolls back.
  const hReg = harness([
    milestone('m1', { expectedFiles: ['src/services/rateLimiter.ts'] })
  ]);
  hReg.deps.ports.listFiles = () => ['src/services/rateLimiter.ts', 'src/legacy/old.ts', 'src/caller.ts'];
  hReg.setTurn(() => ({
    reply: 'Edited rateLimiter',
    patchesApplied: 1,
    patchFailures: [],
    aborted: false,
    touchedFiles: ['src/services/rateLimiter.ts']
  }));
  hReg.deps.ports.captureBaselineDiagnostics = async () => legacyErrors;
  hReg.deps.ports.verifyWorkspace = async () => ({
    verdict: 'failed',
    diagnostics: [
      ...legacyErrors,
      { path: 'src/caller.ts', line: 12, column: 3, message: 'New regression breaking caller', severity: 'error' }
    ],
    notes: ['2 workspace errors']
  });
  const regRes = await runAutonomous('Fix rateLimiter.ts', hReg.deps);
  assert.equal(regRes.status, 'failed');
  assert.equal(regRes.rolledBack, true);
  assert.deepEqual(hReg.rollbacks, ['checkpoint-1']);
});

test('runAutonomous skips TS/linter diagnostics on read_only milestones even before a subsequent edit milestone fixes the file', async () => {
  const h = harness([
    milestone('m1', {
      id: 'm1',
      title: 'Read and outline platformFacade.ts',
      instruction: 'Read platformFacade.ts structure',
      expectedFiles: ['src/services/platformFacade.ts'],
      category: 'read_only'
    }),
    milestone('m2', {
      id: 'm2',
      title: 'Fix types in platformFacade.ts',
      instruction: 'Edit src/services/platformFacade.ts to resolve TS errors',
      expectedFiles: ['src/services/platformFacade.ts'],
      dependsOn: ['m1'],
      category: 'file_mutation'
    })
  ]);
  h.deps.ports.verify = async (unit) => {
    if (unit.id === 'm1') {
      // Simulate an aggressive port returning TS errors that exist prior to m2
      return {
        verdict: 'failed',
        diagnostics: [
          { path: 'src/services/platformFacade.ts', line: 3, column: 5, message: 'Pre-existing TS error', severity: 'error' }
        ],
        notes: ['1 error diagnostic(s) found']
      };
    }
    return PASSED;
  };
  h.setTurn((unit) => ({
    reply: `Completed ${unit.id}`,
    patchesApplied: unit.id === 'm2' ? 1 : 0,
    patchFailures: [],
    aborted: false,
    toolEvents: unit.id === 'm1' ? [{ name: 'read_file', ok: true }] : [{ name: 'apply_patch', ok: true }]
  }));

  const state = await runAutonomous('Read platformFacade.ts then fix its TypeScript errors', h.deps);
  assert.equal(state.status, 'done');
  assert.equal(state.milestones[0].status, 'passed');
  assert.equal(state.milestones[0].attempts.length, 1, 'read_only m1 should pass on the first attempt without retry');
  assert.equal(state.milestones[1].status, 'passed');

  // Purely read_only run skips verifyWorkspace completely when nothing was written
  const hReadOnly = harness([
    milestone('m1', {
      title: 'Read and outline platformFacade.ts',
      instruction: 'Inspect platformFacade.ts',
      expectedFiles: ['src/services/platformFacade.ts'],
      category: 'read_only'
    })
  ]);
  hReadOnly.setTurn(() => ({
    reply: 'Outlined platformFacade.ts cleanly.',
    patchesApplied: 0,
    patchFailures: [],
    aborted: false,
    toolEvents: [{ name: 'read_file', ok: true }]
  }));
  let wsVerifyCalled = 0;
  hReadOnly.deps.ports.verifyWorkspace = async () => {
    wsVerifyCalled += 1;
    return PASSED;
  };
  const roState = await runAutonomous('Read and outline platformFacade.ts', hReadOnly.deps);
  assert.equal(roState.status, 'done');
  assert.equal(wsVerifyCalled, 0);
});



