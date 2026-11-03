import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATOR,
  SPECIALIST_ROLES,
  TEAM_ROSTER,
  buildTaskInstruction,
  findAgent,
  isSpecialistRole,
  teamAgentViews
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
