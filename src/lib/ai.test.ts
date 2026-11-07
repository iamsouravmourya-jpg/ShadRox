import assert from 'node:assert/strict';
import test from 'node:test';
import {
  streamChat,
  createPrefixStripper,
  refinePrompt,
  MAX_STREAM_ATTEMPTS,
  type StreamDoneInfo,
  type StreamRetryNotice
} from './ai';
import {
  aiderRetryMessage,
  DEFAULT_RETRY_SETTINGS,
  planRetry
} from './ai/backoff';
import {
  classifyFailure,
  classifyMessage,
  classifyStatus,
  parseRetryAfterSeconds
} from './ai/retryPolicy';
import {
  INTERRUPTED_STREAM_KEY,
  pruneResumePrefixes,
  snapshotForConversation,
  syncInterruptedSnapshot,
  takeRestorableSnapshot,
  validateSnapshot
} from './streamSnapshot';
import { getApiKey, setActiveProvider, getActiveProvider, setApiKey } from './storage';
import { hydrateSecureStore, resetSecretStoreForTests } from './secureStore';
import type { ChatMessage } from './types';

test('drops a fully echoed partial reply across chunk boundaries', () => {
  const strip = createPrefixStripper('The server starts');
  assert.equal(strip('The serv'), '');
  assert.equal(strip('er star'), '');
  assert.equal(strip('ts on port 3000.'), ' on port 3000.');
  // Later chunks pass through untouched once the echo is consumed.
  assert.equal(strip(' Then it binds.'), ' Then it binds.');
});

test('passes text through when the model continues without echoing', () => {
  const strip = createPrefixStripper('function add(a, b) { re');
  assert.equal(strip('turn a + b; }'), 'turn a + b; }');
});

test('stops stripping at the first divergence and keeps the rest', () => {
  const strip = createPrefixStripper('alpha beta');
  assert.equal(strip('alpha ga'), 'ga');
  assert.equal(strip('mma continues'), 'mma continues');
});

test('an empty prefix strips nothing', () => {
  const strip = createPrefixStripper('');
  assert.equal(strip('anything at all'), 'anything at all');
});

test('surrogate pairs are matched as whole code points', () => {
  const strip = createPrefixStripper('emoji 🎉 he');
  assert.equal(strip('emoji 🎉'), '');
  assert.equal(strip('llo'), 'llo');
});

test('streamChat forwards native tool-call SSE events to the caller', async () => {
  const originalFetch = globalThis.fetch;
  const received: unknown[] = [];
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      'data: {"type":"tool_calls","calls":[{"id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"src/App.tsx\\"}"}]}',
      'data: {"type":"done","tokens":4,"provider":"groq","model":"test","tier":"byok"}',
      ''
    ].join('\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;

  try {
    await streamChat({
      provider: 'groq',
      model: 'test',
      messages: [{ role: 'user', content: 'Inspect the app' }],
      toolDefinitions: [{
        name: 'read_file',
        description: 'Read one file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }]
    }, {
      onDelta: () => {},
      onToolCalls: (calls) => received.push(...calls),
      onError: (message) => { throw new Error(message); }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(received, [{
    id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"src/App.tsx"}'
  }]);
  assert.deepEqual(requestBody?.toolDefinitions, [{
    name: 'read_file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }]);
});

/* ------------------------------------------------------------------ *
 * Interrupted-stream snapshot lifecycle.
 *
 * The invariant under test: a persisted snapshot always describes the
 * conversation that is on screen. Each mutation path in App is replayed here
 * as the message array it produces.
 * ------------------------------------------------------------------ */

function chat(id: string, role: 'user' | 'model', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp: '10:00', ...extra };
}

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }
  };
}

const CHAT = [
  chat('u1', 'user', 'build a server'),
  chat('m1', 'model', 'Here is a server.', { resumable: true })
];

function conversation(messages: ChatMessage[], prefixes: Record<string, string> = {}, workspaceId = 'folder-/p/project') {
  return { messages, prefixes, refineMode: 'code' as const, workspaceId };
}

test('a healthy or in-flight stream persists nothing', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation([chat('u1', 'user', 'hi'), chat('m1', 'model', 'done')]));
  assert.equal(store.data.size, 0);

  // Mid-stream there is nothing to resume yet, so nothing may be persisted.
  syncInterruptedSnapshot(store, conversation([chat('u1', 'user', 'hi'), chat('m1', 'model', 'part', { streaming: true })]));
  assert.equal(store.data.size, 0);
});

test('an interrupted reply is persisted with the turn that produced it', () => {
  const store = memoryStore();
  const result = syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'Here is a server.' }));
  assert.equal(result.persisted, true);
  const snapshot = JSON.parse(store.data.get(INTERRUPTED_STREAM_KEY) as string);
  assert.equal(snapshot.interruptedId, 'm1');
  assert.equal(snapshot.prefix, 'Here is a server.');
  assert.equal(snapshot.workspaceId, 'folder-/p/project');
  assert.equal(snapshot.lastUserMessageId, 'u1');
  assert.ok(snapshot.messages.every((message: ChatMessage) => message.streaming === false));
});

