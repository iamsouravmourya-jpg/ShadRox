import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMentionTrigger,
  CHAT_STARTERS,
  computeComposerHeight,
  describeLivePhase,
  findRecoveredToolIndices,
  formatToolDuration,
  formatTurnElapsed,
  stripTrailingMention,
  summarizeToolActivity
} from './chatUx';

test('CHAT_STARTERS provide distinct, non-empty prompts', () => {
  assert.equal(CHAT_STARTERS.length, 4);
  const ids = new Set(CHAT_STARTERS.map((s) => s.id));
  assert.equal(ids.size, 4);
  for (const starter of CHAT_STARTERS) {
    assert.ok(starter.title.trim().length > 0);
    assert.ok(starter.subtitle.trim().length > 0);
    assert.ok(starter.prompt.trim().length > 10);
  }
});

test('appendMentionTrigger keeps existing active @-query and separates words cleanly', () => {
  assert.equal(appendMentionTrigger(''), '@');
  assert.equal(appendMentionTrigger('check '), 'check @');
  assert.equal(appendMentionTrigger('check App.tsx'), 'check App.tsx @');
  assert.equal(appendMentionTrigger('check @App'), 'check @App');
  assert.equal(appendMentionTrigger('@'), '@');
});

test('stripTrailingMention removes only the trailing @query', () => {
  assert.equal(stripTrailingMention('@'), '');
  assert.equal(stripTrailingMention('fix @App.tsx'), 'fix');
  assert.equal(stripTrailingMention('keep email@domain.com and check @foo'), 'keep email@domain.com and check');
});

test('computeComposerHeight clamps between minHeight and maxHeight and toggles scroll', () => {
  assert.deepEqual(computeComposerHeight(20), { height: 58, overflowY: 'hidden' });
  assert.deepEqual(computeComposerHeight(112.4), { height: 113, overflowY: 'hidden' });
  assert.deepEqual(computeComposerHeight(180), { height: 180, overflowY: 'hidden' });
  assert.deepEqual(computeComposerHeight(240), { height: 180, overflowY: 'auto' });
  assert.deepEqual(computeComposerHeight(Number.NaN), { height: 58, overflowY: 'hidden' });
});

test('formatToolDuration, formatTurnElapsed, and summarizeToolActivity aggregate stages, recovered adjustments, and counts accurately', () => {
  assert.equal(formatToolDuration(420), '420ms');
  assert.equal(formatToolDuration(1450), '1.4s');
  assert.equal(formatToolDuration(undefined), '');

  assert.equal(formatTurnElapsed(5200), '5.2s');
  assert.equal(formatTurnElapsed(74000), '1m 14s');
  assert.equal(formatTurnElapsed(undefined), '');

  const summary = summarizeToolActivity([
    { name: 'read_file', label: 'Read src/App.tsx', ok: true, stage: 'reading', durationMs: 40 },
    { name: 'apply_patch', label: 'Edit src/ChatPanel.tsx', ok: true, stage: 'editing', durationMs: 120 },
    { name: 'run_check', label: 'Run typecheck', ok: false, stage: 'checking', durationMs: 840 },
    { name: 'write_file', label: 'Held write', ok: false, refused: true, stage: 'editing' }
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.reads, 1);
  assert.equal(summary.edits, 2);
  assert.equal(summary.checks, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.recovered, 0);
  assert.equal(summary.held, 1);
  assert.equal(summary.totalDurationMs, 1000);
  assert.equal(summary.latestLabel, 'Held write');
});

test('findRecoveredToolIndices and summarizeToolActivity downgrade intermediate recovered failures to calm adjustments', () => {
  const tools = [
    { name: 'edit_file', label: 'Edit App.tsx', ok: false, stage: 'editing', input: { path: 'src/App.tsx' } },
    { name: 'write_file', label: 'Write App.tsx', ok: true, stage: 'editing', input: { path: 'src/App.tsx' } },
    { name: 'verify', label: 'Run typecheck', ok: false, stage: 'checking' }
  ];
  const recovered = findRecoveredToolIndices(tools);
  assert.equal(recovered.has(0), true);
  assert.equal(recovered.has(2), false);

  const completed = summarizeToolActivity(tools, { streaming: false });
  assert.equal(completed.recovered, 1);
  assert.equal(completed.failed, 1);

  const active = summarizeToolActivity(tools, { streaming: true });
  assert.equal(active.recovered, 2);
  assert.equal(active.failed, 0);
});

test('describeLivePhase prioritizes explicit status, then content, tool, or reasoning', () => {
  assert.equal(
    describeLivePhase({ activeStatusMessage: '  Reading src/App.tsx  ', hasContent: true, latestToolLabel: 'x' }),
    'Reading src/App.tsx'
  );
  assert.equal(describeLivePhase({ hasContent: true }), 'Writing response…');
  assert.equal(describeLivePhase({ hasContent: false, latestToolLabel: 'Inspecting package.json' }), 'Inspecting package.json');
  assert.equal(describeLivePhase({ hasContent: false, hasReasoning: true }), 'Reasoning through approach…');
  assert.equal(describeLivePhase({ hasContent: false }), 'Analyzing workspace & planning response…');
});
