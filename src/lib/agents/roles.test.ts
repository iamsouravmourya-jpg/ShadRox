import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATOR,
  SPECIALIST_ROLES,
  TEAM_ROSTER,
  buildIntegrationInstruction,
  buildTaskInstruction,
  changedFileUnion,
  changedFilesByRole,
  findAgent,
  integrationRole,
  isSpecialistRole,
  ownershipMap,
  teamAgentViews,
  writeOverlaps
} from './roles';
import type { AgentRole, TaskStatus, TeamState, TeamTask } from './types';

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    title: 'do the thing',
    instruction: 'do the thing carefully',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    assignee: 'frontend',
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

function state(tasks: TeamTask[]): TeamState {
  return { id: 'team-1', goal: 'build it', status: 'running', tasks, messages: [], creditsSpent: 0, startedAt: 0 };
}

test('the roster has the four specialists and never the coordinator', () => {
  assert.deepEqual(
    TEAM_ROSTER.map((spec) => spec.id),
    ['frontend', 'backend', 'tests', 'reviewer']
  );
  assert.equal(SPECIALIST_ROLES.includes('coordinator'), false);
  assert.equal(TEAM_ROSTER.every((spec) => spec.brief.trim().length > 0), true);
});

test('isSpecialistRole accepts specialists and rejects the coordinator and strangers', () => {
  for (const role of SPECIALIST_ROLES) assert.equal(isSpecialistRole(role), true);
  assert.equal(isSpecialistRole('coordinator'), false);
  assert.equal(isSpecialistRole('nobody'), false);
  assert.equal(isSpecialistRole(''), false);
});

test('findAgent returns the spec for a role and falls back rather than throwing', () => {
  assert.equal(COORDINATOR.id, 'coordinator');
  assert.equal(findAgent('backend').name, 'Backend');
  assert.equal(findAgent('reviewer').id, 'reviewer');
  // An unknown role renders the first specialist so a view never crashes.
  assert.equal(findAgent('ghost' as AgentRole).id, TEAM_ROSTER[0].id);
});

test('teamAgentViews with no state shows every agent idle', () => {
  const views = teamAgentViews(null);
  assert.equal(views.length, TEAM_ROSTER.length);
  assert.equal(views.every((view) => view.status === 'idle' && view.total === 0), true);
});

test('a running task makes its agent working and names the task', () => {
  const views = teamAgentViews(state([task({ assignee: 'backend', title: 'wire the API', status: 'running' })]));
  const backend = views.find((view) => view.spec.id === 'backend');
  assert.equal(backend?.status, 'working');
  assert.equal(backend?.currentTask, 'wire the API');
  const frontend = views.find((view) => view.spec.id === 'frontend');
  assert.equal(frontend?.status, 'idle');
});

test('agent status rolls up from its tasks: failed beats waiting, passed-only is done', () => {
  const views = teamAgentViews(
    state([
      task({ id: 'a', assignee: 'tests', status: 'passed' }),
      task({ id: 'b', assignee: 'tests', status: 'failed' })
    ])
  );
  const testsAgent = views.find((view) => view.spec.id === 'tests');
  assert.equal(testsAgent?.status, 'failed');
  assert.equal(testsAgent?.passed, 1);
  assert.equal(testsAgent?.failed, 1);
  assert.equal(testsAgent?.total, 2);

  const waiting = teamAgentViews(state([task({ assignee: 'tests', status: 'pending' })]));
  assert.equal(waiting.find((view) => view.spec.id === 'tests')?.status, 'waiting');

  const done = teamAgentViews(state([task({ assignee: 'tests', status: 'passed' })]));
  assert.equal(done.find((view) => view.spec.id === 'tests')?.status, 'done');
});

test('a blocked task counts as a failure for its agent', () => {
  const statuses: TaskStatus[] = ['blocked'];
  const views = teamAgentViews(state([task({ assignee: 'reviewer', status: statuses[0] })]));
  assert.equal(views.find((view) => view.spec.id === 'reviewer')?.failed, 1);
});

test('buildTaskInstruction names the agent, its brief and the files it may touch', () => {
  const text = buildTaskInstruction(task({ assignee: 'backend', title: 'add the route', instruction: 'expose POST /x' }), '');
  assert.match(text, /Backend agent/);
  assert.match(text, /TASK t1: add the route/);
  assert.match(text, /expose POST \/x/);
  assert.match(text, /src\/a\.ts/);
  assert.doesNotMatch(text, /changes no files/);
});

test('a task with no expected files is told to change nothing', () => {
  const text = buildTaskInstruction(task({ assignee: 'reviewer', expectedFiles: [] }), '');
  assert.match(text, /changes no files/);
});

test('shared context is appended, and omitted when empty', () => {
  const without = buildTaskInstruction(task(), '');
  assert.doesNotMatch(without, /WHAT THE OTHER AGENTS REPORTED/);

  const withContext = buildTaskInstruction(task(), '- backend: added the route');
  assert.match(withContext, /WHAT THE OTHER AGENTS REPORTED BEFORE THIS TASK:/);
  assert.match(withContext, /backend: added the route/);
});

/* ── the rollup the closing integration turn reads ─────────────────────────── */

test('findAgent names the coordinator too, so the closing turn speaks in its voice', () => {
  assert.equal(findAgent('coordinator').name, 'Coordinator');
  assert.equal(findAgent('coordinator').id, COORDINATOR.id);
  assert.equal(integrationRole(undefined), 'coordinator');
  assert.equal(integrationRole('reviewer'), 'reviewer');
  // A specialist cannot carry the closing turn: only these two see the whole set.
  assert.equal(integrationRole('backend'), 'coordinator');
});

