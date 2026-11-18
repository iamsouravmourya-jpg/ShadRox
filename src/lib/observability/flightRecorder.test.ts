import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFlightRecorder,
  flightRecorder,
  MAX_EVENTS_PER_RUN,
  MAX_FIELD_CHARS,
  MAX_RUN_BYTES,
  MAX_RUNS_KEPT,
  type FlightEvent,
  type FlightEventType,
  type RecorderStorage
} from './flightRecorder';
import { classifyFailure, toolErrorCode, FAILURE_LABELS, type FailureCode } from './failureTaxonomy';

/** A localStorage-shaped backend the tests can inspect and break on purpose. */
function memoryStorage(): RecorderStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { writes += 1; data.set(key, value); },
    removeItem: (key) => { data.delete(key); }
  };
}

function ev(seq: number, type: FlightEventType, data: Record<string, unknown> = {}): FlightEvent {
  return { seq, at: 1000 + seq, runId: 'run-test', type, data };
}

/* ------------------------------------------------------------------ *
 * Recorder: sequence, privacy, caps, persistence, fail-open.
 * ------------------------------------------------------------------ */

test('events are append-only with a strict per-run sequence and a stop at the end', () => {
  const recorder = createFlightRecorder({ storage: memoryStorage() });
  const runId = recorder.startRun({ kind: 'tool-loop', workspaceId: 'ws' });
  recorder.record('context_assembled', { messages: 2 });
  recorder.record('tool_call_started', { tool: 'read_file' });
  recorder.record('tool_result', { tool: 'read_file', status: 'ok', ms: 4 });
  recorder.stopRun('complete', { rounds: 2 });
  const events = recorder.readEvents(runId);
  assert.deepEqual(events.map((event) => event.type), [
    'turn_started', 'context_assembled', 'tool_call_started', 'tool_result', 'stop'
  ]);
  events.forEach((event, index) => {
    assert.equal(event.seq, index);
    assert.equal(event.runId, runId);
  });
  const summary = recorder.listRuns()[0];
  assert.equal(summary.stopReason, 'complete');
  assert.equal(summary.events, 5);
  assert.equal(summary.failure, undefined, 'a clean run gets no failure tag');
  assert.ok(!events.some((event) => event.type === 'failure_tag'));
});

test('credentials are scrubbed before events are buffered or written', () => {
  const storage = memoryStorage();
  const recorder = createFlightRecorder({ storage });
  const secret = 'sk-abcdefghijklmnopqrstuvwx123456';
  const runId = recorder.startRun();
  recorder.record('command_requested', {
    command: `echo API_KEY=${secret}`,
    note: `token ${secret} and Bearer abcdefghijklmnopqrstuvwxyz123456`
  });
  recorder.stopRun('complete');
  const events = recorder.readEvents(runId);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(secret), 'the raw key never reaches memory');
  assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz123456'), 'bearer tokens are scrubbed too');
  assert.match(serialized, /\[REDACTED_SECRET\]/);
  const persisted = storage.data.get(`shadrox.flight.run:${runId}`) ?? '';
  assert.ok(!persisted.includes(secret), 'the raw key never reaches storage');
  assert.match(persisted, /\[REDACTED_SECRET\]/);
});

test('string fields are capped so one event cannot eat the log', () => {
  const recorder = createFlightRecorder({ storage: memoryStorage() });
  const runId = recorder.startRun();
  recorder.record('tool_result', { error: 'x'.repeat(MAX_FIELD_CHARS * 3) });
  const event = recorder.readEvents(runId).at(-1)!;
  assert.equal(String(event.data.error).length, MAX_FIELD_CHARS + '…[cut]'.length);
});

