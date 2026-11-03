import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completedTaskIds,
  createTeamStore,
  isTeamState,
  sanitizeTeamState,
  type TeamStorage
} from './teamStore';
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
    report: 'Done.',
    patchesApplied: 1,
    patchFailures: [],
    creditsSpent: 1.5,
    touchedFiles: ['src/a.ts'],
    pendingReview: [],
    filesRead: ['src/a.ts'],
    summary: 'Added POST /x.',
    ...overrides
  };
}

function state(overrides: Partial<TeamState> = {}): TeamState {
  return {
    id: 'team-1000',
    goal: 'build the checkout',
    status: 'stopped-budget',
    tasks: [task(), task({ id: 't2', title: 'cover it', assignee: 'tests', status: 'pending', attempts: 0, lastReport: null, creditsSpent: 0 })],
    messages: [{ from: 'backend', to: 'team', kind: 'handoff', text: 't1 changed src/a.ts', at: 1000 }],
    creditsSpent: 1.5,
    startedAt: 1000,
    error: 'Stopped at the 2-credit cap.',
    budget: DEFAULT_TEAM_BUDGET,
    conflicts: ['t1, t2 all claim src/a.ts'],
    ...overrides
  };
}

function memory(): TeamStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

test('a team round-trips through the store with its tasks and spend intact', () => {
  const store = createTeamStore(memory());
  const original = state();
  store.save('/repo', original);
  const loaded = store.load('/repo');
  assert.ok(loaded);
  assert.equal(loaded.goal, original.goal);
  assert.equal(loaded.status, 'stopped-budget');
  assert.equal(loaded.creditsSpent, 1.5);
  assert.equal(loaded.tasks.length, 2);
  assert.equal(loaded.tasks[0].status, 'passed');
  assert.deepEqual(loaded.tasks[0].touchedFiles, ['src/a.ts']);
  assert.equal(loaded.tasks[0].summary, 'Added POST /x.');
  assert.equal(loaded.tasks[1].status, 'pending');
  assert.deepEqual(loaded.budget, DEFAULT_TEAM_BUDGET);
  assert.deepEqual(loaded.conflicts, ['t1, t2 all claim src/a.ts']);
  assert.equal(loaded.messages.length, 1);
});

test('the persisted spend survives a reload so a resumed team cannot overspend', () => {
  const storage = memory();
  const store = createTeamStore(storage);
  store.save('/repo', state({ creditsSpent: 23.7, status: 'cancelled' }));
  const loaded = store.load('/repo');
  assert.equal(loaded?.creditsSpent, 23.7);
  assert.equal(loaded?.budget?.maxCredits, 24);
  assert.ok((loaded?.creditsSpent ?? 0) <= (loaded?.budget?.maxCredits ?? 0));
});

test('the completed set is what a resume skips', () => {
  const done = completedTaskIds(state());
  assert.deepEqual(done, ['t1']);
  // An unverified task is completed for scheduling but keeps saying so.
  assert.deepEqual(
    completedTaskIds(state({ tasks: [task({ status: 'unverified' }), task({ id: 't2', status: 'failed' })] })),
    ['t1']
  );
  assert.deepEqual(completedTaskIds(null), []);
});

test('a corrupt, foreign or half-shaped blob is treated as no team', () => {
  const storage = memory();
  const store = createTeamStore(storage);
  storage.map.set('shadrox.agents.team:/repo', '{not json');
  assert.equal(store.load('/repo'), null);
  storage.map.set('shadrox.agents.team:/repo', JSON.stringify({ hello: 'world' }));
  assert.equal(store.load('/repo'), null);
  storage.map.set('shadrox.agents.team:/repo', JSON.stringify(state({ tasks: [] })));
  assert.equal(store.load('/repo'), null, 'a team with no tasks cannot be resumed');
});

test('a task with an unknown assignee or a missing title is dropped, not guessed', () => {
  const clean = sanitizeTeamState(
    state({
      tasks: [task(), task({ id: 't2', assignee: 'poet' as TeamTask['assignee'] }), task({ id: 't3', title: '   ' })]
    })
  );
  assert.equal(clean?.tasks.length, 1);
  assert.equal(clean?.tasks[0].id, 't1');
});

