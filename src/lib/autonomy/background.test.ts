import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BACKGROUND_TASKS,
  canResume,
  createBackgroundSnapshot,
  createMemoryStore,
  loadSnapshots,
  parseBackgroundSnapshot,
  pruneSnapshots,
  resumeSummary,
  serializeBackgroundSnapshot,
  settleInterrupted,
  type BackgroundRunSnapshot,
  type BackgroundRunSource,
  type BackgroundTaskSource
} from './background';

const ROOT = 'C:\\Users\\Work\\Project';

function runSource(overrides: Partial<BackgroundRunSource> = {}): BackgroundRunSource {
  return {
    id: 'run-1',
    workspaceRoot: ROOT,
    goal: 'Ship the release',
    mode: 'autonomy',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 2_000,
    creditsSpent: 3.4,
    budgetCredits: 24,
    milestones: [
      { id: 'm1', title: 'Add the parser', status: 'passed', attempts: [{ index: 1 }, { index: 2 }] },
      { id: 'm2', title: 'Wire the UI', status: 'pending', attempts: 0 },
      { id: 'm3', title: 'Run the checks', status: 'running', attempts: 1 }
    ],
    lastEvent: 'm2 started',
    ...overrides
  };
}

function snapshot(overrides: Partial<BackgroundRunSource> = {}): BackgroundRunSnapshot {
  return createBackgroundSnapshot(runSource(overrides));
}

function rawWith(overrides: Record<string, unknown>): string {
  const base = JSON.parse(serializeBackgroundSnapshot(snapshot())) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...overrides });
}

