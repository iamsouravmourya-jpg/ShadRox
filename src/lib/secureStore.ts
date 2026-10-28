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

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Secrets for this session, held in memory only (desktop). */
const secretMemory = new Map<string, string>();
let hydrated = false;

function secureBridge() {
  return getDesktopBridge()?.secureStore ?? null;
}

/** True when secrets must come from the OS-encrypted store instead of localStorage. */
export function usesEncryptedSecrets(): boolean {
  return secureBridge() !== null;
}

/**
 * Loads the encrypted secrets into memory for this session.
 *
 * On desktop nothing is copied back into localStorage — doing that used to make
 * the `safeStorage` mirror decorative, since %APPDATA%\ShadRox\Local Storage
 * then held the decrypted key in plaintext. Any plaintext left behind by older
 * builds is purged here.
 */
export async function hydrateSecureStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const store = secureBridge();
  if (!store) return;

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
 * before mounting. In a browser there is no encrypted store, so localStorage
 * stays the source of truth exactly as it was.
 */
export function readSecretItem(key: string): string | null {
  if (!isSecretKey(key)) return null;
  if (!usesEncryptedSecrets()) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return secretMemory.get(key) ?? null;
}

export function writeSecretItem(key: string, value: string): void {
  if (!isSecretKey(key)) return;
  if (!usesEncryptedSecrets()) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      console.warn(`[shadrox] could not persist ${key}`, error);
    }
    return;
  }
  secretMemory.set(key, value);
  const store = secureBridge();
  void store?.set(key, value).catch((error) => {
    console.warn(`[shadrox] could not encrypt ${key}`, error);
  });
}

export function deleteSecretItem(key: string): void {
  if (!isSecretKey(key)) return;
  if (!usesEncryptedSecrets()) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  secretMemory.delete(key);
  const store = secureBridge();
  void store?.delete(key).catch((error) => {
    console.warn(`[shadrox] could not remove encrypted ${key}`, error);
  });
}

/**
 * Deletes a leftover plaintext copy of a secret from localStorage.
 *
 * Only meaningful on desktop: there the encrypted store is authoritative, so a
 * plaintext value is stale garbage an older build wrote. In a browser
 * localStorage *is* the secret store, so this must do nothing at all — calling
 * it there would erase the key that was just saved.
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
