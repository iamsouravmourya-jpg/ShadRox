import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

const dispatched: Array<{ type: string; detail: unknown }> = [];
(globalThis as unknown as Record<string, unknown>).window = {
  shadroxDesktop: null,
  dispatchEvent: (event: { type: string; detail?: unknown }) => { dispatched.push({ type: event.type, detail: event.detail }); return true; }
};

const sa = await import('./subagent');

test('ask_user pauses until the pick, then resumes with the answer', async () => {
  dispatched.length = 0;
  const pending = sa.handleAskUser('ws', { question: 'Which database?', options: ['SQLite', 'Postgres'] });
  const prompt = sa.getPendingAskUser();
  assert.ok(prompt);
  assert.equal(prompt.question, 'Which database?');
  assert.deepEqual(prompt.options, ['SQLite', 'Postgres']);
  assert.ok(dispatched.some((event) => event.type === sa.ASK_USER_EVENT));

  // An answer that was not offered is rejected; the question stays pending.
  assert.equal(sa.answerPendingQuestion(prompt.id, 'MongoDB'), false);
  assert.ok(sa.getPendingAskUser());

  assert.equal(sa.answerPendingQuestion(prompt.id, 'Postgres'), true);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.ok(outcome.content.includes('The user chose: "Postgres"'));
  assert.equal(sa.getPendingAskUser(), null);
  assert.ok(dispatched.some((event) => event.type === sa.ASK_USER_RESOLVED_EVENT));
});

test('dismiss resolves the paused tool as a refusal, never a hang', async () => {
  const pending = sa.handleAskUser('ws', { question: 'Proceed?', options: ['Yes', 'No'] });
  const prompt = sa.getPendingAskUser();
  assert.ok(prompt);
  assert.equal(sa.cancelPendingQuestion(prompt.id), true);
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, true);
  assert.ok(outcome.error?.includes('safest reasonable default'));
});

test('timeout settles the question automatically', async () => {
  const pending = sa.handleAskUser('ws', { question: 'Still there?', options: ['A', 'B'], timeoutMs: 1000 });
  assert.ok(sa.getPendingAskUser());
  const outcome = await pending; // resolves via the 1s timer, not an answer
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, true);
  assert.ok(outcome.error?.includes('timed out'));
  assert.equal(sa.getPendingAskUser(), null);
});

test('only one question may be pending at a time', async () => {
  const first = sa.handleAskUser('ws', { question: 'First?', options: ['A', 'B'] });
  const second = await sa.handleAskUser('ws', { question: 'Second?', options: ['C', 'D'] });
  assert.equal(second.refused, true);
  assert.ok(second.error?.includes('already waiting'));
  sa.clearPendingQuestions();
  const settled = await first;
  assert.equal(settled.refused, true);
  assert.equal(sa.getPendingAskUser(), null);
});

test('ask_user validates question and options', async () => {
  assert.equal((await sa.handleAskUser('ws', {})).refused, true);
  assert.equal((await sa.handleAskUser('ws', { question: 'x', options: ['only one'] })).refused, true);
  assert.equal((await sa.handleAskUser('ws', { question: 'x', options: ['a', 'a'] })).refused, true);
  assert.equal((await sa.handleAskUser('ws', { question: 'x', options: ['a', 'b', 'c', 'd', 'e'] })).refused, true);
  assert.equal((await sa.handleAskUser('ws', { question: 'x'.repeat(600), options: ['a', 'b'] })).refused, true);
  assert.equal((await sa.handleAskUser('ws', { question: 'x', options: ['a', 'y'.repeat(200)] })).refused, true);
});

test('without any UI the broker resolves immediately (no-ui), never parks', async () => {
  const savedWindow = (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).window;
  try {
    const outcome = await sa.requestUserAnswer('Headless?', ['A', 'B']);
    assert.equal(outcome.answered, false);
    assert.equal(outcome.reason, 'no-ui');
  } finally {
    (globalThis as unknown as Record<string, unknown>).window = savedWindow;
  }
});

test('spawn_subagent returns only a summary and files list from a separate context', async () => {
  const seenSystems: string[] = [];
  sa.configureSubagentStream(async (messages) => {
    // The helper gets its own transcript: exactly the task, nothing from main.
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Survey the src folder and report the entry point.');
    return {
      text: '```shadrox:tools\n{"name":"finish","args":{"summary":"Entry point is src/main.ts; it mounts App."}}\n```',
      error: null
    };
  });
  try {
    const result = await sa.handleSpawnSubagent('ws', { task: 'Survey the src folder and report the entry point.', files: ['src/main.ts'] });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes('SUMMARY'));
    assert.ok(result.content.includes('Entry point is src/main.ts'));
    assert.ok(result.content.includes('read-only'));
    assert.ok(result.content.includes('FILES CHANGED'));
    assert.ok(!result.content.includes('shadrox:tools')); // transcript never leaks
    assert.equal(result.changedFiles, 0);
  } finally {
    sa.configureSubagentStream(null);
  }
  void seenSystems;
});

test('spawn_subagent is read-only by default: writes are refused by policy', async () => {
  let round = 0;
  sa.configureSubagentStream(async () => {
    round += 1;
    if (round === 1) {
      return {
        text: '```shadrox:tools\n{"name":"write_file","args":{"path":"src/evil.ts","content":"export const x = 1;"}}\n```',
        error: null
      };
    }
    return { text: '```shadrox:tools\n{"name":"finish","args":{"summary":"Could not write; read-only helper."}}\n```', error: null };
  });
  try {
    const result = await sa.handleSpawnSubagent('ws', { task: 'Try to write a file.' });
    assert.equal(result.ok, true);
    assert.equal(result.changedFiles, 0);
    assert.ok(result.content.includes('read-only'));
  } finally {
    sa.configureSubagentStream(null);
  }
});

test('spawn_subagent validates its task and refuses without a key when no stream is injected', async () => {
  assert.equal((await sa.handleSpawnSubagent('ws', {})).refused, true);
  assert.equal((await sa.handleSpawnSubagent('ws', { task: 'x'.repeat(5000) })).refused, true);
  assert.equal((await sa.handleSpawnSubagent('', { task: 'do things' })).refused, true);
  storage.clear();
  const noKey = await sa.handleSpawnSubagent('ws', { task: 'do things' });
  assert.equal(noKey.refused, true);
  assert.ok(noKey.error?.includes('BYOK'));
});