function paused(overrides: Partial<BackgroundRunSource> = {}): BackgroundRunSnapshot {
  return settleInterrupted(snapshot(overrides));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('a snapshot is version 1 with the run summarized and nothing else', () => {
  const result = snapshot();
  assert.equal(result.version, 1);
  assert.equal(result.runId, 'run-1');
  assert.equal(result.workspaceRoot, ROOT);
  assert.equal(result.goal, 'Ship the release');
  assert.equal(result.mode, 'autonomy');
  assert.equal(result.status, 'running');
  assert.equal(result.startedAt, 1_000);
  assert.equal(result.updatedAt, 2_000);
  assert.equal(result.creditsSpent, 3.4);
  assert.equal(result.budgetCredits, 24);
  assert.equal(result.interrupted, false);
  assert.deepEqual(result.tasks.map((task) => task.status), ['passed', 'pending', 'running']);
  assert.deepEqual(result.tasks.map((task) => task.attempts), [2, 0, 1]);
});

test('a team run keeps its mode and its task counts', () => {
  const result = snapshot({ mode: 'team', status: 'done', tasks: [{ id: 't1', title: 'Docs', status: 'passed', attempts: 2 }], milestones: undefined });
  assert.equal(result.mode, 'team');
  assert.equal(result.status, 'done');
  assert.deepEqual(result.tasks, [{ id: 't1', title: 'Docs', status: 'passed', attempts: 2 }]);
});

test('run statuses map onto the five background statuses', () => {
  assert.equal(snapshot({ status: 'planning' }).status, 'running');
  assert.equal(snapshot({ status: 'ready' }).status, 'running');
  assert.equal(snapshot({ status: 'stopped-budget' }).status, 'stopped');
  assert.equal(snapshot({ status: 'cancelled' }).status, 'stopped');
  assert.equal(snapshot({ status: 'paused' }).status, 'paused');
  assert.equal(snapshot({ status: 'failed' }).status, 'failed');
});

test('the task list is capped at 100 entries', () => {
  const milestones: BackgroundTaskSource[] = Array.from({ length: 150 }, (_, index) => ({
    id: `m${index}`,
    title: `Task ${index}`,
    status: 'pending',
    attempts: 0
  }));
  const result = snapshot({ milestones });
  assert.equal(result.tasks.length, MAX_BACKGROUND_TASKS);
  assert.equal(result.tasks[MAX_BACKGROUND_TASKS - 1].id, `m${MAX_BACKGROUND_TASKS - 1}`);
});

test('a long title is capped at 500 characters', () => {
  const result = snapshot({ milestones: [{ id: 'm1', title: 'x'.repeat(800), status: 'pending', attempts: 0 }] });
  assert.equal(result.tasks[0].title.length, 501);
  assert.ok(result.tasks[0].title.endsWith('…'));
});

test('the goal and the last event are single lines with control characters removed', () => {
  const result = snapshot({ goal: 'Ship it\nand then\trest', lastEvent: 'line one\r\nline two\u0007' });
  assert.equal(result.goal, 'Ship it and then rest');
  assert.equal(result.lastEvent, 'line one line two');
  assert.ok(!serializeBackgroundSnapshot(result).includes('\n'));
});

test('a snapshot never carries file contents or extra run fields', () => {
  const source = {
    ...runSource(),
    fileContents: { 'src/a.ts': 'const hidden = "payload";' },
    apiKey: 'sk-live-abcdefgh1234',
    messages: [{ text: 'secret transcript' }]
  } as unknown as BackgroundRunSource;
  const raw = serializeBackgroundSnapshot(createBackgroundSnapshot(source));
  assert.ok(!raw.includes('const hidden'));
  assert.ok(!raw.includes('payload'));
  assert.ok(!raw.includes('abcdefgh1234'));
  assert.ok(!raw.includes('secret transcript'));
  assert.ok(!raw.includes('fileContents'));
  assert.ok(!raw.includes('apiKey'));
});

test('credentials mentioned in the goal or an event line are redacted', () => {
  const source = snapshot({
    goal: 'Use Authorization: Bearer abcdef123456 to call api_key=sk-live-abcdefgh1234',
    lastEvent: 'token=ghp_abcdefghijklmnop'
  });
  const raw = serializeBackgroundSnapshot(source);
  assert.ok(!raw.includes('abcdef123456'));
  assert.ok(!raw.includes('sk-live-abcdefgh1234'));
  assert.ok(!raw.includes('ghp_abcdefghijklmnop'));
  assert.ok(raw.includes('[redacted]'));
});

test('creation refuses a relative workspace root', () => {
  assert.throws(() => snapshot({ workspaceRoot: 'src/app' }), /absolute workspaceRoot/);
});

test('creation refuses an empty goal and a missing workspace root', () => {
  assert.throws(() => snapshot({ goal: '   ' }), /requires a goal/);
  assert.throws(
    () => createBackgroundSnapshot({ goal: 'x' } as unknown as BackgroundRunSource),
    /requires a workspaceRoot/
  );
});

test('a snapshot round-trips through serialize and parse unchanged', () => {
  const original = paused();
  const parsed = parseBackgroundSnapshot(serializeBackgroundSnapshot(original));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.snapshot, original);
});

test('serializing twice produces the same bytes, even after a parse', () => {
  const original = snapshot();
  const first = serializeBackgroundSnapshot(original);
  const parsed = parseBackgroundSnapshot(first);
  assert.ok(parsed.snapshot);
  assert.equal(serializeBackgroundSnapshot(parsed.snapshot), first);
});

test('invalid JSON is rejected without throwing', () => {
  assert.deepEqual(parseBackgroundSnapshot('{ not json'), {
    snapshot: null,
    errors: ['the snapshot is not valid JSON']
  });
});

test('an empty string, a non-object and an array are rejected', () => {
  assert.equal(parseBackgroundSnapshot('').errors.length, 1);
  assert.equal(parseBackgroundSnapshot('null').errors.length, 1);
  assert.equal(parseBackgroundSnapshot('[]').errors.length, 1);
  assert.equal(parseBackgroundSnapshot('"run"').errors.length, 1);
});

