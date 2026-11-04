import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_KEEP_RECENT,
  HISTORY_BUDGET_RATIO,
  compactHistory
} from './compaction';
import {
  DEFAULT_KEEP_FIRST_HEAD,
  FIRST_CONDENSATION_PROMPT,
  observationAnchors
} from './compaction/openhands';
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

test('a tight budget condenses the middle and keeps head and tail verbatim', () => {
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
    maxHistoryChars: 2_500
  });

  const total = result.messages.reduce((sum, entry) => sum + entry.content.length, 0);
  assert.ok(total <= 2_500, `the history fits the budget (${total})`);
  assert.ok(result.messages.includes(messages[1]), 'the protected head keeps the oldest exchange');
  assert.ok(result.messages.includes(patched), 'the patched message survived');
  assert.ok(result.messages.includes(messages[6]), 'the newest message always stays');
  assert.ok(!result.messages.includes(messages[3]), 'the oldest middle message was digested');
  assert.ok(result.messages.includes(messages[4]),
    'only as much as the overrun demanded was condensed — the newer middle message stayed');
  const digest = result.messages.find((entry) => entry.content.startsWith('[condensed'));
  assert.ok(digest, 'the middle was summarized, not silently lost');
  assert.match(digest.content, /\[condensed 1 older message\]/);
  assert.match(result.folds.join(' '), /condensed 1 middle message into 1 digest/);
});

test('condensation alone cannot fit the budget, the hard reset drops the unprotected oldest', () => {
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
  assert.ok(result.messages.some((entry) => entry.content.startsWith('[condensed')), 'the digest survived the reset');
  assert.ok(result.messages.includes(patched), 'even the hard reset never drops an edit carrier');
  assert.ok(result.messages.includes(messages[6]));
  assert.ok(!result.messages.some((entry) => entry.content.includes('old-1')), 'the unprotected oldest went last');
  assert.match(result.folds.join(' '), /dropped 1 oldest message to fit the budget/);
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

/* ------------------------------------------------------------------ *
 * Ported from the OpenHands condenser lineage (MIT): the keep_first head
 * rule, the TruncatingCondenser pair rule, minimum_progress, and the
 * LLMSummarizingCondenser's summarize-the-middle — adapted to ShadRox's
 * message array. See src/lib/compaction/openhands.ts.
 * ------------------------------------------------------------------ */

test('the keep-first head defaults to two messages, the ported keep_first', () => {
  assert.equal(DEFAULT_KEEP_FIRST_HEAD, 2);
  const messages = [
    user('ask the original question'),
    model('the original answer'),
    user('ok'),
    user(`junk ${'k'.repeat(1_500)}`),
    user(`older ${'l'.repeat(1_500)}`),
    user('q'),
    model('a')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 300
  });

  assert.equal(result.messages[0], messages[0], 'the original request is always kept');
  assert.equal(result.messages[1], messages[1]);
  assert.ok(result.messages.some((entry) => entry.content.startsWith('[condensed')), 'the middle became a digest');
  assert.ok(!result.messages.includes(messages[3]), 'the bulk went, the head stayed');
});

test('an action is never cut from its observation', () => {
  const action = model(
    [
      'running:',
      '```shadrox:tools',
      '[{"name":"edit_file","args":{"path":"src/a.ts"}}]',
      '```',
      SR_FENCE
    ].join('\n'),
    { patches: [{ path: 'src/a.ts' }] }
  );
  const observation = user([
    '```shadrox:results',
    '[{"tool":"edit_file","ok":true,"result":"edited src/a.ts"}]',
    '```'
  ].join('\n'));
  const filler = (tag: string): TestMessage => user(`${tag} ${'s'.repeat(900)}`);
  const messages = [
    action,
    observation,
    filler('stale-1'),
    filler('stale-2'),
    filler('stale-3'),
    user('next question'),
    model('next answer')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    keepFirstHead: 0,
    maxHistoryChars: 300
  });

  // The folded observation — its raw result fence is what the pair walk saw —
  // travels with the protected action; the three middle fillers do not.
  assert.ok(result.messages.some((entry) => entry.content === '[tools] 1 tool result folded'),
    'the observation stayed with its action');
  assert.ok(result.messages.some((entry) => entry.content.includes(SEARCH_ORIGINAL_MARKER)),
    'the folded action is still there');
  assert.ok(!result.messages.includes(messages[2]), 'the three middle fillers became the digest');
  assert.ok(!result.messages.includes(messages[3]));
  assert.ok(!result.messages.includes(messages[4]));
  assert.ok(result.messages.some((entry) => entry.content.startsWith('[condensed')));
  assert.match(result.folds.join(' '), /condensed 3 middle messages into 1 digest/);
});

