import { getDesktopBridge } from './desktop';

const KEY_PREFIX = 'shadrox.';

let hydrated = false;

/**
 * Restores settings that live in the OS-encrypted desktop store back into
 * localStorage. This makes saved API keys survive cache clears, a changed
 * renderer origin, or a reinstall that keeps the user profile.
 */
export async function hydrateSecureStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const store = getDesktopBridge()?.secureStore;
  if (!store) return;

  try {
    const values = await store.getAll();
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(KEY_PREFIX) || typeof value !== 'string') continue;
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

/** Mirrors a setting into the encrypted desktop store (no-op in a browser). */
export function mirrorSecureItem(key: string, value: string): void {
  const store = getDesktopBridge()?.secureStore;
  if (!store || !key.startsWith(KEY_PREFIX)) return;
  void store.set(key, value).catch((error) => {
    console.warn(`[shadrox] could not encrypt ${key}`, error);
  });
}

export function removeSecureItem(key: string): void {
  const store = getDesktopBridge()?.secureStore;
  if (!store || !key.startsWith(KEY_PREFIX)) return;
  void store.delete(key).catch((error) => {
    console.warn(`[shadrox] could not remove encrypted ${key}`, error);
  });
}
