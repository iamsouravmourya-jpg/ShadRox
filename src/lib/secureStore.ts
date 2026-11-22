import { getDesktopBridge } from './desktop';

const KEY_PREFIX = 'shadrox.';

/**
 * Which settings are secrets.
 *
 * Deliberately an explicit allowlist rather than "every `shadrox.*` key": most
 * of them (active provider, selected model, plan, recents, feature toggles) are
 * not sensitive and must keep the synchronous localStorage behaviour they have
 * always had, because `getStoredItem` is read all over the app at render time.
 * Only provider API keys are secrets, and they are the only values that must
 * never be mirrored into plaintext.
 */
const SECRET_KEY_PREFIXES = ['shadrox.byok.', 'shadrox.auth.'];
const ENCRYPTED_PREFIX = 'enc:v1:';
const IDB_DB_NAME = 'shadrox-keystore';
const IDB_STORE_NAME = 'keys';
const IDB_KEY_ID = 'byok-aes-gcm-v1';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Secrets for this session, held in memory only. */
const secretMemory = new Map<string, string>();
let hydrated = false;
let webCryptoKeyPromise: Promise<CryptoKey | null> | null = null;
let pendingBrowserWrites: Promise<void> = Promise.resolve();

function secureBridge() {
  return getDesktopBridge()?.secureStore ?? null;
}

/** True when secrets come from OS-backed Electron encrypted storage. */
export function usesEncryptedSecrets(): boolean {
  return secureBridge() !== null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function canUseWebCryptoKeystore(): boolean {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined' &&
    typeof globalThis.indexedDB !== 'undefined'
  );
}

async function openKeystoreDb(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbGetKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(IDB_KEY_ID);
    req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
  });
}

async function idbPutKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const req = tx.objectStore(IDB_STORE_NAME).put(key, IDB_KEY_ID);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('IndexedDB write failed'));
  });
}

async function getOrCreateBrowserCryptoKey(): Promise<CryptoKey | null> {
  if (!canUseWebCryptoKeystore()) return null;
  if (!webCryptoKeyPromise) {
    webCryptoKeyPromise = (async () => {
      let db: IDBDatabase | null = null;
      try {
        db = await openKeystoreDb();
        const existing = await idbGetKey(db);
        if (existing) return existing;
        // Non-extractable AES-256-GCM key: scripts cannot read the raw key bytes out of IndexedDB.
        const generated = await globalThis.crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        await idbPutKey(db, generated);
        return generated;
      } catch {
        return null;
      } finally {
        db?.close();
      }
    })();
  }
  return await webCryptoKeyPromise;
}

async function encryptForBrowserStorage(plaintext: string): Promise<string | null> {
  const key = await getOrCreateBrowserCryptoKey();
  if (!key) return null;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const cipherBytes = new Uint8Array(cipherBuffer);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return `${ENCRYPTED_PREFIX}${bytesToBase64(combined)}`;
}

async function decryptFromBrowserStorage(stored: string): Promise<string | null> {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  const key = await getOrCreateBrowserCryptoKey();
  if (!key) return null;
  try {
    const combined = base64ToBytes(stored.slice(ENCRYPTED_PREFIX.length));
    if (combined.length <= 12) return null;
    const iv = combined.slice(0, 12);
    const cipherBytes = combined.slice(12);
    const plainBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBytes
    );
    return new TextDecoder().decode(plainBuffer);
  } catch {
    return null;
  }
}

function listLocalStorageSecretKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && isSecretKey(key)) keys.push(key);
    }
  } catch {
    /* localStorage unavailable */
  }
  return keys;
}

function enqueueBrowserWrite(task: () => Promise<void>): void {
  pendingBrowserWrites = pendingBrowserWrites.then(task, task);
}

/** Flushes pending asynchronous WebCrypto localStorage writes (used in tests). */
export async function flushBrowserSecretWrites(): Promise<void> {
  await pendingBrowserWrites;
}

/**
 * Loads the encrypted secrets into memory for this session.
 *
 * On desktop, secrets live in OS-backed `safeStorage` and any leftover plaintext
 * in localStorage is purged. In browser mode, secrets are encrypted at rest
 * with a non-extractable WebCrypto AES-256-GCM key held in IndexedDB, and any
 * legacy plaintext entry in localStorage is migrated immediately on boot.
 */
