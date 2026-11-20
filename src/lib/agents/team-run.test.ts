import assert from 'node:assert/strict';
import test from 'node:test';

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
    ...overrides
  };
}

interface Harness {
  deps: TeamDeps;
  events: TeamEvent[];
  states: TeamState[];
  turns: { id: string; attempt: number; instruction: string; feedbackText?: string }[];
  /** The `signal` each task turn was handed, so the abort wiring is observable. */
  signals: (AbortSignal | undefined)[];
  checkpoints: () => number;
  validateCalls: () => number;
  setVerify: (fn: (unit: VerifiableUnit) => VerificationReport) => void;
  setTurn: (fn: (unit: TurnUnit, attempt: number) => TurnResult) => void;
  setValidate: (fn: () => PlanError[]) => void;
  cancelAfter: (count: number) => void;
  pauseAfter: (count: number) => void;
  /** Moves the fake clock, so a wall-clock ceiling can be tested without waiting. */
  advanceClock: (ms: number) => void;
  run: (goal: string) => Promise<TeamState>;
}

function harness(plan: TeamPlan, budget: TeamBudget = DEFAULT_TEAM_BUDGET): Harness {
  const events: TeamEvent[] = [];
  const states: TeamState[] = [];
  const turns: Harness['turns'] = [];
  const signals: Harness['signals'] = [];
  let verifyImpl = (_unit: VerifiableUnit): VerificationReport => PASSED;
  let turnImpl = (_unit: TurnUnit, _attempt: number): TurnResult => ({
    reply: 'ok',
    patchesApplied: 1,
    patchFailures: [],
    aborted: false
  });
  let validateImpl = (): PlanError[] => [];
  let cancelAfterTurn = Infinity;
  let pauseAfterTurn = Infinity;
  let turnCount = 0;
  let checkpointCount = 0;
  let validateCount = 0;
  let clockMs = 1000;
  /** Stands in for the panel's per-run AbortController. */
  const turnAbort = new AbortController();
  /** The port hands the loop a `TurnUnit`, which has no attempts array, so the
   *  fake counts them itself rather than reading them back off the request. */
  const attemptCounts = new Map<string, number>();

  const ports: TeamPorts = {
    runTurn: async (request) => {
      turnCount += 1;
      const attempt = (attemptCounts.get(request.milestone.id) ?? 0) + 1;
      attemptCounts.set(request.milestone.id, attempt);
      signals.push(request.signal);
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
    isCancellationRequested: () => turnCount >= cancelAfterTurn,
    isPauseRequested: () => turnCount >= pauseAfterTurn
  };

  const deps: TeamDeps = {
    ports,
    budget,
    planTeam: async () => plan,
    validate: () => {
      validateCount += 1;
      return validateImpl();
    },
    checkpoint: () => {
      checkpointCount += 1;
    },
    persist: (state) => states.push(state),
    turnSignal: () => turnAbort.signal,
    now: () => clockMs
  };

  return {
    deps,
    events,
    states,
    turns,
    signals,
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
    pauseAfter: (count) => {
      pauseAfterTurn = count;
    },
    advanceClock: (ms) => {
      clockMs += ms;
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

test('two independent tasks run and pass', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2', assignee: 'tests' })], errors: [] });
  const state = await h.run('build it');
  assert.equal(state.status, 'done');
  assert.deepEqual(state.tasks.map((task) => task.status), ['passed', 'passed']);
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
  h.setTurn((unit) => ({ reply: `reply for ${unit.id}`, patchesApplied: 0, patchFailures: [], aborted: false }));
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

test('a failed check\'s proof-command output reaches the retry prompt verbatim', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  let checks = 0;
  const failedWithCommand: VerificationReport = {
    ...FAILED,
    command: { argv: 'npm test', exitCode: 1, stdoutTail: 'FAIL src/a.test.ts', stderrTail: 'Cannot find module ./setup', timedOut: false },
    notes: ['one type error', 'the proof command exited 1; its output is attached as diagnostic evidence, not a verdict.']
  };
  h.setVerify(() => (++checks === 1 ? failedWithCommand : PASSED));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'passed');
  const retry = h.turns[1].feedbackText ?? '';
  assert.match(retry, /Proof command: npm test/);
  assert.match(retry, /Exit code: 1/);
  assert.match(retry, /FAIL src\/a\.test\.ts/);
  assert.match(retry, /Cannot find module \.\/setup/);
});

test('a passed task with a red proof command shares that evidence with the next agent', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2', dependsOn: ['t1'] })], errors: [] });
  h.setVerify((unit) =>
    unit.id === 't1'
      ? {
          verdict: 'passed',
          diagnostics: [],
          notes: ['the proof command exited 1; its output is attached as diagnostic evidence, not a verdict.'],
          command: { argv: 'npm test', exitCode: 1, stdoutTail: 'no tests found', stderrTail: '', timedOut: false }
        }
      : PASSED
  );
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'passed', 'the red command alone does not fail the task');
  assert.equal(state.tasks[1].status, 'passed', 'the dependent is not blocked');
  assert.match(h.turns[1].instruction, /proof command exited 1/);
});

test('the shared context window keeps 12 prior messages and stays bounded', async () => {
  const tasks = Array.from({ length: 15 }, (_, index) =>
    plannedTask({ id: `t${index + 1}`, title: `read ${index + 1}`, expectedFiles: [] })
  );
  const h = harness({ tasks, errors: [] }, { ...DEFAULT_TEAM_BUDGET, maxTurns: 40, maxTasks: 20 });
  h.setTurn((unit) => ({
    reply: `reply-for-${unit.id} ${'detail '.repeat(60)}`,
    patchesApplied: 0,
    patchFailures: [],
    aborted: false
  }));
  await h.run('goal');
  const last = h.turns.at(-1)?.instruction ?? '';
  assert.match(last, /reply-for-t14/, 'the most recent message is present');
  assert.match(last, /reply-for-t3/, 'the 12-message window reaches back past the old 6-message cut');
  assert.doesNotMatch(last, /reply-for-t1\b/, 'messages older than the window drop out');
  assert.doesNotMatch(last, /reply-for-t2\b/, 'messages older than the window drop out');
  const section = last.split('WHAT THE OTHER AGENTS REPORTED BEFORE THIS TASK:\n')[1]?.split('\n\nReply with the change itself')[0] ?? '';
  assert.ok(section.length > 0, 'the context section exists');
  assert.ok(section.length <= 6000, `the shared context stays bounded, got ${section.length}`);
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

test('an unverified file-changing task advances but is never recorded as passed', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  h.setVerify(() => ({ verdict: 'unverified', diagnostics: [], notes: ['no checker could run'] }));
  const state = await h.run('goal');
  // The rule this pins: an unproven step keeps its own status. It is not folded
  // into `passed` anywhere — not the task, not the team's shared note.
  assert.equal(state.tasks[0].status, 'unverified');
  assert.equal(state.tasks[0].lastReport?.verdict, 'unverified');
  assert.equal(state.tasks.filter((task) => task.status === 'passed').length, 0);
  assert.equal(state.status, 'done');
  assert.match(state.error ?? '', /finished unverified/);
  // The note the rest of the team reads says the same thing the status does.
  const handoff = state.messages.find((message) => message.text.includes('add a route'));
  assert.match(handoff?.text ?? '', /is unverified — nothing checked it/);
  assert.doesNotMatch(handoff?.text ?? '', /the check said passed/);
});

test('an unverified investigation task carries the status but raises no alarm', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', expectedFiles: [] })], errors: [] });
  h.setVerify(() => ({ verdict: 'unverified', diagnostics: [], notes: ['nothing to check'] }));
  const state = await h.run('goal');
  assert.equal(state.status, 'done');
  // Still not called a pass, even though a read-only task has nothing to prove.
  assert.equal(state.tasks[0].status, 'unverified');
  assert.equal(state.error, undefined);
});

test('an aborted turn fails the task and is not retried', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' })], errors: [] });
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: true }));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(h.turns.length, 1);
});