test('a status outside the state machine is refused instead of restoring a nonsense row', () => {
  assert.equal(sanitizeTeamState(state({ status: 'vibes' as TeamState['status'] })), null);
  const clean = sanitizeTeamState(state({ tasks: [task({ status: 'ghost' as TeamTask['status'] })] }));
  assert.equal(clean?.tasks[0].status, 'pending');
});

test('oversized text is cut to the cap instead of storing a whole transcript', () => {
  const huge = 'x'.repeat(50_000);
  const clean = sanitizeTeamState(
    state({
      goal: huge,
      tasks: [task({ report: huge, summary: huge, touchedFiles: Array.from({ length: 500 }, (_, index) => `src/f${index}.ts`) })]
    })
  );
  assert.ok(clean);
  assert.ok(clean.goal.length <= 2000);
  assert.ok(clean.tasks[0].report.length <= 1200);
  assert.ok(clean.tasks[0].summary.length <= 400);
  assert.equal(clean.tasks[0].touchedFiles.length, 40);
});

test('a verification report keeps its verdict and sheds anything unbounded', () => {
  const clean = sanitizeTeamState(
    state({
      tasks: [
        task({
          lastReport: {
            verdict: 'failed',
            diagnostics: Array.from({ length: 300 }, (_, index) => ({
              path: 'src/a.ts',
              line: index,
              column: 1,
              message: 'boom',
              severity: 'error' as const
            })),
            notes: Array.from({ length: 40 }, () => 'note'),
            command: { argv: 'npm test', exitCode: 1, stdoutTail: 'y'.repeat(9000), stderrTail: '', timedOut: false }
          }
        })
      ]
    })
  );
  const report = clean?.tasks[0].lastReport;
  assert.equal(report?.verdict, 'failed');
  assert.equal(report?.diagnostics.length, 40);
  assert.equal(report?.notes.length, 8);
  assert.equal((report?.command?.stdoutTail ?? '').length, 2000);
});

test('a bogus verdict in a stored report voids the report rather than inventing a pass', () => {
  const clean = sanitizeTeamState(state({ tasks: [task({ lastReport: { verdict: 'probably' as never, diagnostics: [], notes: [] } })] }));
  assert.equal(clean?.tasks[0].lastReport, null);
  // The task still resumes — its own status is the schedule, the report is detail.
  assert.equal(clean?.tasks[0].status, 'passed');
});

test('negative and non-finite credits are refused, not stored', () => {
  const clean = sanitizeTeamState(state({ creditsSpent: -5, tasks: [task({ creditsSpent: Number.NaN })] }));
  assert.equal(clean?.creditsSpent, 0);
  assert.equal(clean?.tasks[0].creditsSpent, 0);
});

test('a message addressed to one role survives; a bogus one is dropped', () => {
  const clean = sanitizeTeamState(
    state({
      messages: JSON.parse('[{"from":"backend","to":"frontend","kind":"finding","text":"the route returns 201","at":5},{"from":"nobody","to":"team","kind":"finding","text":"ghost","at":6},{"from":"tests","to":"poet","kind":"handoff","text":"wrong recipient","at":7},{"from":"reviewer","to":"team","kind":"nonsense","text":"wrong kind","at":8}]')
    })
  );
  assert.equal(clean?.messages.length, 1);
  assert.equal(clean?.messages[0].to, 'frontend');
});

test('a null backend gives a store that forgets, and never throws', () => {
  const store = createTeamStore(null);
  store.save('/repo', state());
  assert.equal(store.load('/repo'), null);
  store.clear('/repo');
});

test('a save that cannot serialise leaves the previous run rather than corrupting it', () => {
  const storage = memory();
  const store = createTeamStore(storage);
  store.save('/repo', state());
  const before = storage.map.get('shadrox.agents.team:/repo');
  store.save('/repo', state({ tasks: [] }));
  assert.equal(storage.map.get('shadrox.agents.team:/repo'), before, 'an unsavable state is not written');
  assert.equal(isTeamState(JSON.parse(before as string)), true);
});

test('two workspaces keep two teams', () => {
  const store = createTeamStore(memory());
  store.save('/repo-a', state({ goal: 'a' }));
  store.save('/repo-b', state({ goal: 'b' }));
  assert.equal(store.load('/repo-a')?.goal, 'a');
  assert.equal(store.load('/repo-b')?.goal, 'b');
  store.clear('/repo-a');
  assert.equal(store.load('/repo-a'), null);
  assert.equal(store.load('/repo-b')?.goal, 'b');
});
