import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_KEEP_RECENT,
  HISTORY_BUDGET_RATIO,
  compactHistory
} from './compaction';
import { messageBudgetChars } from './contextBudget';
import { SEARCH_ORIGINAL_MARKER } from './patchEngine';
import type { ChatMessage } from './types';

type TestMessage = ChatMessage & { patches?: readonly unknown[] };

let counter = 0;

function message(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<TestMessage> = {}
): TestMessage {
  counter += 1;
  return {
    ...extra,
    id: extra.id ?? `m${counter}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    role,
    content
  };
}

function user(content: string, extra: Partial<TestMessage> = {}): TestMessage {
  return message('user', content, extra);
}

function model(content: string, extra: Partial<TestMessage> = {}): TestMessage {
  return message('model', content, extra);
}

const SR_FENCE = [
  '```path=src/a.ts',
  SEARCH_ORIGINAL_MARKER,
  'const old = 1;',
  '=======',
  'const next = 2;',
  '>>>>>>> UPDATED',
  '```'
].join('\n');

const CONTEXT_WINDOW = 32_000;

function toolTurn(): TestMessage {
  return model(
    [
      'Sure — reading the file first.',
      '```shadrox:tools',
      '[{"name":"read_file","args":{"path":"src/a.ts"}}]',
      '```',
      'Now the edit:',
      SR_FENCE,
      'Applied above.'
    ].join('\n'),
    {
      toolRounds: 2,
      toolActivity: [
        { name: 'Read', label: 'a.ts', ok: true },
        { name: 'Read', label: 'b.ts', ok: true }
      ]
    }
  );
}

function fileBodyPaste(lines = 40): TestMessage {
  const body = Array.from({ length: lines }, (_, index) => `line-${index} = ${index};`).join('\n');
  return user(['Here is src/a.ts:', '```ts path=src/a.ts', body, '```'].join('\n'));
}

/** Four live turns after the ones under test, so the default keepRecent covers them. */
function around(...older: TestMessage[]): TestMessage[] {
  return [...older, user('q'), model('a'), user('b'), model('c')];
}

test('the newest keepRecent messages pass through byte-identical', () => {
  const messages = [toolTurn(), user('and now?'), model('done'), user('ship it'), model('shipped')];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 2 });

  assert.equal(result.messages[3], messages[3]);
  assert.equal(result.messages[4], messages[4]);
  assert.ok(result.messages[0].content.length < messages[0].content.length);
  assert.equal(DEFAULT_KEEP_RECENT, 4);
});

test('the default keeps the four newest messages untouched', () => {
  const messages = [toolTurn(), toolTurn(), user('q'), model('a'), user('b'), model('c')];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW });

  assert.notEqual(result.messages[1], messages[1], 'the older turn was folded');
  assert.equal(result.messages[2], messages[2], 'the last four messages pass through');
});

test('tool fences fold into a summary while an edit under review survives verbatim', () => {
  const turn = toolTurn();
  const result = compactHistory(around(turn), {
    contextWindow: CONTEXT_WINDOW,
    patchedMessageIds: new Set([turn.id])
  });
  const folded = result.messages[0].content;

  assert.ok(!folded.includes('shadrox:tools'), 'the request fence is gone');
  assert.ok(!folded.includes('read_file'), 'the JSON payload is gone');
  assert.ok(folded.includes('[tools] Read: a.ts, b.ts (ok)'), folded);
  assert.ok(folded.includes(SR_FENCE), 'an edit the user has not reviewed yet is byte-identical');
  assert.match(result.folds.join(' '), /folded 1 tool round/);
});

test('an edit block survives verbatim even when no review is pending', () => {
  const turn = toolTurn();
  const result = compactHistory(around(turn), { contextWindow: CONTEXT_WINDOW });
  const folded = result.messages[0].content;

  assert.ok(folded.includes(SR_FENCE), 'the search/replace body is never folded away');
  assert.ok(folded.includes(SEARCH_ORIGINAL_MARKER));
  assert.ok(folded.includes('Sure — reading the file first.'), 'the reason it was written survives');
  assert.ok(!folded.includes('shadrox:tools'), 'only the tool fence went');
});