test('the team obeys the same turn and clock ceilings as a solo run', async () => {
  const turns = harness(
    { tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] },
    { ...DEFAULT_TEAM_BUDGET, maxTurns: 1 }
  );
  const turnState = await turns.run('goal');
  assert.equal(turnState.status, 'stopped');
  assert.match(turnState.error ?? '', /turn cap of 1/);
  assert.equal(turns.turns.length, 1);

  const clock = harness(
    { tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] },
    { ...DEFAULT_TEAM_BUDGET, maxWallClockMs: 1000 }
  );
  clock.setTurn((unit) => {
    clock.advanceClock(1500);
    return { reply: `reply for ${unit.id}`, patchesApplied: 1, patchFailures: [], aborted: false };
  });
  const clockState = await clock.run('goal');
  assert.equal(clockState.status, 'stopped');
  assert.match(clockState.error ?? '', /Stopped after 2s/);
  assert.equal(clock.turns.length, 1);
});

test('the team counts reported tool calls and ignores ones nobody measured', async () => {
  const counted = harness(
    { tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] },
    { ...DEFAULT_TEAM_BUDGET, maxToolCalls: 4 }
  );
  counted.setTurn((unit) => ({
    reply: `reply for ${unit.id}`,
    patchesApplied: 1,
    patchFailures: [],
    aborted: false,
    toolCalls: 4
  }));
  const state = await counted.run('goal');
  assert.equal(state.status, 'stopped');
  assert.match(state.error ?? '', /tool-call cap of 4/);

  const unmeasured = harness(
    { tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] },
    { ...DEFAULT_TEAM_BUDGET, maxToolCalls: 0 }
  );
  assert.equal((await unmeasured.run('goal')).status, 'done');
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

test('pause halts between tasks, files the run paused and buys no further turn', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  h.pauseAfter(1);
  const state = await h.run('goal');
  assert.equal(state.status, 'paused');
  assert.match(state.error ?? '', /Paused with 1 task/);
  assert.equal(state.tasks[0].status, 'passed', 'a finished task is not undone by a pause');
  assert.equal(state.tasks[1].status, 'pending');
  assert.equal(h.turns.length, 1);
});