test('persistence is capped JSONL per run, readable by a fresh recorder after a reload', () => {
  const storage = memoryStorage();
  const first = createFlightRecorder({ storage });
  const runId = first.startRun({ kind: 'tool-loop', workspaceId: 'ws' });
  first.record('tool_call_started', { tool: 'read_file' });
  first.record('tool_result', { tool: 'read_file', status: 'ok' });
  first.stopRun('complete', { rounds: 1 });
  const raw = storage.data.get(`shadrox.flight.run:${runId}`)!;
  const lines = raw.split('\n');
  assert.equal(lines.length, 4, 'one JSON object per line: turn_started + 2 events + stop');
  lines.forEach((line) => assert.ok(JSON.parse(line).type));
  const index = JSON.parse(storage.data.get('shadrox.flight.index')!);
  assert.equal(index[0].runId, runId);

  // A "reload": a brand-new recorder over the same storage reads the same trace.
  const second = createFlightRecorder({ storage });
  const events = second.readEvents(runId);
  assert.deepEqual(events.map((event) => event.type), ['turn_started', 'tool_call_started', 'tool_result', 'stop']);
  assert.equal(second.listRuns()[0].stopReason, 'complete');
});

test('the event tail is capped per run and the truncation is flagged', () => {
  const recorder = createFlightRecorder({ storage: memoryStorage() });
  const runId = recorder.startRun();
  for (let index = 0; index < MAX_EVENTS_PER_RUN + 50; index += 1) {
    recorder.record('tool_result', { index });
  }
  const events = recorder.readEvents(runId);
  assert.equal(events.length, MAX_EVENTS_PER_RUN);
  assert.equal(events[0].data.index, 50, 'the oldest events were dropped, the tail kept');
  assert.equal(recorder.listRuns()[0].truncated, true);
});

test('the persisted byte cap keeps the tail of a fat run', () => {
  const storage = memoryStorage();
  const recorder = createFlightRecorder({ storage });
  const runId = recorder.startRun();
  for (let index = 0; index < 500; index += 1) {
    recorder.record('tool_result', { blob: 'y'.repeat(MAX_FIELD_CHARS - 10), index });
  }
  recorder.stopRun('complete');
  const raw = storage.data.get(`shadrox.flight.run:${runId}`)!;
  assert.ok(raw.length <= MAX_RUN_BYTES, `persisted ${raw.length} bytes <= ${MAX_RUN_BYTES}`);
  assert.ok(raw.includes('"index":499'), 'the end of the run — where the failure lives — is kept');
});

test('old runs are pruned past the keep limit', () => {
  const storage = memoryStorage();
  const recorder = createFlightRecorder({ storage });
  const ids: string[] = [];
  for (let index = 0; index < MAX_RUNS_KEPT + 5; index += 1) {
    const id = recorder.startRun();
    recorder.stopRun('complete');
    ids.push(id);
  }
  const runs = recorder.listRuns();
  assert.ok(runs.length <= MAX_RUNS_KEPT);
  assert.ok(!storage.data.has(`shadrox.flight.run:${ids[0]}`), 'the oldest run file was pruned');
  assert.ok(storage.data.has(`shadrox.flight.run:${ids.at(-1)}`), 'the newest run survives');
});

test('a storage that throws never breaks the caller: fail-open with a recorded failure', () => {
  const broken: RecorderStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QUOTA_EXCEEDED'); },
    removeItem: () => {}
  };
  const recorder = createFlightRecorder({ storage: broken });
  const runId = recorder.startRun();
  assert.doesNotThrow(() => {
    recorder.record('tool_result', { status: 'ok' });
    recorder.stopRun('complete');
    recorder.flush();
  });
  const events = recorder.readEvents(runId);
  assert.ok(events.some((event) => event.type === 'recorder_error'), 'the write failure is itself on record');
  assert.ok(events.some((event) => event.type === 'stop'), 'the run still completed its trace in memory');
});

test('setEnabled(false) stops recording but keeps the read API; default is ON', () => {
  const recorder = createFlightRecorder({ storage: memoryStorage() });
  assert.equal(recorder.isEnabled(), true);
  const runId = recorder.startRun();
  recorder.record('tool_result', { status: 'ok' });
  recorder.setEnabled(false);
  recorder.record('tool_result', { status: 'error' });
  recorder.stopRun('complete');
  const events = recorder.readEvents(runId);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 1, 'disabled events are dropped');
  assert.ok(recorder.listRuns().length >= 1, 'reads still work while disabled');
  recorder.setEnabled(true);
  recorder.record('retry', { attempt: 1 }, runId);
  assert.ok(recorder.readEvents(runId).some((event) => event.type === 'retry'));
});

