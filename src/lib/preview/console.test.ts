import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_LEVELS,
  CONSOLE_LIMIT,
  appendRecord,
  countByLevel,
  createRecord,
  filterRecords,
  formatClock,
  isDuplicateOfLast,
  latestError,
  parseBridgeMessage,
  recordsFromServerOutput,
  recordsToText
} from './console';

const T = 1_700_000_000_000;

function record(level: 'log' | 'warn' | 'error', message: string, id = 1) {
  return createRecord(id, level, message, T, 'page');
}

test('records clip oversized messages and keep an optional stack', () => {
  const small = createRecord(1, 'error', 'boom', T, 'server', '    at App.tsx:3:1');
  assert.equal(small.message, 'boom');
  assert.equal(small.stack, '    at App.tsx:3:1');

  const big = createRecord(2, 'log', 'x'.repeat(9000), T, 'page');
  assert.equal(big.message.length, 4000);

  const blankStack = createRecord(3, 'log', 'hi', T, 'page', '   ');
  assert.equal('stack' in blankStack, false);
});

test('the log buffer is bounded and drops the oldest entries first', () => {
  let records: ReturnType<typeof appendRecord> = [];
  for (let index = 0; index < CONSOLE_LIMIT + 25; index += 1) {
    records = appendRecord(records, createRecord(index, 'log', `line ${index}`, T, 'server'));
  }
  assert.equal(records.length, CONSOLE_LIMIT);
  assert.equal(records[0].message, `line ${(CONSOLE_LIMIT + 25) - CONSOLE_LIMIT}`);
  assert.equal(records[records.length - 1].message, `line ${CONSOLE_LIMIT + 24}`);
});

test('level filters and the query both narrow the list without mutating it', () => {
  const records = [record('log', 'hello', 1), record('warn', 'Careful hello', 2), record('error', 'boom', 3)];
  assert.deepEqual(filterRecords(records, { log: true, warn: false, error: true }).map((r) => r.level), ['log', 'error']);
  assert.deepEqual(filterRecords(records, ALL_LEVELS, 'hello').map((r) => r.id), [1, 2]);
  assert.deepEqual(filterRecords(records, ALL_LEVELS, '  BOOM ').map((r) => r.id), [3]);
  assert.equal(filterRecords(records, ALL_LEVELS).length, 3);
  assert.deepEqual(countByLevel(records), { log: 1, warn: 1, error: 1 });
  assert.equal(latestError(records)?.id, 3);
  assert.equal(latestError([record('log', 'x')]), null);
});

test('an error found through the stack query is still searchable', () => {
  const withStack = createRecord(1, 'error', 'Uncaught TypeError', T, 'page', 'at runThing (/src/lib/thing.ts:12:3)');
  assert.equal(filterRecords([withStack], ALL_LEVELS, 'thing.ts').length, 1);
  assert.equal(filterRecords([withStack], ALL_LEVELS, 'nothingmatches').length, 0);
});

test('clock text and clipboard text are stable', () => {
  assert.match(formatClock(T), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(formatClock(Number.NaN), '--:--:--');

  const text = recordsToText([
    createRecord(1, 'error', 'boom', T, 'page', 'at App.tsx:1:2'),
    createRecord(2, 'log', 'ok', T, 'server')
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\.\d{3}  ERROR  boom$/);
  assert.equal(lines[1], 'at App.tsx:1:2');
  assert.match(lines[2], /^\d{2}:\d{2}:\d{2}\.\d{3}  LOG    ok$/);
});

test('repeating identical entries are collapsed so a loop cannot flood the drawer', () => {
  const records = [record('error', 'same', 1)];
  assert.equal(isDuplicateOfLast(records, record('error', 'same', 2)), true);
  assert.equal(isDuplicateOfLast(records, record('warn', 'same', 2)), false);
  assert.equal(isDuplicateOfLast([], record('error', 'same', 2)), false);
});

test('bridge messages are parsed by level, and hostile or unknown ones are ignored', () => {
  assert.deepEqual(parseBridgeMessage({ source: 'shadrox-preview', type: 'console-warn', message: 'meh' }), {
    kind: 'record',
    level: 'warn',
    message: 'meh'
  });
  assert.deepEqual(parseBridgeMessage({ source: 'shadrox-preview', type: 'console-error', message: 'bad', stack: 'at x' }), {
    kind: 'record',
    level: 'error',
    message: 'bad',
    stack: 'at x'
  });
  assert.deepEqual(parseBridgeMessage({ source: 'shadrox-preview', type: 'error', message: '' }), {
    kind: 'record',
    level: 'error',
    message: 'Runtime error',
    stack: undefined
  });
  assert.deepEqual(parseBridgeMessage({ source: 'shadrox-preview', type: 'console-log', message: 'hi' }), {
    kind: 'record',
    level: 'log',
    message: 'hi'
  });
  assert.deepEqual(parseBridgeMessage({ source: 'other', type: 'console-log', message: 'hi' }), { kind: 'ignored' });
  assert.deepEqual(parseBridgeMessage({ source: 'shadrox-preview', type: 'open-devtools' }), { kind: 'ignored' });
  assert.deepEqual(parseBridgeMessage(null), { kind: 'ignored' });
});

test('reveal messages stay a separate channel so console parsing cannot eat them', () => {
  const parsed = parseBridgeMessage({
    source: 'shadrox-preview',
    type: 'reveal-source',
    path: 'index.html',
    tag: 'div',
    id: 'hero',
    className: 'card',
    text: 'Hello'
  });
  assert.equal(parsed.kind, 'reveal');
  if (parsed.kind === 'reveal') assert.equal(parsed.target.id, 'hero');

  assert.deepEqual(
    parseBridgeMessage({ source: 'shadrox-preview', type: 'reveal-source', path: '../x.html', tag: 'div' }),
    { kind: 'ignored' }
  );
});

test('dev server output lines become real records, keeping their own levels', () => {
  const records = recordsFromServerOutput(
    [
      { type: 'stdout', message: 'vite v5 ready' },
      { type: 'stderr', message: 'Port 5173 is in use' },
      { type: 'status', message: 'Installing 3 missing dependencies...' },
      { type: 'install', message: 'npm install' }
    ],
    7,
    T
  );
  assert.deepEqual(records.map((entry) => entry.level), ['log', 'error', 'warn', 'warn']);
  assert.deepEqual(records.map((entry) => entry.id), [7, 8, 9, 10]);
  assert.equal(records[0].origin, 'server');
  assert.equal(records[1].message, 'Port 5173 is in use');
});