test('regenerate clears the snapshot instead of leaving it to overwrite the chat', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'Here is a server.' }));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), true);

  // handleRegenerate: truncate to the user turn, push a fresh streaming pair.
  const afterRegenerate = [
    chat('u1', 'user', 'build a server'),
    chat('u2', 'user', 'build a server'),
    chat('m2', 'model', '', { streaming: true })
  ];
  const result = syncInterruptedSnapshot(store, conversation(afterRegenerate, { m1: 'Here is a server.' }));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), false, 'the stale snapshot must be gone');
  assert.deepEqual(result.prefixes, {}, 'the dead resume prefix was pruned');
});

test('a resume that is running clears, and a resume that fails re-persists the grown text', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'Here is a' }));

  // Resume in flight.
  syncInterruptedSnapshot(store, conversation([CHAT[0], chat('m1', 'model', 'Here is a', { streaming: true })], { m1: 'Here is a' }));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), false);

  // The resume itself dropped: the longer partial must be persisted again, or a
  // second reload loses the text forever.
  const resumed = [CHAT[0], chat('m1', 'model', 'Here is a server on port 3000', { resumable: true })];
  const result = syncInterruptedSnapshot(store, conversation(resumed, { m1: 'Here is a server on port 3000' }));
  assert.equal(result.persisted, true);
  const restored = takeRestorableSnapshot(store, { workspaceId: 'folder-/p/project' });
  assert.equal(restored?.prefix, 'Here is a server on port 3000');
  assert.equal(restored?.interruptedId, 'm1');
});

test('a completed resume and a manual stop both clear the snapshot', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'Here is a server.' }));

  const finished = syncInterruptedSnapshot(store, conversation([CHAT[0], chat('m1', 'model', 'Full answer.')]));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), false);
  assert.deepEqual(finished.prefixes, {});

  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'partial' }));
  // handleStop marks the streaming message neither resumable nor streaming.
  syncInterruptedSnapshot(store, conversation([CHAT[0], chat('m1', 'model', 'partial')]));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), false);
});

test('clearing the chat empties the store and the prefix map', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'partial' }));
  const result = syncInterruptedSnapshot(store, conversation([], { m1: 'partial' }));
  assert.equal(store.data.size, 0);
  assert.deepEqual(result.prefixes, {});
});

test('the sync is idempotent and only writes when the content changes', () => {
  const store = memoryStore();
  let writes = 0;
  const counting = {
    ...store,
    setItem: (key: string, value: string) => { writes += 1; store.setItem(key, value); }
  };
  const state = conversation(CHAT, { m1: 'Here is a server.' });
  syncInterruptedSnapshot(counting, state);
  syncInterruptedSnapshot(counting, state);
  syncInterruptedSnapshot(counting, state);
  assert.equal(writes, 1, 'no per-delta sessionStorage churn');
});

test('resume prefixes of deleted messages are pruned, live ones kept', () => {
  const pruned = pruneResumePrefixes({ m1: 'a', m9: 'b' }, CHAT);
  assert.deepEqual(pruned, { m1: 'a' });
  assert.equal(pruneResumePrefixes(pruned, CHAT), pruned, 'same reference when nothing changed');
});

test('a snapshot only restores into the conversation and workspace it came from', () => {
  const valid = snapshotForConversation(conversation(CHAT, { m1: 'partial' }))!;
  assert.ok(validateSnapshot(valid, { workspaceId: 'folder-/p/project' }));

  // Another workspace: the displayed conversation is unrelated, refuse.
  assert.equal(validateSnapshot(valid, { workspaceId: 'folder-/p/other' }), null);
  // Unattributed (its workspace was closed mid-chat): refuse rather than guess.
  assert.equal(validateSnapshot({ ...valid, workspaceId: null }, { workspaceId: 'folder-/p/project' }), null);

  // The user turn it claims no longer exists — the stale-snapshot class of bug.
  assert.equal(validateSnapshot({ ...valid, lastUserMessageId: 'u-deleted' }, { workspaceId: 'folder-/p/project' }), null);
  // The partial text on screen is not what the prefix says it is.
  assert.equal(
    validateSnapshot(
      { ...valid, messages: [chat('u1', 'user', 'build a server'), chat('m1', 'model', 'totally different')] },
      { workspaceId: 'folder-/p/project' }
    ),
    null
  );
  assert.equal(validateSnapshot(null, { workspaceId: 'folder-/p/project' }), null);
});

test('a consumed snapshot cannot be replayed', () => {
  const store = memoryStore();
  syncInterruptedSnapshot(store, conversation(CHAT, { m1: 'partial' }));
  assert.ok(takeRestorableSnapshot(store, { workspaceId: 'folder-/p/project' }));
  assert.equal(store.data.has(INTERRUPTED_STREAM_KEY), false);
  assert.equal(takeRestorableSnapshot(store, { workspaceId: 'folder-/p/project' }), null);
});

test('a corrupt snapshot is dropped instead of breaking startup', () => {
  const store = memoryStore();
  store.setItem(INTERRUPTED_STREAM_KEY, '{ not json');
  assert.equal(takeRestorableSnapshot(store, { workspaceId: 'folder-/p/project' }), null);
  assert.equal(store.data.size, 0);
});

/* ------------------------------------------------------------------ *
 * Provider keys must not live in plaintext on desktop.
 * ------------------------------------------------------------------ */