test('a failed stop is tagged with exactly one primary failure code', () => {
  const recorder = createFlightRecorder({ storage: memoryStorage() });
  const runId = recorder.startRun();
  recorder.record('tool_result', { tool: 'edit_file', status: 'error', error: 'The original snippet was not found in a.ts.' });
  recorder.stopRun('step_cap', { rounds: 60 });
  const events = recorder.readEvents(runId);
  const tags = events.filter((event) => event.type === 'failure_tag');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].data.code, 'F08', 'the stop cause outranks the inner edit failure');
  assert.equal(recorder.listRuns()[0].failure?.code, 'F08');
});

test('recording with no open run creates an implicit one; reset clears everything', () => {
  const storage = memoryStorage();
  const recorder = createFlightRecorder({ storage });
  recorder.record('model_request', { model: 'm' });
  assert.ok(recorder.activeRunId());
  assert.equal(recorder.listRuns()[0].kind, 'implicit');
  recorder.reset();
  assert.equal(recorder.listRuns().length, 0);
  assert.equal(recorder.activeRunId(), null);
  assert.equal(storage.data.size, 0);
});

test('the singleton is enabled by default and safe to reset between tests', () => {
  flightRecorder.reset();
  assert.equal(flightRecorder.isEnabled(), true);
  const runId = flightRecorder.startRun({ kind: 'tool-loop' });
  flightRecorder.record('tool_result', { status: 'ok' });
  flightRecorder.stopRun('complete');
  assert.equal(flightRecorder.readEvents(runId).at(-1)!.type, 'stop');
  flightRecorder.reset();
});

/* ------------------------------------------------------------------ *
 * Taxonomy: one primary code per failure shape, derived from events.
 * ------------------------------------------------------------------ */

const tag = (events: FlightEvent[]): FailureCode | null => classifyFailure(events)?.code ?? null;

test('F08: the step cap is the primary code even when edits failed inside the run', () => {
  const events = [
    ev(0, 'turn_started'),
    ev(1, 'tool_result', { tool: 'edit_file', status: 'error', error: 'The original snippet was not found in a.ts.' }),
    ev(2, 'stop', { reason: 'step_cap', rounds: 60 })
  ];
  const result = classifyFailure(events)!;
  assert.equal(result.code, 'F08');
  assert.equal(result.confidence, 'high');
});

test('F09: provider errors and truncation', () => {
  assert.equal(tag([ev(0, 'provider_error', { code: 'RateLimitError' }), ev(1, 'stop', { reason: 'provider_error' })]), 'F09');
  assert.equal(tag([ev(0, 'usage', { truncated: true }), ev(1, 'stop', { reason: 'complete' })]), null, 'a clean stop with truncation is still classified');
  assert.equal(tag([ev(0, 'usage', { truncated: true }), ev(1, 'stop', { reason: 'provider_error' })]), 'F09');
  assert.equal(tag([ev(0, 'stream_end', { truncated: true, outcome: 'provider_error' }), ev(1, 'stop', { reason: 'provider_error' })]), 'F09');
});

