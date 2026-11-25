import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubagentProgress } from './subagent';

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
const { runToolRounds } = await import('./toolLoop');
const { classifyTurnIntent } = await import('./runPolicy');
const { isToolEnabledInContext } = await import('./toolGatekeeper');

const toolBlock = (calls: unknown) => '```shadrox:tools\n' + JSON.stringify(calls) + '\n```';

function ctx(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceOpen: true,
    filePaths: [],
    previewActive: false,
    activeJobCount: 0,
    terminalAwaitingInput: false,
    checkpointCount: 0,
    ...overrides
  };
}

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
  let round = 0;
  sa.configureSubagentStream(async (messages) => {
    const isFirst = round === 0;
    if (isFirst) {
      // The helper gets its own transcript: exactly the task, nothing from main.
      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'Survey the src folder and report the entry point.');
    }
    round += 1;
    if (round === 1) {
      // A real scout must read a file before it may finish.
      return { text: '```shadrox:tools\n{"name":"read_file","args":{"path":"src/main.ts"}}\n```', error: null };
    }
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
    assert.ok(round >= 2, 'the scout read a file before finishing');
  } finally {
    sa.configureSubagentStream(null);
  }
  void seenSystems;
});

test('spawn_subagent cannot finish with zero tool calls: it is re-nudged, then refused', async () => {
  sa.configureSubagentStream(async () => ({
    text: '```shadrox:tools\n{"name":"finish","args":{"summary":"I just know the answer."}}\n```',
    error: null
  }));
  try {
    const result = await sa.handleSpawnSubagent('ws', { task: 'Tell me about the codebase.' });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.ok(/without calling any read-only tool/i.test(result.error ?? ''), 'refuses a zero-step finish');
  } finally {
    sa.configureSubagentStream(null);
  }
});

test('spawn_subagent is read-only by default: writes are refused by policy', async () => {
  let round = 0;
  const savedBridge = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    shadroxDesktop: {
      readFile: async (_id: string, path: string) => ({ name: path, content: 'export const x = 1;\n', version: 'v1' })
    },
    dispatchEvent: () => true
  };
  try {
    sa.configureSubagentStream(async () => {
      round += 1;
      if (round === 1) {
        return { text: '```shadrox:tools\n{"name":"write_file","args":{"path":"src/evil.ts","content":"export const x = 1;"}}\n```', error: null };
      }
      if (round === 2) {
        return { text: '```shadrox:tools\n{"name":"read_file","args":{"path":"src/main.ts"}}\n```', error: null };
      }
      return { text: '```shadrox:tools\n{"name":"finish","args":{"summary":"Could not write; read-only helper."}}\n```', error: null };
    });
    const result = await sa.handleSpawnSubagent('ws', { task: 'Try to write a file.' });
    assert.equal(result.ok, true);
    assert.equal(result.changedFiles, 0);
    assert.ok(result.content.includes('read-only'), 'summary marks the scout read-only');
  } finally {
    (globalThis as Record<string, unknown>).window = savedBridge;
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

test('tool loop runs at most 2 subagents in parallel and caps the 3rd in the same round', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  sa.configureSubagentStream(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 15));
    concurrent -= 1;
    return { text: toolBlock({ name: 'finish', args: { summary: 'scout done' } }), error: null };
  });
  // runTool refuses every call up front without a desktop bridge; provide a stub.
  const savedBridge = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = { shadroxDesktop: {}, dispatchEvent: () => true };
  try {
    const calls = [1, 2, 3].map((n) => ({ name: 'spawn_subagent', args: { task: `scout ${n}` } }));
    let round = 0;
    const stream = async () => {
      round += 1;
      if (round === 1) return { text: toolBlock(calls), error: null };
      return { text: 'done', error: null };
    };
    const result = await runToolRounds({
      messages: [{ role: 'user', content: 'audit many files across modules' }],
      workspaceId: 'ws',
      aborted: () => false,
      stream
    });
    assert.equal(maxConcurrent, 2, 'exactly two scouts run concurrently');
    const spawns = result.activity.filter((entry) => entry.name === 'spawn_subagent');
    assert.equal(spawns.length, 3, 'all three calls are accounted for');
    const capped = spawns.filter((entry) => entry.refused && /Subagent cap/.test(entry.error ?? ''));
    assert.equal(capped.length, 1, 'the third scout is capped cleanly');
  } finally {
    (globalThis as Record<string, unknown>).window = savedBridge;
    sa.configureSubagentStream(null);
  }
});

test('a subagent is read-only and cannot recurse via spawn_subagent', async () => {
  sa.configureSubagentStream(async () => ({
    text: toolBlock([
      { name: 'write_file', args: { path: 'src/evil.ts', content: 'export const x = 1;' } },
      { name: 'spawn_subagent', args: { task: 'recurse' } }
    ]),
    error: null
  }));
  try {
    const result = await sa.handleSpawnSubagent('ws', { task: 'try to write and recurse' });
    assert.equal(result.changedFiles, 0, 'no file was written');
    assert.ok(result.content.includes('read-only'), 'summary marks the scout read-only');
    assert.ok(!result.content.includes('write-capable'));
  } finally {
    sa.configureSubagentStream(null);
  }
});