interface FakeBridge {
  platform: string;
  secureStore: {
    getAll: () => Promise<Record<string, string>>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
}

function withEnv(
  setup: { desktop?: Record<string, string>; local?: Record<string, string> },
  run: (env: { encrypted: Map<string, string>; plain: Map<string, string> }) => void | Promise<void>
) {
  const encrypted = new Map<string, string>(Object.entries(setup.desktop ?? {}));
  const plain = new Map<string, string>(Object.entries(setup.local ?? {}));
  const bridge: FakeBridge | undefined = setup.desktop
    ? {
        platform: 'win32',
        secureStore: {
          getAll: async () => Object.fromEntries(encrypted),
          set: async (key, value) => { encrypted.set(key, value); return true; },
          delete: async (key) => { encrypted.delete(key); return true; }
        }
      }
    : undefined;

  const previousWindow = (globalThis as any).window;
  const previousStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => plain.get(key) ?? null,
    setItem: (key: string, value: string) => { plain.set(key, value); },
    removeItem: (key: string) => { plain.delete(key); }
  };
  (globalThis as any).window = { shadroxDesktop: bridge };
  resetSecretStoreForTests();

  return (async () => {
    try {
      await run({ encrypted, plain });
      return { encrypted, plain };
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      if (previousStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = previousStorage;
      resetSecretStoreForTests();
    }
  })();
}

test('on desktop a saved key goes to the encrypted store, never to localStorage', async () => {
  await withEnv({ desktop: {} }, async ({ encrypted, plain }) => {
    await hydrateSecureStore();
    setApiKey('gemini', 'sk-plain-secret');
    assert.equal(getApiKey('gemini'), 'sk-plain-secret', 'chat requests still find the key');
    assert.equal(plain.has('shadrox.byok.gemini'), false, 'no plaintext mirror');
    assert.equal(encrypted.get('shadrox.byok.gemini'), 'sk-plain-secret');
  });
});

test('after a reload the key comes back from the encrypted store and the old plaintext is purged', async () => {
  await withEnv(
    {
      desktop: { 'shadrox.byok.gemini': 'sk-from-safe-storage', 'shadrox.provider.active': 'groq' },
      // What an earlier build left behind in %APPDATA%\...\Local Storage.
      local: { 'shadrox.byok.gemini': 'sk-from-safe-storage', 'shadrox.plan': 'free' }
    },
    async ({ plain }) => {
      await hydrateSecureStore();
      assert.equal(getApiKey('gemini'), 'sk-from-safe-storage', 'Settings shows the saved key');
      assert.equal(plain.has('shadrox.byok.gemini'), false, 'plaintext purged on hydration');
      // Non-secret settings keep working exactly as before.
      assert.equal(plain.get('shadrox.plan'), 'free');
      assert.equal(getActiveProvider(), 'groq');
      setActiveProvider('gemini');
      assert.equal(plain.get('shadrox.provider.active'), 'gemini');
      // Re-saving must not resurrect a plaintext copy either.
      setApiKey('gemini', 'sk-rotated');
      assert.equal(getApiKey('gemini'), 'sk-rotated');
      assert.equal(plain.has('shadrox.byok.gemini'), false);
    }
  );
});

test('forgetting a key clears memory, the encrypted store and any plaintext copy', async () => {
  await withEnv(
    {
      desktop: { 'shadrox.byok.gemini': 'sk-old' },
      local: { 'shadrox.byok.gemini': 'sk-old' }
    },
    async ({ encrypted, plain }) => {
      await hydrateSecureStore();
      assert.equal(getApiKey('gemini'), 'sk-old');
      // The Settings drawer clears a key by saving an empty string.
      setApiKey('gemini', '');
      assert.equal(getApiKey('gemini'), '');
      assert.equal(plain.has('shadrox.byok.gemini'), false);
      assert.equal(encrypted.has('shadrox.byok.gemini'), false);
    }
  );
});

test('browser mode keeps using localStorage — there is nothing else to use', async () => {
  await withEnv({ local: {} }, async () => {
    await hydrateSecureStore();
    setApiKey('groq', 'gsk-browser-key');
    assert.equal(getApiKey('groq'), 'gsk-browser-key');
    assert.equal(localStorage.getItem('shadrox.byok.groq'), 'gsk-browser-key');
    setApiKey('groq', '');
    assert.equal(getApiKey('groq'), '');
    assert.equal(localStorage.getItem('shadrox.byok.groq'), null);
  });
});

/* ------------------------------------------------------------------ *
 * Aider-ported retry discipline (src/lib/ai/backoff.ts + retryPolicy.ts).
 *
 * No real network, no real timers: fetch is faked per test and the retry
 * clock (now/sleep/rng/setTimer) is injected through StreamChatOptions.retry.
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const sseDelta = (text: string) => `data: ${JSON.stringify({ type: 'delta', text })}\n\n`;
const sseDone = `data: ${JSON.stringify({ type: 'done', tokens: 3, provider: 'groq', model: 'test', tier: 'byok' })}\n\n`;

function streamResponse(chunks: string[]): Response {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

interface TurnResult {
  text: string;
  done: boolean;
  doneCalls: number;
  doneInfo: StreamDoneInfo | null;
  error: string | null;
  notices: StreamRetryNotice[];
  warnings: string[];
}

async function runTurn(
  fetchScript: Array<(call: number) => Response | Promise<Response>>,
  retry: Record<string, unknown>,
  extraOptions: Record<string, unknown> = {}
): Promise<TurnResult & { calls: number; bodies: Array<Record<string, unknown>> }> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const step = fetchScript[Math.min(calls, fetchScript.length - 1)];
    calls += 1;
    return step(calls);
  }) as typeof fetch;
  const result: TurnResult = {
    text: '',
    done: false,
    doneCalls: 0,
    doneInfo: null,
    error: null,
    notices: [],
    warnings: []
  };
  try {
    await streamChat(
      {
        provider: 'groq',
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        retry,
        ...extraOptions
      },
      {
        onDelta: (chunk) => { result.text += chunk; },
        onDone: (info) => { result.done = true; result.doneCalls += 1; result.doneInfo = info; },
        onError: (message) => { result.error = message; },
        onRetry: (notice) => { result.notices.push(notice); },
        onWarning: (message) => { result.warnings.push(message); }
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { ...result, calls, bodies };
}

/** Fake monotonic clock; every backoff sleep advances it and is recorded. */
function fakeClock(rng: () => number = () => 1) {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    retry: {
      now: () => time,
      sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
      rng,
      // The idle watchdog never fires unless a test opts in.
      setTimer: () => 0,
      clearTimer: () => {}
    }
  };
}

