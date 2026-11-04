import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTeamEvent } from './events';
import type { TeamEvent, TeamMergeReport } from './types';

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
    { type: 'team:done', status: 'done' },
    { type: 'team:integration', report: mergeReport() }
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

/** The smallest report that still reads as a merge the driver could have written. */
function mergeReport(overrides: Partial<TeamMergeReport> = {}): TeamMergeReport {
  return {
    role: 'coordinator',
    verdict: 'clean',
    ran: true,
    files: ['src/ui.ts', 'src/both.ts'],
    byRole: [
      { role: 'frontend', taskIds: ['t1'], files: ['src/ui.ts', 'src/both.ts'] },
      { role: 'backend', taskIds: ['t2'], files: ['src/both.ts'] }
    ],
    overlaps: [],
    diagnostics: [],
    errors: 0,
    warnings: 0,
    awaitingReview: [],
    notes: [],
    reply: 'the pieces fit',
    creditsSpent: 1,
    at: AT,
    ...overrides
  };
}

test('a merge report becomes one line naming the verdict and what it covered', () => {
  const line = describeTeamEvent({ type: 'team:integration', report: mergeReport() });
  assert.match(line ?? '', /Integration \(coordinator\): clean/);
  assert.match(line ?? '', /2 changed file\(s\) across 2 role\(s\)/);
});

test('the line never folds an overlap or a surviving error into a green count', () => {
  const conflicted = describeTeamEvent({
    type: 'team:integration',
    report: mergeReport({
      verdict: 'conflicts',
      overlaps: [
        { file: 'src/both.ts', roles: ['frontend', 'backend'], taskIds: ['t1', 't2'], note: 'both wrote src/both.ts' }
      ]
    })
  });
  assert.match(conflicted ?? '', /conflicts/);
  assert.match(conflicted ?? '', /1 file\(s\) written by more than one role \(src\/both\.ts\)/);

  const broken = describeTeamEvent({
    type: 'team:integration',
    report: mergeReport({ verdict: 'broken', errors: 2, warnings: 1 })
  });
  assert.match(broken ?? '', /broken/);
  assert.match(broken ?? '', /2 error\(s\)/);
  assert.doesNotMatch(broken ?? '', /warning/);
});

test('a closing turn that could not run is said on the line, not hidden', () => {
  const line = describeTeamEvent({ type: 'team:integration', report: mergeReport({ ran: false }) });
  assert.match(line ?? '', /closing turn did not run/);
});
