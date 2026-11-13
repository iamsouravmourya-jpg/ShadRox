import assert from 'node:assert/strict';
import test from 'node:test';

import type { Milestone, RunState } from '../autonomy/types';
import {
  MAX_VIEW_TRACE_LINES,
  autonomyRunView,
  milestoneRows,
  runViewFor,
  teamRunView,
  teamRows
} from './runView';
import { DEFAULT_TEAM_BUDGET, type TeamState, type TeamTask } from './types';

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    title: 'add the route',
    instruction: 'expose POST /x',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    assignee: 'backend',
    status: 'passed',
    attempts: 1,
    lastReport: { verdict: 'passed', diagnostics: [], notes: [] },
    report: 'done',
    patchesApplied: 1,
    patchFailures: [],
    creditsSpent: 1.2,
    ...overrides
  };
}

function teamState(tasks: TeamTask[], overrides: Partial<TeamState> = {}): TeamState {
  return {
    id: 'team-1',
    goal: 'build checkout',
    status: 'running',
    tasks,
    messages: [],
    creditsSpent: tasks.reduce((total, entry) => total + entry.creditsSpent, 0),
    startedAt: 1,
    budget: DEFAULT_TEAM_BUDGET,
    ...overrides
  };
}

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    title: 'wire the client',
    instruction: 'call the new api',
    expectedFiles: ['src/client.ts'],
    dependsOn: [],
    status: 'passed',
    attempts: [
      {
        index: 1,
        reply: 'ok',
        patchesApplied: 1,
        patchFailures: [],
        verification: { verdict: 'passed', diagnostics: [], notes: [] },
        creditsSpent: 1,
        startedAt: 1
      }
    ],
    ...overrides
  };
}

function runState(milestones: Milestone[], overrides: Partial<RunState> = {}): RunState {
  return { id: 'run-1', goal: 'refactor auth', status: 'running', milestones, creditsSpent: 1, startedAt: 1, ...overrides };
}

test('a running team becomes rows with owner, attempt and check', () => {
  const view = teamRunView(
    teamState([
      task(),
      task({ id: 't2', title: 'cover it', assignee: 'tests', status: 'running', attempts: 2, lastReport: null, creditsSpent: 0.5 }),
      task({ id: 't3', title: 'review', assignee: 'reviewer', status: 'pending', attempts: 0, lastReport: null, patchesApplied: 0, creditsSpent: 0 })
    ])
  );
  assert.ok(view);
  assert.equal(view.kind, 'team');
  assert.equal(view.title, 'Agent team');
  assert.equal(view.status, 'running');
  assert.deepEqual(
    view.rows.map((row) => [row.id, row.owner, row.statusLabel]),
    [
      ['t1', 'Backend', 'done'],
      ['t2', 'Tests', 'working'],
      ['t3', 'Reviewer', 'queued']
    ]
  );
  assert.equal(view.rows[1].attempt, 'attempt 2');
  assert.equal(view.rows[1].check, null, 'no check has reported yet');
  assert.equal(view.rows[2].attempt, null);
  assert.equal(view.rows[1].active, true);
  assert.equal(view.rows[0].active, false);
  assert.equal(view.progressLabel, '1/3 tasks');
  assert.equal(view.canStop, true);
  assert.equal(view.canResume, false);
});

test('a solo run has no owner column but the same row shape', () => {
  const view = autonomyRunView(runState([milestone(), milestone({ id: 'm2', status: 'blocked', dependsOn: ['m1x'], attempts: [] })]));
  assert.ok(view);
  assert.equal(view.kind, 'run');
  assert.equal(view.title, 'Autonomous run');
  assert.equal(view.rows[0].owner, null);
  assert.equal(view.rows[1].blocker, 'a dependency did not pass');
});

test('an unverified row says it was not checked instead of reading as done', () => {
  const view = teamRunView(
    teamState([
      task({
        status: 'unverified',
        lastReport: { verdict: 'unverified', diagnostics: [], notes: ['no checker could run'] }
      })
    ])
  );
  assert.equal(view?.rows[0].statusLabel, 'not checked');
  assert.equal(view?.rows[0].check, 'unverified');
  assert.match(view?.rows[0].blocker ?? '', /no checker could run/);
  assert.equal(view?.progressLabel, '0/1 tasks', 'an unverified task is not counted as proven');
});

test('a failed row carries the checker detail, not a generic word', () => {
  const view = teamRunView(
    teamState([
      task({
        status: 'failed',
        lastReport: {
          verdict: 'failed',
          diagnostics: [{ path: 'src/a.ts', line: 12, column: 3, message: "Cannot find name 'x'.", severity: 'error' }],
          notes: ['one type error']
        }
      })
    ])
  );
  assert.equal(view?.rows[0].statusLabel, 'failed');
  assert.match(view?.rows[0].blocker ?? '', /src\/a\.ts:12/);
  assert.match(view?.rows[0].blocker ?? '', /Cannot find name/);
});

test('a blocked row names the task that is the reason', () => {
  const tasks = [task({ id: 't1', status: 'failed' }), task({ id: 't2', dependsOn: ['t1'], status: 'blocked' })];
  const view = teamRunView(teamState(tasks));
  assert.match(view?.rows[1].blocker ?? '', /waiting on t1/);
});