test('a 429 retries after the Retry-After the provider asked for, then succeeds', async () => {
  const clock = fakeClock();
  const out = await runTurn(
    [
      () => errorResponse(429, 'Too many requests from this key.', { 'Retry-After': '2' }),
      () => streamResponse([sseDelta('Hello'), sseDone])
    ],
    clock.retry
  );
  assert.equal(out.error, null);
  assert.equal(out.calls, 2);
  assert.equal(out.text, 'Hello');
  assert.ok(out.done);
  assert.equal(out.notices.length, 1);
  assert.equal(out.notices[0].reason, 'RateLimitError');
  // Retry-After (2000 ms) must dominate the exponential 250 ms: never sleep
  // less than what the provider explicitly requested.
  assert.deepEqual(clock.sleeps, [2000]);
  // aider's notice text survives the port.
  assert.match(out.notices[0].message, /Retrying in 2\.0 seconds\.\.\. \(attempt 2 of 4\)/);
});

test('5xx failures double the aider backoff from the 0.125 s seed', async () => {
  const clock = fakeClock();
  const out = await runTurn(
    [
      () => errorResponse(500, 'Internal Server Error.'),
      () => errorResponse(502, 'Bad Gateway.'),
      () => streamResponse([sseDelta('Recovered'), sseDone])
    ],
    clock.retry
  );
  assert.equal(out.error, null);
  assert.equal(out.calls, 3);
  assert.equal(out.text, 'Recovered');
  // retry_delay *= 2 from 0.125 s: first sleep 250 ms, second 500 ms.
  // rng() = 1 pins the jitter to its upper bound so the numbers are exact.
  assert.deepEqual(clock.sleeps, [250, 500]);
  assert.deepEqual(out.notices.map((n) => n.reason), ['InternalServerError', 'BadGatewayError']);
});

test('jitter is applied to every backoff sleep', async () => {
  const clock = fakeClock(() => 0.5);
  const out = await runTurn(
    [
      () => errorResponse(503, 'Service Unavailable.'),
      () => errorResponse(500, 'Internal Server Error.'),
      () => streamResponse([sseDelta('x'), sseDone])
    ],
    clock.retry
  );
  assert.equal(out.error, null);
  // equal jitter: doubled/2 + rng * doubled/2 -> 125+62.5=188, then 250+125=375.
  assert.deepEqual(clock.sleeps, [188, 375]);
  // A different rng draw yields different delays — retries must not stampede.
  const other = fakeClock(() => 0);
  await runTurn(
    [() => errorResponse(500, 'Internal Server Error.'), () => streamResponse([sseDelta('x'), sseDone])],
    other.retry
  );
  assert.deepEqual(other.sleeps, [125]);
});

test('the backoff is capped by the max-elapsed deadline and then gives up', async () => {
  const clock = fakeClock();
  const out = await runTurn(
    [
      () => errorResponse(500, 'Internal Server Error.'),
      () => errorResponse(500, 'Internal Server Error.'),
      () => streamResponse([sseDelta('never'), sseDone])
    ],
    { ...clock.retry, maxElapsedMs: 700 }
  );
  // attempt 1: 250 ms sleep fits (0+250<=700); attempt 2 would sleep 500 ms
  // at 250 ms elapsed -> 750 > 700, so the deadline vetoes the replay.
  assert.equal(out.calls, 2);
  assert.deepEqual(clock.sleeps, [250]);
  assert.equal(out.done, false);
  assert.equal(out.text, '');
  assert.ok(out.error);
  assert.match(out.error, /Internal Server Error\./);
  assert.match(out.error, /Giving up after 2 attempts\./);
  assert.match(out.error, /servers are down or overloaded/); // aider's ExInfo description
});

test('a mid-stream break keeps the partial reply and warns instead of replaying', async () => {
  const brokenBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseDelta('Half an ')));
    },
    // The drop happens after the first chunk is delivered, not before: a
    // pre-delivery error would discard the queue, not model a mid-stream break.
    pull(controller) {
      controller.error(new Error('socket reset mid-stream'));
    }
  });
  const out = await runTurn(
    [() => new Response(brokenBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })],
    fakeClock().retry
  );
  // IDEMPOTENCY: the body already reached the model — no second request, ever.
  assert.equal(out.calls, 1);
  // The partial text already streamed to the UI and stays there.
  assert.equal(out.text, 'Half an ');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /partial answer is kept/);
  assert.match(out.warnings[0], /Resume/);
  assert.equal(out.notices.length, 0);
  assert.ok(out.error);
  assert.equal(out.done, false);
});