test('F10: aborts and declined approvals', () => {
  assert.equal(tag([ev(0, 'stop', { reason: 'aborted' })]), 'F10');
  assert.equal(tag([
    ev(0, 'command_decision', { decision: 'deny', source: 'native-approval' }),
    ev(1, 'stop', { reason: 'complete' })
  ]), null, 'a declined command in an otherwise clean run does not fail the run');
  assert.equal(tag([
    ev(0, 'command_decision', { decision: 'deny', source: 'native-approval' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F10');
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'mcp__db__query', status: 'refused', refused: true, error: 'The user did not allow this tool. Do not retry.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F10');
});

test('F05: command timeout', () => {
  assert.equal(tag([ev(0, 'command_finished', { exit: null, timedOut: true }), ev(1, 'stop', { reason: 'stuck' })]), 'F05');
});

test('F04: the command guard refused the command itself', () => {
  assert.equal(tag([
    ev(0, 'command_decision', { decision: 'deny', source: 'command-policy', tier: 'execute' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F04');
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'run_command', status: 'refused', refused: true, error: 'Blocked by the command guard: destructive command.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F04');
});

test('F01: wrong lane for the permission mode', () => {
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'run_command', status: 'refused', refused: true, error: 'ask mode does not allow execute actions.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F01');
});

test('F03: edit NOT_FOUND and AMBIGUOUS', () => {
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'edit_file', status: 'error', error_code: 'NOT_FOUND', error: 'The original snippet was not found in a.ts.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F03');
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'edit_file', status: 'error', error_code: 'AMBIGUOUS', error: 'The original snippet appears more than once in a.ts.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F03');
});

test('F11: stale buffer / version conflict', () => {
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'write_file', status: 'error', error: 'a.ts was not saved: the file changed since it was read.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F11');
});

test('F02: invalid or unparsable tool arguments', () => {
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'read_file', status: 'refused', refused: true, error: 'read_file needs a path.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F02');
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'read_file', status: 'refused', refused: true, error: 'The tool arguments were incomplete or invalid JSON — likely the reply was cut off.' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F02');
});

test('F07: verification false-fail proven by a later clean exit', () => {
  assert.equal(tag([
    ev(0, 'verify_result', { ok: false, stage: 'pre-apply' }),
    ev(1, 'command_finished', { exit: 0 }),
    ev(2, 'stop', { reason: 'stuck' })
  ]), 'F07');
  // Without the later evidence it is NOT a false-fail claim.
  assert.notEqual(tag([ev(0, 'verify_result', { ok: false }), ev(1, 'stop', { reason: 'stuck' })]), 'F07');
});

test('F06: stuck without ever reading a file; F12 when reads did happen', () => {
  assert.equal(tag([
    ev(0, 'tool_result', { tool: 'search_text', status: 'ok' }),
    ev(1, 'stop', { reason: 'stuck' })
  ]), 'F06');
  const withReads = classifyFailure([
    ev(0, 'tool_result', { tool: 'read_file', status: 'ok' }),
    ev(1, 'stop', { reason: 'stuck' })
  ])!;
  assert.equal(withReads.code, 'F12');
  assert.equal(withReads.confidence, 'medium');
});

test('unknown failures are F12 with low confidence, and clean runs are untagged', () => {
  const unknown = classifyFailure([
    ev(0, 'tool_result', { tool: 'read_file', status: 'error', error_code: 'ERROR', error: 'something odd happened' }),
    ev(1, 'stop', { reason: 'error' })
  ])!;
  assert.equal(unknown.code, 'F12');
  assert.equal(unknown.confidence, 'low');
  assert.equal(classifyFailure([ev(0, 'turn_started'), ev(1, 'stop', { reason: 'complete' })]), null);
  assert.equal(classifyFailure([ev(0, 'turn_started'), ev(1, 'stop', { reason: 'finish' })]), null);
  assert.equal(classifyFailure([]), null);
  // A run that never stopped at all is unexplained, not silently clean.
  assert.equal(classifyFailure([ev(0, 'turn_started')])?.code, 'F12');
});

test('every code has a human label', () => {
  const codes: FailureCode[] = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12'];
  codes.forEach((code) => assert.ok(FAILURE_LABELS[code].length > 0));
});

test('toolErrorCode maps outcome shapes to stable codes', () => {
  assert.equal(toolErrorCode({ ok: true }), undefined);
  assert.equal(toolErrorCode({ ok: false, refused: true, error: 'ask mode does not allow execute actions.' }), 'POLICY');
  assert.equal(toolErrorCode({ ok: false, refused: true, error: 'Command was not approved.' }), 'DENIED');
  assert.equal(toolErrorCode({ ok: false, error: 'The original snippet was not found in a.ts.' }), 'NOT_FOUND');
  assert.equal(toolErrorCode({ ok: false, error: 'The original snippet appears more than once in a.ts.' }), 'AMBIGUOUS');
  assert.equal(toolErrorCode({ ok: false, error: 'Not written — a.ts:3 type error' }), 'VERIFY');
  assert.equal(toolErrorCode({ ok: false, error: 'ENOENT: no such file' }), 'NOT_FOUND');
  assert.equal(toolErrorCode({ ok: false, refused: true, error: 'read_file needs a path.' }), 'BAD_ARGS');
  assert.equal(toolErrorCode({ ok: false, error: 'weird failure' }), 'ERROR');
});