test('an unsupported version is rejected', () => {
  const parsed = parseBackgroundSnapshot(rawWith({ version: 2 }));
  assert.equal(parsed.snapshot, null);
  assert.ok(parsed.errors.some((error) => error.includes('version must be 1')));
});

test('unknown mode and status values are rejected', () => {
  const mode = parseBackgroundSnapshot(rawWith({ mode: 'solo' }));
  assert.equal(mode.snapshot, null);
  assert.ok(mode.errors.some((error) => error.includes('mode')));

  const status = parseBackgroundSnapshot(rawWith({ status: 'planning' }));
  assert.equal(status.snapshot, null);
  assert.ok(status.errors.some((error) => error.includes('status')));
});

test('negative or non-finite credits are rejected', () => {
  assert.equal(parseBackgroundSnapshot(rawWith({ creditsSpent: -1 })).snapshot, null);
  assert.equal(parseBackgroundSnapshot(rawWith({ budgetCredits: 0 })).snapshot, null);
  assert.equal(parseBackgroundSnapshot(rawWith({ creditsSpent: 'many' })).snapshot, null);
  const infinite = rawWith({}).replace(/"creditsSpent":[\d.]+/, '"creditsSpent":1e999');
  assert.equal(parseBackgroundSnapshot(infinite).snapshot, null);
});

test('a relative or traversal workspace root is rejected', () => {
  const relative = parseBackgroundSnapshot(rawWith({ workspaceRoot: 'src/app' }));
  assert.equal(relative.snapshot, null);
  assert.ok(relative.errors.some((error) => error.includes('absolute')));

  for (const corrupt of ['..\\..', '../..', '..']) {
    const parsed = parseBackgroundSnapshot(rawWith({ workspaceRoot: corrupt }));
    assert.equal(parsed.snapshot, null, `${corrupt} must be rejected`);
  }
});

test('missing required fields are listed as errors', () => {
  const parsed = parseBackgroundSnapshot(rawWith({ goal: undefined, runId: undefined, interrupted: undefined }));
  assert.equal(parsed.snapshot, null);
  assert.ok(parsed.errors.some((error) => error.includes('goal')));
  assert.ok(parsed.errors.some((error) => error.includes('runId')));
  assert.ok(parsed.errors.some((error) => error.includes('interrupted')));
});

test('a bad task list is rejected with the offending index', () => {
  const notArray = parseBackgroundSnapshot(rawWith({ tasks: 'none' }));
  assert.equal(notArray.snapshot, null);

  const badStatus = parseBackgroundSnapshot(rawWith({
    tasks: [{ id: 't1', title: 'x', status: 'sideways', attempts: 0 }]
  }));
  assert.equal(badStatus.snapshot, null);
  assert.ok(badStatus.errors.some((error) => error.includes('tasks[0].status')));

  const badAttempts = parseBackgroundSnapshot(rawWith({
    tasks: [{ id: 't1', title: 'x', status: 'passed', attempts: -2 }]
  }));
  assert.equal(badAttempts.snapshot, null);

  const tooMany = parseBackgroundSnapshot(rawWith({
    tasks: Array.from({ length: MAX_BACKGROUND_TASKS + 1 }, (_, index) => ({
      id: `t${index}`,
      title: 'x',
      status: 'pending',
      attempts: 0
    }))
  }));
  assert.equal(tooMany.snapshot, null);
  assert.ok(tooMany.errors.some((error) => error.includes('more than')));
});

test('an updatedAt before startedAt is rejected', () => {
  const parsed = parseBackgroundSnapshot(rawWith({ startedAt: 5_000, updatedAt: 1_000 }));
  assert.equal(parsed.snapshot, null);
  assert.ok(parsed.errors.some((error) => error.includes('updatedAt')));
});