test('a connection loss before the first token is replayed (nothing reached the UI)', async () => {
  const droppedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset before first byte'));
    }
  });
  const out = await runTurn(
    [
      () => new Response(droppedBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      () => streamResponse([sseDelta('Second try'), sseDone])
    ],
    fakeClock().retry
  );
  assert.equal(out.calls, 2);
  assert.equal(out.text, 'Second try');
  assert.equal(out.error, null);
  assert.deepEqual(out.notices.map((n) => n.reason), ['APIConnectionError']);
});

test('a fetch-level network failure (TypeError) is retried like APIConnectionError', async () => {
  const out = await runTurn(
    [
      () => { throw new TypeError('fetch failed'); },
      () => streamResponse([sseDelta('back up'), sseDone])
    ],
    fakeClock().retry
  );
  assert.equal(out.calls, 2);
  assert.equal(out.text, 'back up');
  assert.equal(out.error, null);
});

test('an SSE error event naming a transient provider fault replays before any output', async () => {
  const out = await runTurn(
    [
      () => streamResponse([
        `data: ${JSON.stringify({ type: 'error', message: 'Could not reach Google Gemini. Check your internet connection and try again.' })}\n\n`
      ]),
      () => streamResponse([sseDelta('gemini is back'), sseDone])
    ],
    fakeClock().retry
  );
  assert.equal(out.calls, 2);
  assert.equal(out.text, 'gemini is back');
  assert.equal(out.error, null);
  assert.deepEqual(out.notices.map((n) => n.reason), ['APIConnectionError']);
});

test('a 401 authentication failure is never retried', async () => {
  const clock = fakeClock();
  const out = await runTurn(
    [() => errorResponse(401, 'The API provider is not able to authenticate you.')],
    clock.retry
  );
  assert.equal(out.calls, 1);
  assert.equal(out.notices.length, 0);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(out.error, 'The API provider is not able to authenticate you.');
});

test('a user stop during the backoff sleep ends the turn silently', async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  clock.retry.sleep = async () => {
    controller.abort();
    await Promise.resolve();
  };
  const out = await runTurn(
    [
      () => errorResponse(429, 'Too many requests.'),
      () => streamResponse([sseDelta('must not run'), sseDone])
    ],
    clock.retry,
    { signal: controller.signal }
  );
  assert.equal(out.calls, 1, 'the replay never starts after a stop');
  assert.equal(out.error, null, 'a stop is not an error');
  assert.equal(out.text, '');
  assert.equal(out.notices.length, 1, 'the user was still told a retry was starting');
});