test('held-back files are counted once and explained', () => {
  const view = teamRunView(
    teamState([
      task({ pendingReview: ['src/a.ts'], touchedFiles: ['src/b.ts'] }),
      task({ id: 't2', pendingReview: ['src/a.ts', 'src/c.ts'], touchedFiles: [] })
    ])
  );
  assert.deepEqual(view?.awaitingReview, ['src/a.ts', 'src/c.ts']);
  assert.match(view?.reviewLine ?? '', /2 files await your review/);
  assert.deepEqual(view?.rows[0].files, ['src/b.ts'], 'a held file is not also listed as changed');
});

test('nothing held back means no review line', () => {
  const view = teamRunView(teamState([task()]));
  assert.deepEqual(view?.awaitingReview, []);
  assert.equal(view?.reviewLine, null);
});

test('the budget label shows spent against the ceiling the state carries', () => {
  const view = teamRunView(teamState([task({ creditsSpent: 7.44 })]));
  assert.equal(view?.budgetLabel, '7.4 of 24 cr');
  assert.equal(view?.spent, 7.44);
  assert.equal(view?.budget, 24);
});

test('a budget stop is its own status and offers a resume', () => {
  const view = teamRunView(
    teamState([task(), task({ id: 't2', status: 'pending' })], {
      status: 'stopped-budget',
      error: 'Stopped at the spend cap of 24. 1 task(s) did not run.'
    })
  );
  assert.equal(view?.status, 'budget');
  assert.match(view?.statusLine ?? '', /stopped at the spend cap/);
  assert.equal(view?.canResume, true);
  assert.equal(view?.canStop, false);
});

test('a cancelled team reads as stopped, with the pending rows runnable again', () => {
  const view = teamRunView(
    teamState([task({ status: 'stopped' }), task({ id: 't2', status: 'pending' })], { status: 'cancelled', error: 'Cancelled with 1 task(s) left.' })
  );
  assert.equal(view?.status, 'stopped');
  assert.equal(view?.rows[0].statusLabel, 'stopped');
  assert.match(view?.rows[0].blocker ?? '', /stopped while it was running/);
  assert.equal(view?.canResume, true);
});

test('a done team has no error line and nothing to resume', () => {
  const view = teamRunView(teamState([task()], { status: 'done' }));
  assert.equal(view?.status, 'done');
  assert.equal(view?.statusLine, '1 of 1 tasks passed');
  assert.equal(view?.error, null);
  assert.equal(view?.canResume, false);
});

test('conflicts recorded by the driver reach the view', () => {
  const view = teamRunView(teamState([task(), task({ id: 't2' })], { conflicts: ['t1, t2 all claim src/a.ts — ordered t1 then t2.'] }));
  assert.deepEqual(view?.conflicts, ['t1, t2 all claim src/a.ts — ordered t1 then t2.']);
});

test('the trace is capped and newest-last, and long lines are shortened', () => {
  const log = Array.from({ length: 30 }, (_, index) => `line ${index} ${'x'.repeat(400)}`);
  const view = teamRunView(teamState([task()]), { log });
  assert.equal(view?.trace.length, MAX_VIEW_TRACE_LINES);
  assert.match(view?.trace.at(-1) ?? '', /^line 29/);
  assert.ok((view?.trace[0] ?? '').length < 300);
});

test('the escalation reason is copied through untouched', () => {
  const view = teamRunView(teamState([task()]), { reason: 'Auto: this spans frontend, backend.' });
  assert.equal(view?.reason, 'Auto: this spans frontend, backend.');
});

test('no state is no view — a card must not render an empty skeleton', () => {
  assert.equal(teamRunView(null), null);
  assert.equal(autonomyRunView(null), null);
  assert.equal(runViewFor('team', null, null), null);
  assert.equal(runViewFor('autonomy', null, null), null);
});

test('runViewFor picks the engine the message belongs to', () => {
  const team = teamState([task()]);
  const run = runState([milestone()]);
  assert.equal(runViewFor('team', team, run)?.kind, 'team');
  assert.equal(runViewFor('autonomy', team, run)?.kind, 'run');
});

test('a milestone row reads its last attempt for cost and verdict', () => {
  const rows = milestoneRows([
    milestone({
      status: 'failed',
      attempts: [
        { index: 1, reply: '', patchesApplied: 0, patchFailures: [], verification: { verdict: 'failed', diagnostics: [], notes: ['nothing matched'] }, creditsSpent: 0.6, startedAt: 1 },
        { index: 2, reply: '', patchesApplied: 1, patchFailures: [], verification: { verdict: 'failed', diagnostics: [], notes: [] }, creditsSpent: 0.7, startedAt: 2 }
      ]
    })
  ]);
  assert.equal(rows[0].attempt, 'attempt 2');
  assert.equal(rows[0].credits, 0.7);
  assert.equal(rows[0].check, 'failed');
  assert.equal(rows[0].blocker, 'the last attempt did not pass its check');
});

test('a long task title is shortened once, not wrapped into the row', () => {
  const rows = teamRows([task({ title: 'x'.repeat(400) })]);
  assert.ok(rows[0].subject.length <= 161);
  assert.match(rows[0].subject, /…$/);
});

test('a run that is ready but has not written anything is planning, not running', () => {
  const view = autonomyRunView(runState([milestone({ status: 'pending' })], { status: 'ready' }));
  assert.equal(view?.status, 'planning');
  assert.equal(view?.canStop, true);
  assert.match(view?.statusLine ?? '', /planned$/);
});
