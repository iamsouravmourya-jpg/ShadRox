import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTeamEvent } from './events';
import type { TeamEvent } from './types';

const AT = 1700000000000;

test('every event that reports work produces a line naming the task', () => {
  const events: TeamEvent[] = [
    { type: 'team:planned', tasks: [] },
    { type: 'task:start', id: 't1', assignee: 'backend' },
    { type: 'task:attempt', id: 't1', attempt: 2 },
    { type: 'task:verdict', id: 't1', verdict: 'unverified', report: { verdict: 'unverified', diagnostics: [], notes: [] } },
    { type: 'task:done', id: 't1', status: 'passed' },
    { type: 'message', message: { from: 'backend', to: 'team', kind: 'handoff', text: 'added the route', at: AT } },
    { type: 'credit', spent: 1, total: 3 },
    { type: 'team:log', text: 'Coordinating: build it' },
    { type: 'team:done', status: 'done' }
  ];
  const lines = events.map(describeTeamEvent);
  assert.equal(lines.every((line) => typeof line === 'string' && line.length > 0), true);
  assert.match(lines[1] ?? '', /backend started "t1"/);
  assert.match(lines[2] ?? '', /attempt 2/);
  assert.match(lines[3] ?? '', /unverified/);
  assert.match(lines[5] ?? '', /backend → team: added the route/);
  assert.match(lines[8] ?? '', /Team finished: done/);
});

test('a message addressed to one agent names that agent', () => {
  const line = describeTeamEvent({
    type: 'message',
    message: { from: 'tests', to: 'backend', kind: 'blocked', text: 'the route is missing', at: AT }
  });
  assert.match(line ?? '', /tests → backend: the route is missing/);
});

test('an unknown event type is skipped rather than logged', () => {
  assert.equal(describeTeamEvent({ type: 'nope' } as unknown as TeamEvent), null);
});