test('a silent stream hits the idle watchdog and replays as a Timeout', async () => {
  let timerArmed = 0;
  const clock = fakeClock();
  const hangingBody = new ReadableStream<Uint8Array>({ start: () => {} });
  const out = await runTurn(
    [
      () => new Response(hangingBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      () => streamResponse([sseDelta('unhung'), sseDone])
    ],
    {
      ...clock.retry,
      // Fire the watchdog exactly once: on the first attempt's first read.
      setTimer: (callback: () => void) => {
        timerArmed += 1;
        if (timerArmed === 1) queueMicrotask(callback);
        return 0;
      }
    }
  );
  assert.equal(out.calls, 2);
  assert.equal(out.text, 'unhung');
  assert.equal(out.error, null);
  assert.deepEqual(out.notices.map((n) => n.reason), ['Timeout']);
});

/* ------------------------------------------------------------------ *
 * Terminal-state honesty: provenance passthrough, unconfirmed EOF and
 * done-then-error. A completed turn is never replayed or re-priced, and
 * an unconfirmed one is never reported as a zero-token success.
 * ------------------------------------------------------------------ */

const sseEvent = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

test('a done event keeps cache, truncation and usage provenance instead of dropping them', async () => {
  const cacheReport = {
    mode: 'auto_prefix',
    prefixTokens: 96,
    prefixChars: 384,
    breakpoints: 0,
    markers: 0,
    prefixShare: 0.42
  };
  const out = await runTurn(
    [() => streamResponse([
      sseDelta('Hi'),
      sseEvent({
        type: 'done',
        tokens: 42,
        inputTokens: 30,
        outputTokens: 12,
        cachedInputTokens: 8,
        provider: 'groq',
        model: 'requested-model',
        servedModel: 'served-model-2026-11',
        tier: 'shadrox',
        finishReason: 'stop',
        truncated: true,
        promptCache: cacheReport,
        usageSource: 'provider',
        firstTokenMs: 180,
        durationMs: 2400
      })
    ])],
    fakeClock().retry
  );
  assert.equal(out.error, null);
  assert.equal(out.calls, 1);
  assert.equal(out.doneCalls, 1);
  const info = out.doneInfo!;
  assert.equal(info.tokens, 42);
  assert.equal(info.inputTokens, 30);
  assert.equal(info.outputTokens, 12);
  assert.equal(info.cachedInputTokens, 8);
  assert.equal(info.model, 'requested-model');
  assert.equal(info.servedModel, 'served-model-2026-11');
  assert.equal(info.tier, 'shadrox');
  assert.equal(info.finishReason, 'stop');
  assert.equal(info.truncated, true);
  assert.deepEqual(info.promptCache, cacheReport);
  assert.equal(info.usageSource, 'provider');
  assert.equal(info.firstTokenMs, 180);
  assert.equal(info.durationMs, 2400);
  assert.equal(info.attempts, 1);
  assert.equal(info.incomplete, undefined);
});

test('an estimated report, an explicit null served model and a null cache report survive', async () => {
  const out = await runTurn(
    [() => streamResponse([
      sseDelta('x'),
      sseEvent({
        type: 'done',
        tokens: 5,
        provider: 'groq',
        model: 'test',
        tier: 'byok',
        usageSource: 'estimated',
        servedModel: null,
        promptCache: null,
        truncated: false
      })
    ])],
    fakeClock().retry,
    { apiKey: 'sk-user-key' }
  );
  assert.equal(out.doneInfo?.usageSource, 'estimated');
  assert.equal(out.doneInfo?.servedModel, null);
  assert.equal(out.doneInfo?.promptCache, null);
  assert.equal(out.doneInfo?.truncated, false);
});

test('an unrecognized usage source is never promoted to a provider report', async () => {
  const out = await runTurn(
    [() => streamResponse([
      sseDelta('x'),
      sseEvent({ type: 'done', tokens: 5, provider: 'groq', model: 'test', tier: 'byok', usageSource: 'guessed', servedModel: 7, promptCache: 'lots' })
    ])],
    fakeClock().retry
  );
  assert.equal(out.doneInfo?.usageSource, undefined);
  assert.equal(out.doneInfo?.servedModel, undefined);
  assert.equal(out.doneInfo?.promptCache, undefined);
});

test('a done event without a tier keeps the request payer instead of guessing byok', async () => {
  const noTier = sseEvent({ type: 'done', tokens: 7, provider: 'groq', model: 'test' });
  const shared = await runTurn([() => streamResponse([sseDelta('x'), noTier])], fakeClock().retry);
  assert.equal(shared.doneInfo?.tier, 'shadrox');
  const byok = await runTurn(
    [() => streamResponse([sseDelta('x'), noTier])],
    fakeClock().retry,
    { apiKey: '  sk-user-key  ' }
  );
  assert.equal(byok.doneInfo?.tier, 'byok');
});

test('EOF with visible output and no done is an explicit incomplete shared outcome', async () => {
  const out = await runTurn([() => streamResponse([sseDelta('Partial answer')])], fakeClock().retry);
  assert.equal(out.calls, 1, 'an unconfirmed turn is never replayed');
  assert.equal(out.text, 'Partial answer', 'the partial text stays on screen');
  assert.equal(out.error, null);
  assert.equal(out.doneCalls, 1);
  assert.equal(out.notices.length, 0);
  const info = out.doneInfo!;
  assert.equal(info.incomplete, true);
  assert.equal(info.usageSource, 'unknown');
  assert.equal(info.finishReason, 'stream-ended');
  assert.equal(info.tier, 'shadrox', 'a shared request is never relabelled byok');
  assert.equal(info.inputTokens, undefined, 'unknown usage is not a measured zero');
  assert.equal(info.outputTokens, undefined);
  assert.equal(info.cachedInputTokens, undefined);
  assert.equal(info.servedModel, undefined);
  assert.equal(info.promptCache, undefined);
  assert.equal(info.attempts, 1);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /incomplete/);
});

test('EOF with visible output on a BYOK request keeps the byok tier and unknown usage', async () => {
  const out = await runTurn(
    [() => streamResponse([sseDelta('Partial answer')])],
    fakeClock().retry,
    { apiKey: 'sk-user-key' }
  );
  assert.equal(out.calls, 1);
  assert.equal(out.text, 'Partial answer');
  assert.equal(out.error, null);
  assert.equal(out.doneInfo?.tier, 'byok');
  assert.equal(out.doneInfo?.incomplete, true);
  assert.equal(out.doneInfo?.usageSource, 'unknown');
  assert.equal(out.doneInfo?.outputTokens, undefined);
});

test('an empty stream that never confirms completion is an error, not a fabricated done', async () => {
  const emptyBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.close(); }
  });
  const out = await runTurn(
    [() => new Response(emptyBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })],
    fakeClock().retry
  );
  assert.equal(out.calls, 1);
  assert.equal(out.done, false);
  assert.equal(out.doneCalls, 0);
  assert.equal(out.text, '');
  assert.match(out.error!, /empty response/);
});

test('a socket error after done cannot replay the request or overwrite completion', async () => {
  const lateErrorBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseDelta('All done') + sseDone));
    },
    pull(controller) {
      controller.error(new Error('socket reset after the terminal event'));
    }
  });
  const out = await runTurn(
    [
      () => new Response(lateErrorBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      () => streamResponse([sseDelta('must not run'), sseDone])
    ],
    fakeClock().retry
  );
  assert.equal(out.calls, 1, 'a completed request is never re-sent');
  assert.equal(out.text, 'All done');
  assert.equal(out.doneCalls, 1);
  assert.equal(out.doneInfo?.tokens, 3);
  assert.equal(out.error, null);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.notices.length, 0);
});