test('a failed tool is still visible in the folded summary', () => {
  const turn = model('checking\n```shadrox:tools\n[{"name":"edit_file"}]\n```', {
    toolActivity: [{ name: 'Edit', label: 'src/a.ts', ok: false, error: 'not found' }]
  });
  const result = compactHistory(around(turn), { contextWindow: CONTEXT_WINDOW });
  assert.match(result.messages[0].content, /\[tools\] Edit: src\/a\.ts \(1 failed\)/);
});

test('a folded turn without toolActivity still says what went away', () => {
  const turn = model('answer\n```shadrox:tools\n[{"name":"list_files"}]\n```');
  const result = compactHistory(around(turn), { contextWindow: CONTEXT_WINDOW });

  assert.match(result.messages[0].content, /^\[tools\] 1 tool block folded\b/);
  assert.ok(result.messages[0].content.includes('answer'));
});

test('an unterminated tool fence from an interrupted stream folds too', () => {
  const turn = model('half a reply\n```shadrox:tools\n[{"name":"read_file","args":{');
  const result = compactHistory(around(turn), { contextWindow: CONTEXT_WINDOW });

  assert.ok(!result.messages[0].content.includes('read_file'));
  assert.ok(result.messages[0].content.includes('half a reply'));
});

test('a stale pasted file body keeps one line and reports the count', () => {
  const result = compactHistory(around(fileBodyPaste(40)), { contextWindow: CONTEXT_WINDOW });
  const folded = result.messages[0].content;

  assert.ok(folded.includes('```ts path=src/a.ts'), 'the path= fence still names the file');
  assert.ok(folded.includes('line-0 = 0;'));
  assert.ok(folded.includes('[… body dropped, 39 lines]'), folded);
  assert.ok(!folded.includes('line-20'), 'the dead weight is gone');
  assert.match(result.folds.join(' '), /dropped 1 stale file body/);
  assert.ok(result.tokensSaved > 0);
});

test('a short pasted snippet is left alone', () => {
  const paste = user(['look:', '```ts path=src/a.ts', 'const a = 1;', '```'].join('\n'));
  const result = compactHistory(around(paste), { contextWindow: CONTEXT_WINDOW });

  assert.equal(result.messages[0], paste);
  assert.equal(result.tokensSaved, 0);
  assert.deepEqual(result.folds, []);
});

test('an edit the user pasted is never treated as a dead file body', () => {
  const body = Array.from({ length: 20 }, (_, index) => `line-${index}`);
  const paste = user([
    'apply this:',
    '```path=src/a.ts',
    SEARCH_ORIGINAL_MARKER,
    ...body,
    '=======',
    'the replacement',
    '>>>>>>> UPDATED',
    '```'
  ].join('\n'));
  const result = compactHistory(around(paste), { contextWindow: CONTEXT_WINDOW });

  assert.equal(result.messages[0], paste);
  assert.ok(!result.folds.join(' ').includes('body dropped'));
});

test('pure acknowledgement turns collapse away', () => {
  const messages = [
    user('refactor the parser'),
    model('doing it'),
    user('ok'),
    user('theek hai'),
    user('continue'),
    model('done'),
    user('thanks!'),
    model('welcome')
  ];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 2 });

  assert.equal(result.messages.length, 5);
  assert.ok(!result.messages.some((entry) => entry.content.trim() === 'ok'));
  assert.match(result.folds.join(' '), /collapsed 3 acknowledgement messages/);
  assert.equal(result.messages[0], messages[0], 'the real request survives');
  assert.equal(result.messages[result.messages.length - 1], messages[7]);
});

test('a one-word answer that is not an acknowledgement is kept', () => {
  const messages = [user('ok'), model('src/a.ts'), user('q'), model('a')];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 2 });

  assert.equal(result.messages.length, 3, 'only the ack went');
  assert.ok(result.messages.some((entry) => entry.content === 'src/a.ts'));
});