test('a running snapshot settles to paused and keeps updatedAt', () => {
  const original = snapshot();
  const settled = settleInterrupted(original);
  assert.equal(settled.status, 'paused');
  assert.equal(settled.interrupted, true);
  assert.equal(settled.updatedAt, original.updatedAt);
  assert.equal(original.status, 'running', 'the input is untouched');
});

test('a done snapshot settles unchanged, as a copy', () => {
  const original = snapshot({ status: 'done', interrupted: false });
  const settled = settleInterrupted(original);
  assert.notStrictEqual(settled, original);
  assert.equal(settled.status, 'done');
  assert.equal(settled.interrupted, false);
  assert.equal(settled.updatedAt, original.updatedAt);
});

test('settle copies the task list instead of sharing it', () => {
  const original = paused();
  const settled = settleInterrupted(original);
  assert.notStrictEqual(settled.tasks, original.tasks);
  assert.notStrictEqual(settled.tasks[0], original.tasks[0]);
});

test('a paused run resumes in the same workspace', () => {
  assert.deepEqual(canResume(paused(), ROOT), { ok: true });
});

test('Windows paths compare without case or separator differences', () => {
  assert.deepEqual(canResume(paused(), 'c:/users/work/project/'), { ok: true });
  assert.deepEqual(canResume(paused(), 'C:\\Users\\Work\\Project'), { ok: true });
});

test('a run does not resume in a different workspace', () => {
  const check = canResume(paused(), 'C:\\Users\\Work\\Other');
  assert.equal(check.ok, false);
  assert.ok(check.reason?.includes('open workspace'));
});

test('POSIX paths stay case-sensitive', () => {
  const run = paused({ workspaceRoot: '/home/work/Project' });
  assert.equal(canResume(run, '/home/work/Project').ok, true);
  assert.equal(canResume(run, '/home/work/project').ok, false);
});

test('a running snapshot cannot resume before it is settled', () => {
  const check = canResume(snapshot(), ROOT);
  assert.equal(check.ok, false);
  assert.ok(check.reason?.includes('running'));
});

test('an exhausted budget blocks the resume', () => {
  const check = canResume(paused({ creditsSpent: 24 }), ROOT);
  assert.equal(check.ok, false);
  assert.ok(check.reason?.includes('budget'));

  const overspent = canResume(paused({ creditsSpent: 30 }), ROOT);
  assert.equal(overspent.ok, false);
});

test('fewer than 0.1 credits left blocks the resume, 0.1 is enough', () => {
  assert.equal(canResume(paused({ creditsSpent: 19.96, budgetCredits: 20 }), ROOT).ok, false);
  assert.deepEqual(canResume(paused({ creditsSpent: 19.9, budgetCredits: 20 }), ROOT), { ok: true });
});

test('the resume summary counts pending and running tasks and pluralizes', () => {
  const five: BackgroundTaskSource[] = [
    { id: 't1', title: 'a', status: 'passed', attempts: 1 },
    { id: 't2', title: 'b', status: 'failed', attempts: 1 },
    { id: 't3', title: 'c', status: 'passed', attempts: 1 },
    { id: 't4', title: 'd', status: 'pending', attempts: 0 },
    { id: 't5', title: 'e', status: 'running', attempts: 1 }
  ];
  assert.equal(
    resumeSummary(snapshot({ milestones: five, creditsSpent: 3.4, budgetCredits: 24 })),
    'Resume: 2 of 5 tasks left, 3.4 spent of the 24 budget.'
  );
  assert.equal(
    resumeSummary(snapshot({ milestones: [five[3]], creditsSpent: 1, budgetCredits: 20 })),
    'Resume: 1 of 1 task left, 1 spent of the 20 budget.'
  );
});