test('abortActiveSubagents cancels a running scout immediately', async () => {
  sa.configureSubagentStream(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { text: toolBlock({ name: 'finish', args: { summary: 'too late' } }), error: null };
  });
  try {
    const pending = sa.handleSpawnSubagent('ws', { task: 'slow scout' });
    sa.abortActiveSubagents();
    const outcome = await pending;
    assert.equal(outcome.refused, true);
    assert.match(outcome.error ?? '', /stopped/i);
  } finally {
    sa.configureSubagentStream(null);
  }
});

test('conversational and advisory turns are unaffected; scouts are execution-only', async () => {
  const conv = classifyTurnIntent({ prompt: 'hi' });
  assert.equal(conv.kind, 'conversational');
  assert.equal(
    isToolEnabledInContext('spawn_subagent', ctx({ turnIntent: 'conversational' }) as never),
    false,
    'conversational attaches zero tools'
  );

  const adv = classifyTurnIntent({ prompt: 'explain the repo without editing' });
  assert.equal(adv.kind, 'advisory');
  assert.equal(
    isToolEnabledInContext(
      'spawn_subagent',
      ctx({ turnIntent: 'advisory', enabledBundles: new Set(adv.enabledBundles), unlockedBundles: new Set<string>(), isReadOnlyTurn: true }) as never
    ),
    false,
    'advisory is read-only and never offers scouts'
  );

  const exec = classifyTurnIntent({ prompt: 'build and fix the app' });
  assert.equal(exec.kind, 'execution');
  // A plain execution turn keeps the lean core bundle (no scout bloat).
  assert.equal(
    isToolEnabledInContext(
      'spawn_subagent',
      ctx({ turnIntent: 'execution', enabledBundles: new Set(exec.enabledBundles), unlockedBundles: new Set<string>(), isReadOnlyTurn: false }) as never
    ),
    false,
    'a single-file execution turn does not bloat the core bundle with scouts'
  );
  // Multi-file / multi-module work auto-enables the interaction bundle (scouts).
  const multi = classifyTurnIntent({ prompt: 'refactor the app across modules', multiFileSignal: true });
  assert.equal(multi.kind, 'execution');
  assert.ok(multi.enabledBundles.has('interaction'), 'multi-file work enables the interaction bundle');
  assert.equal(
    isToolEnabledInContext(
      'spawn_subagent',
      ctx({ turnIntent: 'execution', enabledBundles: new Set(multi.enabledBundles), unlockedBundles: new Set<string>(), isReadOnlyTurn: false }) as never
    ),
    true,
    'multi-file execution turns expose spawn_subagent'
  );
});

test('subagent runs up to 5 rounds, emits live SubagentProgress telemetry, and respects parent AbortSignal', async () => {
  assert.equal(sa.MAX_SUBAGENT_ROUNDS, 5);
  assert.equal(sa.DEFAULT_SUBAGENT_ROUNDS, 5);

  dispatched.length = 0;
  const savedBridge = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    shadroxDesktop: {
      findFiles: async () => ['src/App.tsx', 'src/main.tsx']
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    }
  };

  let roundSeen = 0;
  sa.configureSubagentStream(async (_messages, round) => {
    roundSeen = round;
    if (round < 3) {
      return { text: toolBlock({ name: 'find_files', args: { pattern: '*.ts' } }), error: null };
    }
    return { text: toolBlock({ name: 'finish', args: { summary: 'Mapped entry and routes cleanly.' } }), error: null };
  });

  try {
    const result = await sa.handleSpawnSubagent(
      'ws',
      { task: 'Inspect module structure', files: ['src/App.tsx'] },
      { slotIndex: 2 }
    );
    assert.equal(result.ok, true);
    assert.equal(roundSeen, 3);
    const events = dispatched
      .filter((entry) => entry.type === sa.SUBAGENT_EVENT)
      .map((entry) => entry.detail as SubagentProgress);
    assert.ok(events.length >= 3);
    assert.equal(events[0].index, 2);
    assert.ok(events[0].title && events[0].title.length > 0);
    assert.ok(events.some((ev) => ev.status === 'running' && (ev.stepsCount ?? 0) >= 1 && Boolean(ev.currentAction)));
    const done = events[events.length - 1];
    assert.equal(done.status, 'done');
    assert.match(done.summary ?? '', /Mapped entry/);
  } finally {
    (globalThis as Record<string, unknown>).window = savedBridge;
    sa.configureSubagentStream(null);
  }

  // Parent AbortSignal propagates immediately into running subagent
  const parentController = new AbortController();
  sa.configureSubagentStream(async (_messages, _round, signal) => {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 200);
    });
    return { text: toolBlock({ name: 'finish', args: { summary: 'late' } }), error: null };
  });
  try {
    const pending = sa.handleSpawnSubagent('ws', { task: 'Slow task' }, { signal: parentController.signal });
    parentController.abort();
    const aborted = await pending;
    assert.equal(aborted.refused, true);
    assert.match(aborted.error ?? '', /stopped/i);
  } finally {
    sa.configureSubagentStream(null);
  }

  // Nested subagent calls are blocked immediately even though effect is read-only
  const nested = await sa.handleSpawnSubagent('ws', { task: 'Child scout' }, { nested: true });
  assert.equal(nested.ok, false);
  assert.equal(nested.refused, true);
  assert.match(nested.error ?? '', /Nested spawn_subagent/);
});