test('a task paused mid-turn is filed stopped, never left running or called failed', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  h.pauseAfter(2);
  h.setTurn((unit) =>
    unit.id === 't2'
      ? { reply: '', patchesApplied: 1, patchFailures: [], aborted: true, stopped: true }
      : { reply: 'ok', patchesApplied: 1, patchFailures: [], aborted: false }
  );
  const state = await h.run('goal');
  assert.equal(state.status, 'paused');
  assert.equal(state.tasks[1].status, 'stopped', 'no task is persisted as running when nothing is running');
  assert.notEqual(state.tasks[1].status, 'failed', 'the user pressed Pause; the model is not blamed');
});

test('Stop outranks Pause for a team, and a stopped turn is not reported as a failure', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  h.cancelAfter(1);
  h.pauseAfter(1);
  const state = await h.run('goal');
  assert.equal(state.status, 'cancelled');
});

test('a turn the user stopped leaves the task stopped and the team not done', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  h.cancelAfter(1);
  h.setTurn(() => ({ reply: '', patchesApplied: 0, patchFailures: [], aborted: true, stopped: true }));
  const state = await h.run('goal');
  assert.equal(state.tasks[0].status, 'stopped');
  assert.equal(state.status, 'cancelled');
  assert.equal(h.turns.length, 1);
});

test('every task turn is handed the abort signal, so Stop ends the in-flight request', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1' }), plannedTask({ id: 't2' })], errors: [] });
  await h.run('goal');
  assert.equal(h.signals.length, 2);
  assert.equal(h.signals.every((signal) => signal instanceof AbortSignal), true);
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

test('a stop that lands during the closing check still judges the merge without running the turn', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', assignee: 'frontend' }), plannedTask({ id: 't2', assignee: 'backend' })], errors: [] });
  h.setTurn(writes({ t1: ['src/ui.ts'], t2: ['src/api.ts'] }));
  // The user's Stop arrives after the last task settled but before the closing
  // turn starts: the whole-team check still reports, the turn itself never runs.
  let stopped = false;
  h.deps.ports.isCancellationRequested = () => stopped;
  h.setVerify((unit) => {
    if (unit.id === 'integration') stopped = true;
    return PASSED;
  });
  const state = await h.run('goal');

  assert.equal(h.turns.length, 2);
  assert.equal(state.mergeReport?.ran, false);
  assert.equal(state.mergeReport?.verdict, 'clean');
  assert.match(state.mergeReport?.notes.join(' ') ?? '', /the closing turn did not run/);
  assert.match(state.mergeReport?.notes.join(' ') ?? '', /the user stopped the team/);
});

test('a run that wrote nothing has no end to merge, so there is no closing turn', async () => {
  const h = harness({ tasks: [plannedTask({ id: 't1', expectedFiles: [] })], errors: [] });
  h.setTurn((unit) => ({ reply: `did ${unit.id}`, patchesApplied: 0, patchFailures: [], aborted: false }));
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

test('workspaceManifest is injected into both specialist instructions and integration prompt', async () => {
  const h = harness({
    tasks: [plannedTask({ id: 't1', expectedFiles: ['src/a.ts'] })],
    errors: []
  });
  h.deps.workspaceManifest = 'WORKSPACE MANIFEST & DEPENDENCY CONSTRAINTS:\n- package.json dependencies: express@^4.21.0';
  h.setTurn(writes({ t1: ['src/a.ts'] }));
  const state = await h.run('build it');

  assert.equal(state.status, 'done');
  assert.match(h.turns[0].instruction, /express@\^4\.21\.0/);
  assert.match(h.turns.at(-1)?.instruction ?? '', /express@\^4\.21\.0/);
});

test('fatal coordinator exception fails the team cleanly, preserves root reason in Execution trace, and matches selectTaskMetrics', async () => {
  const h = harness({ tasks: [], errors: [] });
  h.deps.planTeam = async () => {
    throw new Error('HTTP 429 Quota exceeded on free tier');
  };
  const state = await h.run('build it');

  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /HTTP 429 Quota exceeded/);
  assert.equal(state.summaryReport?.tasksCompleted, 0);
  assert.equal(state.summaryReport?.totalTasks, 0);
  assert.equal(
    h.events.some((event) => event.type === 'team:log' && /HTTP 429 Quota exceeded/.test(event.text)),
    true
  );
});

test('summaryReport.tasksCompleted matches passed count when tasks fail and formatted diagnostics appear in summary', async () => {
  const h = harness({
    tasks: [
      plannedTask({ id: 't1', expectedFiles: ['src/a.ts'] }),
      plannedTask({ id: 't2', assignee: 'tests', expectedFiles: ['src/b.ts'] })
    ],
    errors: []
  });
  h.setVerify((unit) => (unit.id === 't1' ? PASSED : FAILED));
  const state = await h.run('build it');

  assert.equal(state.status, 'failed');
  assert.equal(state.summaryReport?.tasksCompleted, 1);
  assert.equal(state.summaryReport?.totalTasks, 2);
  assert.equal(
    state.messages.some((message) => /src\/a\.ts:3 Cannot find name 'x'/.test(message.text)),
    true
  );
});

