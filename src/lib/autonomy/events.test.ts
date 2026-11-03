import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_LOG_LINES, describeEvent } from './events';
import type { AutonomyEvent } from './types';

test('describeEvent writes one readable line for every event the panel logs', () => {
  const milestone = {
    id: 'm1',
    title: 'ship',
    instruction: 'do it',
    expectedFiles: ['src/a.ts'],
    dependsOn: [],
    status: 'pending' as const,
    attempts: []
  };
  const cases: Array<[AutonomyEvent, RegExp]> = [
    [{ type: 'plan:created', milestones: [milestone] }, /1 milestone/],
    [{ type: 'milestone:start', id: 'm1' }, /m1/],
    [{ type: 'milestone:attempt', id: 'm1', attempt: 2 }, /attempt 2/],
    [{ type: 'milestone:verdict', id: 'm1', verdict: 'failed', report: { verdict: 'failed', diagnostics: [], notes: [] } }, /failed/],
    [{ type: 'milestone:done', id: 'm1', status: 'passed' }, /passed/],
    [{ type: 'credit', spent: 1.5, total: 4 }, /1\.5/],
    [{ type: 'log', text: 'plain line' }, /plain line/],
    [{ type: 'run:done', status: 'done' }, /done/]
  ];
  for (const [event, pattern] of cases) {
    assert.match(describeEvent(event) ?? '', pattern);
  }
});

test('the log cap is a positive bound the hook can trim to', () => {
  assert.ok(MAX_LOG_LINES > 0);
});
