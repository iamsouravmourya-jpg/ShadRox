import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefixStripper } from './ai';
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