export async function hydrateSecureStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const store = secureBridge();
  if (!store) {
    for (const key of listLocalStorageSecretKeys()) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        raw = null;
      }
      if (!raw) continue;
      if (raw.startsWith(ENCRYPTED_PREFIX)) {
        const decrypted = await decryptFromBrowserStorage(raw);
        if (decrypted !== null) secretMemory.set(key, decrypted);
        continue;
      }
      // Legacy plaintext secret in browser localStorage: keep in memory and upgrade in place.
      secretMemory.set(key, raw);
      const encrypted = await encryptForBrowserStorage(raw);
      if (encrypted) {
        try {
          localStorage.setItem(key, encrypted);
        } catch {
          /* ignore */
        }
      }
    }
    return;
  }

  try {
    const values = await store.getAll();
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(KEY_PREFIX) || typeof value !== 'string') continue;
      if (isSecretKey(key)) {
        secretMemory.set(key, value);
        // Remove the plaintext mirror a previous version wrote.
        purgePlaintextSecret(key);
        continue;
      }
      // Non-secret settings keep restoring into localStorage as before.
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      } catch {
        /* localStorage can be unavailable; the encrypted copy still exists */
      }
    }
  } catch (error) {
    console.warn('[shadrox] could not restore encrypted settings', error);
  }
}

/**
 * Synchronous secret read.
 *
 * `getStoredItem()` is sync and called from React initialisers, so secrets have
 * to be in memory before the first render: `main.tsx` awaits `hydrateSecureStore()`
 * before mounting.
 */
export function readSecretItem(key: string): string | null {
  if (!isSecretKey(key)) return null;
  if (secretMemory.has(key)) return secretMemory.get(key) ?? null;
  if (!usesEncryptedSecrets()) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw || raw.startsWith(ENCRYPTED_PREFIX)) return null;
      return raw;
    } catch {
      return null;
    }
  }
  return null;
}

export function writeSecretItem(key: string, value: string): void {
  if (!isSecretKey(key)) return;
  secretMemory.set(key, value);
  if (!usesEncryptedSecrets()) {
    if (!canUseWebCryptoKeystore()) {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        console.warn(`[shadrox] could not persist ${key}`, error);
      }
      return;
    }
    enqueueBrowserWrite(async () => {
      const encrypted = await encryptForBrowserStorage(value);
      // Only commit if the in-memory value wasn't subsequently changed or deleted.
      if (secretMemory.get(key) !== value) return;
      try {
        if (encrypted) {
          localStorage.setItem(key, encrypted);
        }
      } catch (error) {
        console.warn(`[shadrox] could not persist ${key}`, error);
      }
    });
    return;
  }
  const store = secureBridge();
  void store?.set(key, value).catch((error) => {
    console.warn(`[shadrox] could not encrypt ${key}`, error);
  });
}

export function deleteSecretItem(key: string): void {
  if (!isSecretKey(key)) return;
  secretMemory.delete(key);
  if (!usesEncryptedSecrets()) {
    if (!canUseWebCryptoKeystore()) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    enqueueBrowserWrite(async () => {
      if (secretMemory.has(key)) return;
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    });
    return;
  }
  const store = secureBridge();
  void store?.delete(key).catch((error) => {
    console.warn(`[shadrox] could not remove encrypted ${key}`, error);
  });
}

/**
 * Deletes a leftover plaintext copy of a secret from localStorage on desktop.
 * In browser mode `localStorage` holds the `enc:v1:...` WebCrypto ciphertext.
 */
export function purgePlaintextSecret(key: string): void {
  if (!usesEncryptedSecrets()) return;
  try {
    if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
  } catch {
    /* localStorage can be unavailable */
  }
}

/** Test seam: drops the session secret cache and the hydrated flag. */
export function resetSecretStoreForTests(): void {
  secretMemory.clear();
  hydrated = false;
  webCryptoKeyPromise = null;
  pendingBrowserWrites = Promise.resolve();
}

/** Mirrors a non-secret setting into the encrypted desktop store (no-op in a browser). */
export function mirrorSecureItem(key: string, value: string): void {
  const store = secureBridge();
  if (!store || !key.startsWith(KEY_PREFIX) || isSecretKey(key)) return;
  void store.set(key, value).catch((error) => {
    console.warn(`[shadrox] could not encrypt ${key}`, error);
  });
}

export function removeSecureItem(key: string): void {
  const store = secureBridge();
  if (!store || !key.startsWith(KEY_PREFIX) || isSecretKey(key)) return;
  void store.delete(key).catch((error) => {
    console.warn(`[shadrox] could not remove encrypted ${key}`, error);
  });
}