test('compacting an already compacted history returns it untouched', () => {
  const once = compactHistory(
    [toolTurn(), fileBodyPaste(30), user('ok'), user('q'), model('a'), user('b'), model('c')],
    { contextWindow: CONTEXT_WINDOW, keepRecent: 2 }
  );
  const twice = compactHistory(once.messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 2 });

  assert.deepEqual(twice.messages, once.messages);
  assert.equal(twice.messages, once.messages, 'the caller gets its own array back');
  assert.equal(twice.tokensSaved, 0);
  assert.deepEqual(twice.folds, []);
});

test('a history with nothing to fold comes back as the caller array', () => {
  const messages = [user('what does this repo do?'), model('a coding assistant')];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW });

  assert.equal(result.messages, messages);
  assert.equal(result.tokensSaved, 0);
  assert.deepEqual(result.folds, []);
});

test('the input array and its messages are never mutated', () => {
  const messages = [toolTurn(), fileBodyPaste(30), user('ok'), user('q'), model('a')];
  const snapshot = JSON.parse(JSON.stringify(messages));
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 2 });

  assert.deepEqual(messages, snapshot);
  assert.notEqual(result.messages[0], messages[0]);
  assert.ok(messages[0].content.includes('shadrox:tools'));
});

test('a tight budget drops the oldest messages and never one carrying edits', () => {
  const patched = model(['keep this edit', SR_FENCE].join('\n'), { patches: [{ path: 'src/a.ts' }] });
  const filler = (tag: string): TestMessage => user(`${tag} ${'x'.repeat(900)}`);
  const messages = [
    toolTurn(),
    filler('old-1'),
    patched,
    filler('old-2'),
    filler('old-3'),
    user('and now?'),
    model('next')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 1_000
  });

  const total = result.messages.reduce((sum, entry) => sum + entry.content.length, 0);
  assert.ok(total <= 1_000, `the history fits the budget (${total})`);
  assert.ok(result.messages.includes(patched), 'the patched message survived');
  assert.ok(result.messages.includes(messages[6]), 'the newest message always stays');
  assert.ok(!result.messages.some((entry) => entry.content.includes('old-1')), 'the oldest went first');
  assert.match(result.folds.join(' '), /dropped \d+ oldest messages to fit the budget/);
});

test('patches held outside the message are located by id', () => {
  const patched = model('an edit to src/a.ts', { id: 'turn-7' });
  const noise = () => user(`noise ${'y'.repeat(1_200)}`);
  const messages = [patched, noise(), noise(), user('ok'), model('a'), user('b'), model('c')];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 600,
    patchedMessageIds: new Set(['turn-7'])
  });

  assert.ok(result.messages.includes(patched));
});

test('the newest message survives even when keepRecent is zero', () => {
  const messages = [user('ok'), user('ok'), model('the last word')];
  const result = compactHistory(messages, { contextWindow: CONTEXT_WINDOW, keepRecent: 0 });
  assert.deepEqual(result.messages.map((entry) => entry.content), ['the last word']);
});

test('the char budget defaults to half of the message budget for the model', () => {
  const expected = Math.floor(messageBudgetChars(CONTEXT_WINDOW) * HISTORY_BUDGET_RATIO);
  const result = compactHistory(
    around(toolTurn(), user(`a ${'z'.repeat(expected + 500)}`)),
    { contextWindow: CONTEXT_WINDOW }
  );
  const total = result.messages.reduce((sum, entry) => sum + entry.content.length, 0);

  assert.equal(HISTORY_BUDGET_RATIO, 0.5);
  assert.ok(total <= expected, `the folded history fits ${expected} (${total})`);
});

test('folding a turn rewrites only its content', () => {
  const turn = toolTurn();
  const result = compactHistory(around(turn), { contextWindow: CONTEXT_WINDOW });
  const folded = result.messages[0];

  assert.equal(folded.id, turn.id);
  assert.equal(folded.role, turn.role);
  assert.equal(folded.timestamp, turn.timestamp);
  assert.deepEqual(folded.toolActivity, turn.toolActivity);
  assert.equal(folded.toolRounds, 2);
});
