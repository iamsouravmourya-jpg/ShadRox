import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatTurn } from '../ai';
import { serializeResults } from './toolProtocol';
import {
  compactToolObservations, computeLoopContextBudgetChars, summarizeAssistantToolPayload, summarizeObservation, isToolObservation, transcriptChars,
  upsertWorkingMemory, WORKING_MEMORY_HEADER,
  LOOP_CONTEXT_BUDGET_CHARS, MIN_LOOP_CONTEXT_BUDGET_CHARS, COMPACT_TRIGGER_SHARE, KEEP_RECENT_OBSERVATIONS,
  CAP_RECENT_OBSERVATION_CHARS
} from './loopContext';

const observation = (text: string, name = 'read_file'): ChatTurn => ({
  role: 'user',
  content: serializeResults([{ name, ok: true, content: text }])
});

test('a short transcript is returned untouched, by reference', () => {
  const messages: ChatTurn[] = [{ role: 'user', content: 'what is in a.ts?' }, observation('const a = 1;')];
  const result = compactToolObservations(messages);
  assert.equal(result.compacted, 0);
  assert.equal(result.messages, messages, 'below the trigger the same array comes back');
});

test('the trigger is 70% of the budget', () => {
  assert.equal(COMPACT_TRIGGER_SHARE, 0.7);
  assert.equal(LOOP_CONTEXT_BUDGET_CHARS, 160_000);
  assert.equal(KEEP_RECENT_OBSERVATIONS, 4);
});

test('old observations are summarized while the newest four stay verbatim', () => {
  const big = 'x'.repeat(600);
  const messages: ChatTurn[] = [{ role: 'user', content: 'build the thing' }];
  const obsIndices: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: 'assistant', content: `round ${index}` });
    obsIndices.push(messages.length);
    messages.push(observation(`${big} ${index}`));
  }
  // A tiny budget so the trigger is crossed cheaply; the logic is budget-relative.
  const result = compactToolObservations(messages, 1_000);
  assert.equal(result.compacted, 2, 'six observations minus the four kept = two compacted');
  assert.match(result.messages[obsIndices[0]].content, /\[compacted observation/);
  assert.match(result.messages[obsIndices[1]].content, /\[compacted observation/);
  for (const index of obsIndices.slice(2)) {
    assert.equal(result.messages[index].content, messages[index].content, 'the newest four are byte-identical');
  }
  assert.equal(result.messages[0].content, 'build the thing', 'the user ask is never compacted');
  assert.ok(transcriptChars(result.messages) < transcriptChars(messages), 'compaction really shrinks the transcript');
});

test('a small observation is left alone even when old', () => {
  const messages: ChatTurn[] = [{ role: 'user', content: 'ask' }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: 'assistant', content: 'r' });
    messages.push(observation('tiny'));
  }
  const result = compactToolObservations(messages, 100);
  assert.equal(result.compacted, 0, 'nothing reaches the minimum compactable size');
  assert.equal(result.messages, messages);
});

test('summarizeObservation keeps one line per tool and the appended decision note', () => {
  const content = `${serializeResults([
    { name: 'read_file', ok: true, content: 'const a = 1;' },
    { name: 'search_text', ok: false, content: '', error: 'No text matches for "foo".' }
  ])}\n\nAlso: dropped.ts did not run this round.`;
  const summary = summarizeObservation(content);
  assert.match(summary, /read_file → ok: const a = 1;/);
  assert.match(summary, /search_text → error: No text matches/);
  assert.match(summary, /note: dropped\.ts did not run/);
  assert.doesNotMatch(summary, /SHADROX_UNTRUSTED_DATA/, 'the data markers are stripped');
});

test('isToolObservation only flags user turns carrying a results fence', () => {
  assert.equal(isToolObservation(observation('x')), true);
  assert.equal(isToolObservation({ role: 'user', content: 'a plain question' }), false);
  assert.equal(isToolObservation({ role: 'assistant', content: '```shadrox:results\n[]\n```' }), false);
});

test('computeLoopContextBudgetChars scales safely with small and large context windows', () => {
  const small = computeLoopContextBudgetChars(8_192, 2_048, 8_000);
  assert.ok(small >= MIN_LOOP_CONTEXT_BUDGET_CHARS && small < LOOP_CONTEXT_BUDGET_CHARS);
  const large = computeLoopContextBudgetChars(128_000, 8_192, 16_000);
  assert.equal(large, LOOP_CONTEXT_BUDGET_CHARS);
});

test('upsertWorkingMemory pins right after the first user turn and is never compacted', () => {
  const base: ChatTurn[] = [{ role: 'user', content: 'upgrade app' }];
  for (let i = 0; i < 6; i += 1) {
    base.push({ role: 'assistant', content: `round ${i}` });
    base.push(observation(`${'y'.repeat(500)} ${i}`));
  }
  const withMemory = upsertWorkingMemory(base, {
    inspectedRanges: [{ path: 'src/App.tsx', startLine: 1, endLine: 200, totalLines: 1200 }],
    completedEdits: [{ path: 'api/ai/_endpoint.ts', op: 'edit_file' }],
    pendingRequirements: ['Update landing page version'],
    latestDiagnostics: []
  });
  assert.ok(withMemory[1].content.startsWith(WORKING_MEMORY_HEADER));
  const compacted = compactToolObservations(withMemory, 1_000);
  assert.ok(compacted.compacted > 0);
  const pinned = compacted.messages.find((m) => m.content.startsWith(WORKING_MEMORY_HEADER));
  assert.ok(pinned, 'working memory survives compaction');
  assert.match(pinned.content, /api\/ai\/_endpoint\.ts/);
  assert.match(pinned.content, /lines 1-200 of 1200/);
});

test('summarizeAssistantToolPayload and compactToolObservations shrink older write_file and apply_patch turns while keeping newest four verbatim', () => {
  const largeCode = 'export const line = "abcdef";\n'.repeat(30);
  const direct = summarizeAssistantToolPayload(
    'Applying file.\n```shadrox:tools\n' +
    JSON.stringify([
      { name: 'write_file', args: { path: 'src/Quiz.tsx', content: largeCode } },
      { name: 'apply_patch', args: { patches: [{ path: 'server.ts', old: largeCode, new: largeCode }] } }
    ]) +
    '\n```'
  );
  assert.match(direct, /^Applying file\./);
  assert.match(direct, /\[compacted write_file content:/);
  assert.match(direct, /\[compacted old:/);
  assert.match(direct, /\[compacted new:/);

  const messages: ChatTurn[] = [{ role: 'user', content: 'implement feature' }];
  const assistantIndices: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    assistantIndices.push(messages.length);
    messages.push({
      role: 'assistant',
      content: '```shadrox:tools\n' + JSON.stringify([{ name: 'write_file', args: { path: `src/f${i}.ts`, content: `${largeCode}// ${i}` } }]) + '\n```'
    });
    messages.push(observation(`ok ${i}`));
  }
  const result = compactToolObservations(messages, 1_000);
  assert.match(result.messages[assistantIndices[0]].content, /\[compacted write_file content:/);
  assert.match(result.messages[assistantIndices[1]].content, /\[compacted write_file content:/);
  for (const idx of assistantIndices.slice(2)) {
    assert.equal(result.messages[idx].content, messages[idx].content, 'newest 4 assistant tool turns stay verbatim');
  }
});