test('action and observation inside the condensed middle leave as one digest', () => {
  const action = model([
    'checking:',
    '```shadrox:tools',
    '[{"name":"read_file","args":{"path":"src/z.ts"}}]',
    '```'
  ].join('\n'));
  const observation = model([
    '```shadrox:results',
    '[{"tool":"read_file","ok":true,"result":"bytes of z"}]',
    '```'
  ].join('\n'));
  const messages = [
    user('plan the refactor'),
    model('working on it'),
    action,
    observation,
    user(`junk ${'j'.repeat(1_000)}`),
    user('tail question'),
    model('tail answer')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 300
  });

  assert.ok(!result.messages.some((entry) => entry.content.includes('shadrox:results')),
    'no orphan observation survives without its action');
  assert.ok(!result.messages.some((entry) => entry.content.includes('bytes of z')));
  assert.equal(result.messages.filter((entry) => entry.id.startsWith('condensed:')).length, 1,
    'the pair was condensed together, into one digest');
  assert.ok(result.messages.some((entry) => entry.content === observation.content) === false);
});

test('the observation walk anchors a result to its most recent action', () => {
  const contents = ['plain', 'a\n```shadrox:tools\n[]\n```', '```shadrox:results\n[]\n```', 'after'];
  assert.deepEqual(observationAnchors(contents), [0, 1, 1, 3]);
});

test('the oldest low-value block goes first, and a run too small to digest is dropped not summarized', () => {
  const messages = [
    user('one'),
    model('two'),
    user('x1'),
    user('ok'),
    user('x2'),
    user('x3'),
    user('qq'),
    model('aa')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 14
  });

  const kept = result.messages.map((entry) => entry.content);
  assert.ok(!kept.includes('x1'), 'the oldest middle message went first');
  assert.ok(kept.includes('x2'), 'the newer middle messages stayed');
  assert.ok(kept.includes('x3'));
  assert.ok(!result.messages.some((entry) => entry.content.startsWith('[condensed')),
    'minimum progress: three tiny messages do not earn a digest that would outweigh them');
  assert.match(result.folds.join(' '), /dropped 1 oldest message to fit the budget/);
});

test('the digest keeps the path inventory alive — the product invariant of compaction', () => {
  const pasted = user([
    'src/a.ts contents:',
    '```ts path=src/a.ts',
    Array.from({ length: 30 }, (_, index) => `v${index}`).join('\n'),
    '```'
  ].join('\n'));
  const tool = model(['looking', '```shadrox:tools', '[{"name":"read_file","args":{"path":"src/b.ts"}}]', '```'].join('\n'), {
    toolActivity: [{ name: 'Read', label: 'src/b.ts', ok: true }]
  });
  const messages = [
    user('refactor src/parse.ts'),
    model('working on it'),
    user(`junk ${'c'.repeat(900)}`),
    pasted,
    tool,
    user(`older ${'d'.repeat(900)}`),
    user('tail question'),
    model('tail answer')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 500
  });

  const digest = result.messages.find((entry) => entry.content.startsWith('[condensed'));
  assert.ok(digest, 'the middle became a digest, not silence');
  assert.match(digest.content, /Files seen: src\/a\.ts/, 'paths from folded fences survive in the digest');
  assert.match(digest.content, /Tools: Read x1 \(src\/b\.ts\)/, 'tool-observed paths survive too');
  assert.ok(!result.messages.includes(messages[2]), 'the bulk messages themselves are gone');
  assert.ok(!result.messages.includes(messages[5]));
});