test('events after done in the same chunk are ignored, including a second done', async () => {
  const out = await runTurn(
    [() => streamResponse([
      sseDelta('Finished'),
      sseDone,
      sseEvent({ type: 'error', message: 'late provider fault' }),
      sseDelta(' must not appear'),
      sseEvent({ type: 'done', tokens: 999, provider: 'groq', model: 'other', tier: 'shadrox' })
    ])],
    fakeClock().retry
  );
  assert.equal(out.calls, 1);
  assert.equal(out.text, 'Finished');
  assert.equal(out.doneCalls, 1, 'completion is delivered once, so it can only be charged once');
  assert.equal(out.doneInfo?.tokens, 3);
  assert.equal(out.doneInfo?.model, 'test');
  assert.equal(out.error, null);
  assert.equal(out.warnings.length, 0);
});

test('the terminal info counts every provider attempt the logical call made', async () => {
  const out = await runTurn(
    [
      () => errorResponse(503, 'Service Unavailable.'),
      () => streamResponse([sseDelta('back up'), sseDone])
    ],
    fakeClock().retry
  );
  assert.equal(out.calls, 2);
  assert.equal(out.doneInfo?.attempts, 2);
  assert.equal(out.notices.length, 1);
  assert.equal(out.error, null);
});

test('total attempts stay bounded even when the caller raises maxAttempts', async () => {
  const clock = fakeClock();
  const out = await runTurn(
    [() => errorResponse(500, 'Internal Server Error.')],
    { ...clock.retry, maxAttempts: 500, maxElapsedMs: 600_000, maxDelayMs: 600_000 }
  );
  assert.equal(out.calls, MAX_STREAM_ATTEMPTS);
  assert.equal(out.doneCalls, 0);
  assert.equal(out.notices.length, MAX_STREAM_ATTEMPTS - 1);
  assert.ok(out.notices.every((notice) => notice.maxAttempts === MAX_STREAM_ATTEMPTS));
  assert.match(out.error!, new RegExp(`Giving up after ${MAX_STREAM_ATTEMPTS} attempts\\.`));
});

test('an idle timeout after visible output warns and never replays', async () => {
  let timerArmed = 0;
  const clock = fakeClock();
  const stallingBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(sseDelta('Partial'))); },
    pull() {}
  });
  const out = await runTurn(
    [
      () => new Response(stallingBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      () => streamResponse([sseDelta('must not run'), sseDone])
    ],
    {
      ...clock.retry,
      setTimer: (callback: () => void) => {
        timerArmed += 1;
        if (timerArmed === 2) queueMicrotask(callback);
        return 0;
      }
    }
  );
  assert.equal(out.calls, 1);
  assert.equal(out.text, 'Partial');
  assert.equal(out.done, false);
  assert.equal(out.notices.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /partial answer is kept/);
  assert.match(out.error!, /silent/);
});

test('a resumed stream still sends the prefix, strips the echo and reports the real done', async () => {
  const out = await runTurn(
    [() => streamResponse([sseDelta('Here is a'), sseDelta(' server on port 3000.'), sseDone])],
    fakeClock().retry,
    { resumePrefix: 'Here is a' }
  );
  assert.deepEqual(out.bodies[0].resume, { prefix: 'Here is a' });
  assert.equal(out.text, ' server on port 3000.');
  assert.equal(out.error, null);
  assert.equal(out.doneCalls, 1);
  assert.equal(out.doneInfo?.incomplete, undefined);
  assert.equal(out.doneInfo?.usageSource, undefined);
});

/* ---- classification + backoff unit tests (aider ports) ---- */

test('aider OpenRouter "choices" quirk classifies as a retryable connection error', () => {
  const info = classifyFailure(
    500,
    "litellm.APIConnectionError: OpenrouterException - {'error': 'upstream', 'choices': missing}"
  );
  assert.equal(info.name, 'APIConnectionError');
  assert.equal(info.retry, true);
  assert.equal(
    info.description,
    'OpenRouter or the upstream API provider is down, overloaded or rate limiting your requests.'
  );
});

test('aider insufficient-credits special case is never retried', () => {
  const info = classifyFailure(402, 'Groq API error: {"error":{"code":402}} insufficient credits');
  assert.equal(info.retry, false);
  assert.equal(info.description, 'Insufficient credits with the API provider. Please add credits.');
});

test('HTTP statuses map onto aider exception classes for Gemini/Groq/OpenAI-compat', () => {
  assert.equal(classifyStatus(429).name, 'RateLimitError');
  assert.equal(classifyStatus(429).retry, true);
  assert.equal(classifyStatus(500).name, 'InternalServerError');
  assert.equal(classifyStatus(503).name, 'ServiceUnavailableError');
  assert.equal(classifyStatus(504).name, 'Timeout');
  assert.equal(classifyStatus(408).name, 'Timeout');
  assert.equal(classifyStatus(400).retry, false);
  assert.equal(classifyStatus(418).retry, false, 'an unknown status stays non-retryable');
  assert.equal(classifyStatus(599).retry, true, 'any other 5xx is a server fault');
});

test('message classification mirrors aider and defaults to no-retry', () => {
  assert.equal(classifyMessage('The model is overloaded, try again later').name, 'InternalServerError');
  assert.equal(classifyMessage('Request timed out after 20 seconds').name, 'Timeout');
  assert.equal(classifyMessage('rate limited, check your quotas').name, 'RateLimitError');
  assert.equal(classifyMessage('something ineffable happened').retry, false);
  // A status outranks prose: a 401 must not be promoted by the word "connection".
  assert.equal(classifyFailure(401, 'lost connection to the key server').name, 'AuthenticationError');
});