test('changedFilesByRole groups what actually reached disk, by role and in write order', () => {
  const tasks = [
    task({ id: 't1', assignee: 'frontend', touchedFiles: ['src/ui.ts', 'src/both.ts'] }),
    task({ id: 't2', assignee: 'frontend', touchedFiles: ['src/form.ts'] }),
    task({ id: 't3', assignee: 'backend', touchedFiles: ['src/api.ts'] }),
    // An investigation task that wrote nothing contributes no line.
    task({ id: 't4', assignee: 'reviewer', touchedFiles: [] })
  ];
  assert.deepEqual(changedFilesByRole(tasks), [
    { role: 'frontend', taskIds: ['t1', 't2'], files: ['src/ui.ts', 'src/both.ts', 'src/form.ts'] },
    { role: 'backend', taskIds: ['t3'], files: ['src/api.ts'] }
  ]);
  assert.deepEqual(changedFileUnion(tasks), ['src/ui.ts', 'src/both.ts', 'src/form.ts', 'src/api.ts']);
});

test('backslashes and case are normalised, so the same file cannot hide behind two spellings', () => {
  const tasks = [
    task({ id: 't1', assignee: 'frontend', touchedFiles: ['src\\Api.ts'] }),
    task({ id: 't2', assignee: 'backend', touchedFiles: ['./src/api.ts'] })
  ];
  assert.deepEqual(changedFileUnion(tasks), ['src/api.ts']);
  assert.equal(writeOverlaps(tasks).length, 1);
});

test('writeOverlaps names only the files more than one task wrote', () => {
  const tasks = [
    task({ id: 't1', assignee: 'frontend', touchedFiles: ['src/ui.ts', 'src/both.ts'] }),
    task({ id: 't2', assignee: 'backend', touchedFiles: ['src/api.ts', 'src/both.ts'] }),
    task({ id: 't3', assignee: 'tests', touchedFiles: ['src/ui.test.ts'] })
  ];
  const overlaps = writeOverlaps(tasks);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].file, 'src/both.ts');
  assert.deepEqual(overlaps[0].roles, ['frontend', 'backend']);
  assert.deepEqual(overlaps[0].taskIds, ['t1', 't2']);
  assert.match(overlaps[0].note, /src\/both\.ts was written by t1 \(frontend\) then t2 \(backend\)/);
  assert.match(overlaps[0].note, /only the last write is on disk/);
});

test('ownershipMap reports who the plan allowed per file, in plan order', () => {
  const entries = ownershipMap([
    task({ id: 't1', assignee: 'frontend', expectedFiles: ['src/ui.ts'] }),
    task({ id: 't2', assignee: 'backend', expectedFiles: ['src/ui.ts', 'src/api.ts'] })
  ]);
  assert.deepEqual(entries, [
    { file: 'src/ui.ts', owners: ['t1 (frontend)', 't2 (backend)'] },
    { file: 'src/api.ts', owners: ['t2 (backend)'] }
  ]);
});

test('the integration instruction carries the files, the map, the overlaps and the diagnostics', () => {
  const tasks = [
    task({ id: 't1', assignee: 'frontend', expectedFiles: ['src/shared.ts'], touchedFiles: ['src/shared.ts'] }),
    task({ id: 't2', assignee: 'backend', expectedFiles: ['src/shared.ts'], touchedFiles: ['src/shared.ts'] })
  ];
  const text = buildIntegrationInstruction({
    goal: 'rename the prop',
    role: 'coordinator',
    byRole: changedFilesByRole(tasks),
    ownership: ownershipMap(tasks),
    overlaps: writeOverlaps(tasks),
    diagnostics: [
      { path: 'src/shared.ts', line: 12, column: 5, message: "Property 'onRename' is missing.", severity: 'error' },
      { path: 'src/shared.ts', line: 3, column: 1, message: 'Unused import.', severity: 'warning' }
    ],
    awaitingReview: ['src/kept.ts']
  });

  assert.match(text, /You are the Coordinator agent/);
  assert.match(text, /GOAL: rename the prop/);
  assert.match(text, /- frontend \(t1\): src\/shared\.ts/);
  assert.match(text, /- src\/shared\.ts: t1 \(frontend\), t2 \(backend\)/);
  // The overlap gets its own block, and the turn is told to decide, not to accept.
  assert.match(text, /OVERLAPS — more than one task wrote these files\. These are NOT accepted silently:/);
  assert.match(text, /Decide which version must survive/);
  // Errors are listed before warnings.
  assert.ok(text.indexOf("'onRename' is missing") < text.indexOf('Unused import'));
  assert.match(text, /AWAITING USER REVIEW \(proposed, deliberately not written\): src\/kept\.ts/);
  assert.match(text, /change no file outside the list above/);
});

test('a clean merge is told it is clean, and a closed turn with no files says so', () => {
  const text = buildIntegrationInstruction({
    goal: 'g',
    role: 'reviewer',
    byRole: [],
    ownership: [],
    overlaps: [],
    diagnostics: [],
    awaitingReview: []
  });
  assert.match(text, /You are the Reviewer agent/);
  assert.match(text, /- no task wrote any file\./);
  assert.match(text, /OVERLAPS: none/);
  assert.match(text, /- nothing was reported for these files\./);
});