test('the memory store saves, upserts, loads and removes by run id', () => {
  const store = createMemoryStore();
  store.save(snapshot());
  assert.equal(store.load().length, 1);
  assert.equal(parseBackgroundSnapshot(store.load()[0]).snapshot?.creditsSpent, 3.4);

  store.save(snapshot({ creditsSpent: 4.2 }));
  assert.equal(store.load().length, 1, 'the same run id is replaced, not duplicated');
  assert.equal(parseBackgroundSnapshot(store.load()[0]).snapshot?.creditsSpent, 4.2);

  store.save(snapshot({ id: 'run-2', goal: 'Second run' }));
  store.remove('run-1');
  const left = store.load();
  assert.equal(left.length, 1);
  assert.equal(parseBackgroundSnapshot(left[0]).snapshot?.runId, 'run-2');
});

test('the memory store seeds from snapshots and raw strings, and load returns a copy', () => {
  const store = createMemoryStore([snapshot(), serializeBackgroundSnapshot(snapshot({ id: 'run-9' }))]);
  assert.equal(store.load().length, 2);
  const loaded = store.load();
  loaded.push('garbage');
  assert.equal(store.load().length, 2, 'the returned array is a copy');
});

test('the memory store refuses a snapshot without a run id', () => {
  const store = createMemoryStore();
  assert.throws(() => store.save({ ...snapshot(), runId: '  ' }), /needs a runId/);
});

test('pruning keeps the five most recent snapshots', () => {
  const store = createMemoryStore();
  for (let index = 1; index <= 7; index += 1) {
    store.save(snapshot({ id: `run-${index}`, updatedAt: index * 100, startedAt: 0 }));
  }
  const kept = pruneSnapshots(store);
  assert.deepEqual(kept.map((entry) => entry.runId), ['run-7', 'run-6', 'run-5', 'run-4', 'run-3']);
  assert.deepEqual(
    loadSnapshots(store).map((entry) => entry.runId),
    ['run-7', 'run-6', 'run-5', 'run-4', 'run-3']
  );
});

test('pruning honours a smaller keep and can clear everything', () => {
  const store = createMemoryStore();
  for (let index = 1; index <= 4; index += 1) {
    store.save(snapshot({ id: `run-${index}`, updatedAt: index, startedAt: 0 }));
  }
  assert.deepEqual(pruneSnapshots(store, 2).map((entry) => entry.runId), ['run-4', 'run-3']);
  assert.equal(pruneSnapshots(store, 0).length, 0);
  assert.equal(loadSnapshots(store).length, 0);
});

test('pruning ignores unreadable entries instead of throwing', () => {
  const store = createMemoryStore([snapshot(), '{ not json']);
  const kept = pruneSnapshots(store, 5);
  assert.deepEqual(kept.map((entry) => entry.runId), ['run-1']);
  assert.equal(store.load().length, 2, 'garbage has no run id to remove it by');
});

test('no exported function mutates its input', () => {
  const source = runSource();
  const sourceBefore = clone(source);
  const created = createBackgroundSnapshot(source);
  assert.deepEqual(source, sourceBefore, 'create leaves the source run alone');

  const createdBefore = clone(created);
  serializeBackgroundSnapshot(created);
  assert.deepEqual(created, createdBefore, 'serialize leaves the snapshot alone');

  const raw = serializeBackgroundSnapshot(created);
  const rawCopy = String(raw);
  parseBackgroundSnapshot(raw);
  assert.equal(raw, rawCopy, 'parse leaves the raw string alone');

  const check = canResume(settleInterrupted(created), ROOT);
  assert.equal(check.ok, true);
  assert.deepEqual(created, createdBefore, 'canResume leaves the snapshot alone');
  resumeSummary(created);
  assert.deepEqual(created, createdBefore, 'resumeSummary leaves the snapshot alone');

  const store = createMemoryStore([created]);
  const storeSnapshot = loadSnapshots(store)[0];
  const snapshotBefore = clone(storeSnapshot);
  pruneSnapshots(store, 1);
  assert.deepEqual(storeSnapshot, snapshotBefore, 'prune leaves loaded snapshots alone');
  assert.deepEqual(created, createdBefore, 'store save leaves the snapshot alone');
});