test('Retry-After header parsing: seconds, HTTP dates, garbage', () => {
  assert.equal(parseRetryAfterSeconds('7'), 7);
  assert.equal(parseRetryAfterSeconds('999999'), 3600, 'clamped to an hour');
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(parseRetryAfterSeconds('Wed, 21 Oct 2015 07:28:30 GMT', now), 30);
  assert.equal(parseRetryAfterSeconds('Wed, 21 Oct 2015 07:27:00 GMT', now), 0, 'past dates clamp to 0');
  assert.equal(parseRetryAfterSeconds('not a date'), null);
  assert.equal(parseRetryAfterSeconds(null), null);
});

test('planRetry keeps aider doubling + RETRY_TIMEOUT cap, and the ShadRox budgets', () => {
  const settings = { ...DEFAULT_RETRY_SETTINGS };
  // aider: retry_delay *= 2 ... if retry_delay > RETRY_TIMEOUT: should_retry = False
  const capped = planRetry({ previousDelayMs: 40_000, failedAttempt: 1, elapsedMs: 0, settings, rng: () => 1 });
  assert.deepEqual(capped, { kind: 'exhausted', reason: 'max-delay' });

  const attempts = planRetry({ previousDelayMs: 125, failedAttempt: 4, elapsedMs: 0, settings, rng: () => 1 });
  assert.deepEqual(attempts, { kind: 'exhausted', reason: 'attempts' });

  const deadline = planRetry({ previousDelayMs: 125, failedAttempt: 1, elapsedMs: 29_900, settings, rng: () => 1 });
  assert.deepEqual(deadline, { kind: 'exhausted', reason: 'deadline' });

  const ok = planRetry({ previousDelayMs: 125, failedAttempt: 1, elapsedMs: 0, settings, rng: () => 1 });
  assert.deepEqual(ok, { kind: 'retry', delayMs: 250, nextDelayMs: 250 });

  // Retry-After floors the sleep even above the jittered exponential.
  const floored = planRetry({
    previousDelayMs: 125, failedAttempt: 1, elapsedMs: 0, retryAfterSeconds: 5, settings, rng: () => 1
  });
  assert.deepEqual(floored, { kind: 'retry', delayMs: 5000, nextDelayMs: 250 });
});

test('aiderRetryMessage reproduces the aider notice text', () => {
  const text = aiderRetryMessage(
    'The API provider has rate limited you. Try again later or check your quotas.',
    2000,
    1,
    4
  );
  assert.equal(
    text,
    'The API provider has rate limited you. Try again later or check your quotas. ' +
      'Retrying in 2.0 seconds... (attempt 2 of 4)'
  );
});

/* ------------------------------------------------------------------ *
 * Refine: the route's text pipeline is unchanged, and usage provenance
 * is only ever reported when the route actually sent it.
 * ------------------------------------------------------------------ */

const REFINE_CORE = {
  detectedLanguage: 'Hindi',
  translatedText: 'build a server',
  intent: 'Code change',
  refinedPrompt: 'Build a Node HTTP server listening on port 3000.'
};

async function runRefine(payload: unknown) {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  try {
    const refined = await refinePrompt({
      rawPrompt: 'server banao',
      provider: 'groq',
      groqKey: 'gsk-test-key',
      contextInfo: 'Workspace has 2 file(s).',
      mode: 'code'
    });
    return { refined, body: body as Record<string, unknown> | null };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('refine invents no usage when the route reports none', async () => {
  const { refined, body } = await runRefine(REFINE_CORE);
  assert.deepEqual(refined, REFINE_CORE);
  assert.equal(refined.usageSource, undefined);
  assert.equal(refined.model, undefined);
  assert.equal(refined.inputTokens, undefined);
  assert.deepEqual(body?.apiKeyByProvider, { groq: 'gsk-test-key' });
  assert.equal(body?.mode, 'code');
});

test('refine passes through the provenance the route provides', async () => {
  const { refined } = await runRefine({
    ...REFINE_CORE,
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    servedModel: 'llama-3.3-70b-versatile',
    tier: 'byok',
    usageSource: 'provider',
    tokens: 120,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    durationMs: 350
  });
  assert.equal(refined.refinedPrompt, REFINE_CORE.refinedPrompt);
  assert.equal(refined.provider, 'groq');
  assert.equal(refined.model, 'llama-3.3-70b-versatile');
  assert.equal(refined.servedModel, 'llama-3.3-70b-versatile');
  assert.equal(refined.tier, 'byok');
  assert.equal(refined.usageSource, 'provider');
  assert.equal(refined.tokens, 120);
  assert.equal(refined.inputTokens, 100);
  assert.equal(refined.outputTokens, 20);
  assert.equal(refined.cachedInputTokens, 40);
  assert.equal(refined.durationMs, 350);
});

test('refine drops malformed usage rather than reporting it as measured', async () => {
  const { refined } = await runRefine({
    ...REFINE_CORE,
    usageSource: 'guessed',
    inputTokens: '100',
    servedModel: 7,
    tokens: Number.NaN
  });
  assert.deepEqual(refined, REFINE_CORE);
  assert.equal('usageSource' in refined, false);
  assert.equal('inputTokens' in refined, false);
  assert.equal('servedModel' in refined, false);
  assert.equal('tokens' in refined, false);
});