test('compaction is byte-stable: the same history condenses to the same bytes', () => {
  const history = (): TestMessage[] => [
    user('build the parser'),
    model('planning'),
    toolTurn(),
    fileBodyPaste(30),
    user(`filler ${'e'.repeat(900)}`),
    user('ok'),
    user(`more ${'f'.repeat(900)}`),
    model(toolTurn().content, { toolActivity: [{ name: 'Read', label: 'c.ts', ok: false, error: 'nope' }] }),
    user('tail question'),
    model('tail answer')
  ];
  const base = history();
  const first = compactHistory(base, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 1_200
  });
  const second = compactHistory(base, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 1_200
  });

  assert.equal(JSON.stringify(second.messages), JSON.stringify(first.messages), 'byte-identical for byte-identical history — cache friendly');
  assert.deepEqual(second.folds, first.folds);
  assert.equal(second.tokensSaved, first.tokensSaved);
});

test('a history inside the budget is never condensed — the ported max_size trigger', () => {
  const messages: TestMessage[] = [toolTurn()];
  for (let index = 0; index < 10; index += 1) {
    messages.push(user(`question ${index}`), model(`answer ${index}`));
  }
  messages.push(toolTurn());
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 100_000
  });

  assert.ok(!result.messages.some((entry) => entry.content.startsWith('[condensed')), 'no condensation event without budget pressure');
  assert.ok(!result.folds.join(' ').includes('condensed'));
  assert.ok(!result.folds.join(' ').includes('to fit the budget'));
});

test('the condense summarizer seam gets the OpenHands prompt, rolling the previous digest forward', () => {
  const patched = model(['keep this edit', SR_FENCE].join('\n'), { patches: [{ path: 'src/a.ts' }] });
  const messages = [
    user(`early ${'g'.repeat(1_500)}`),
    patched,
    user(`later ${'h'.repeat(1_500)}`),
    user('ok'),
    user('tail question'),
    model('tail answer')
  ];
  const seen: string[] = [];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    keepFirstHead: 0,
    maxHistoryChars: 400,
    condenseSummarizer: (prompt) => {
      seen.push(prompt);
      return seen.length === 1 ? 'FIRST DIGEST' : 'SECOND DIGEST';
    }
  });

  assert.match(seen[0], new RegExp(FIRST_CONDENSATION_PROMPT.slice(0, 40)));
  assert.match(seen[0], /Events to summarize:/);
  assert.ok(seen[0].includes('early ggg'), 'the transcript of the forgotten run is handed to the seam');
  assert.match(seen[1], /Here is a summary of the events that were condensed so far: FIRST DIGEST/);
  assert.match(seen[1], /same tone and format/);
  const digests = result.messages.filter((entry) => entry.id.startsWith('condensed:'));
  assert.equal(digests.length, 2);
  assert.equal(digests[0].content, 'FIRST DIGEST');
  assert.equal(digests[1].content, 'SECOND DIGEST');
});

test('a summarizer that fails minimum progress falls back to plain dropping, OpenHands-style', () => {
  const messages = [
    user('ask'),
    model('answer'),
    user('ok'),
    user(`fat ${'i'.repeat(2_000)}`),
    user('tail question'),
    model('tail answer')
  ];
  const result = compactHistory(messages, {
    contextWindow: CONTEXT_WINDOW,
    keepRecent: 2,
    maxHistoryChars: 34,
    condenseSummarizer: () => 'S'.repeat(3_000)
  });

  assert.ok(!result.messages.some((entry) => entry.content.startsWith('[condensed')));
  assert.ok(!result.messages.includes(messages[3]), 'a digest that would not shrink enough is refused; the message just goes');
  assert.match(result.folds.join(' '), /dropped 1 oldest message to fit the budget/);
});
