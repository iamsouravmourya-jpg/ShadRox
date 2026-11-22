import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flushBrowserSecretWrites,
  hydrateSecureStore,
  readSecretItem,
  resetSecretStoreForTests,
  writeSecretItem,
  deleteSecretItem
} from './secureStore';

function installBrowserMocks() {
  const backing = new Map<string, string>();
  const idbKeys = new Map<string, unknown>();

  const localStorageMock = {
    get length() { return backing.size; },
    key(index: number) { return [...backing.keys()][index] ?? null; },
    getItem(key: string) { return backing.get(key) ?? null; },
    setItem(key: string, value: string) { backing.set(key, String(value)); },
    removeItem(key: string) { backing.delete(key); },
    clear() { backing.clear(); }
  };

  const indexedDBMock = {
    open() {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction: () => ({
            objectStore: () => ({
              get(id: string) {
                const getReq: Record<string, unknown> = { result: undefined };
                queueMicrotask(() => {
                  getReq.result = idbKeys.get(id);
                  if (typeof getReq.onsuccess === 'function') (getReq.onsuccess as () => void)();
                });
                return getReq;
              },
              put(value: unknown, id: string) {
                const putReq: Record<string, unknown> = {};
                queueMicrotask(() => {
                  idbKeys.set(id, value);
                  if (typeof putReq.onsuccess === 'function') (putReq.onsuccess as () => void)();
                });
                return putReq;
              }
            })
          })
        };
        req.result = db;
        if (typeof req.onupgradeneeded === 'function') (req.onupgradeneeded as () => void)();
        if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
      });
      return req;
    }
  };

  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevStorage = (globalThis as Record<string, unknown>).localStorage;
  const prevIdb = (globalThis as Record<string, unknown>).indexedDB;

  (globalThis as Record<string, unknown>).window = {};
  (globalThis as Record<string, unknown>).localStorage = localStorageMock;
  (globalThis as Record<string, unknown>).indexedDB = indexedDBMock;

  return {
    backing,
    restore() {
      (globalThis as Record<string, unknown>).window = prevWindow;
      (globalThis as Record<string, unknown>).localStorage = prevStorage;
      (globalThis as Record<string, unknown>).indexedDB = prevIdb;
      resetSecretStoreForTests();
    }
  };
}

test('browser mode encrypts secrets with WebCrypto AES-GCM and migrates plaintext keys', async () => {
  const env = installBrowserMocks();
  try {
    // 1. Legacy plaintext key exists before boot
    env.backing.set('shadrox.byok.gemini', 'AIzaLegacyPlaintextKey1234567890');
    await hydrateSecureStore();

    assert.equal(readSecretItem('shadrox.byok.gemini'), 'AIzaLegacyPlaintextKey1234567890');
    const migrated = env.backing.get('shadrox.byok.gemini') ?? '';
    assert.ok(migrated.startsWith('enc:v1:'), `Expected ciphertext prefix, got: ${migrated}`);
    assert.equal(migrated.includes('AIzaLegacyPlaintextKey'), false);

    // 2. Writing a new secret keeps memory synced and stores only ciphertext in localStorage
    writeSecretItem('shadrox.byok.groq', 'gsk_super_secret_browser_key_12345');
    await flushBrowserSecretWrites();
    assert.equal(readSecretItem('shadrox.byok.groq'), 'gsk_super_secret_browser_key_12345');
    const storedGroq = env.backing.get('shadrox.byok.groq') ?? '';
    assert.ok(storedGroq.startsWith('enc:v1:'));
    assert.equal(storedGroq.includes('gsk_super_secret'), false);

    // 3. Deleting removes both memory and localStorage ciphertext
    deleteSecretItem('shadrox.byok.groq');
    await flushBrowserSecretWrites();
    assert.equal(readSecretItem('shadrox.byok.groq'), null);
    assert.equal(env.backing.has('shadrox.byok.groq'), false);

    // 4. Reload simulation (clear memory cache, keep IDB key + ciphertext localStorage)
    resetSecretStoreForTests();
    await hydrateSecureStore();
    assert.equal(readSecretItem('shadrox.byok.gemini'), 'AIzaLegacyPlaintextKey1234567890');
  } finally {
    env.restore();
  }
});
