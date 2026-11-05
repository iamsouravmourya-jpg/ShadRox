/**
 * Consent lives outside the repository on purpose. A workspace can ship plugin
 * and automation manifests, but nothing runs until the user enables it here;
 * otherwise cloning a repository would be enough to start spending credits.
 */

const PLUGIN_PREFIX = 'shadrox.plugins.enabled.v2.';
const AUTOMATION_PREFIX = 'shadrox.automations.enabled.v1.';
const PLUGIN_CONSENT_VERSION = 2;

export const WORKSPACE_CONFIG_EVENT = 'shadrox:workspace-config-changed';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function consentRoot(root: string | null | undefined): string {
  if (typeof root !== 'string') return '';
  const normalized = root.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function pluginKey(root: string | null | undefined): string {
  return `${PLUGIN_PREFIX}${consentRoot(root)}`;
}

function automationKey(root: string | null | undefined): string {
  return `${AUTOMATION_PREFIX}${consentRoot(root)}`;
}

export function readPluginConsent(root: string | null | undefined): Map<string, string> {
  const normalized = consentRoot(root);
  if (!normalized) return new Map();
  try {
    const raw = storage()?.getItem(pluginKey(root));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== PLUGIN_CONSENT_VERSION ||
      typeof (parsed as { plugins?: unknown }).plugins !== 'object' ||
      (parsed as { plugins?: unknown }).plugins === null ||
      Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) return new Map();
    return new Map(
      Object.entries((parsed as { plugins: Record<string, unknown> }).plugins)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[a-f0-9]{64}$/.test(entry[1]))
    );
  } catch {
    return new Map();
  }
}

export function setPluginEnabled(
  root: string | null | undefined,
  id: string,
  enabled: boolean,
  manifestHash?: string
): Map<string, string> {
  const normalized = consentRoot(root);
  const next = readPluginConsent(root);
  if (!normalized || !id) return next;
  if (enabled) {
    if (!manifestHash || !/^[a-f0-9]{64}$/.test(manifestHash)) {
      throw new Error('A valid manifest hash is required before enabling a plugin.');
    }
    next.set(id, manifestHash);
  } else {
    next.delete(id);
  }
  const targetStorage = storage();
  if (!targetStorage) throw new Error('Plugin consent could not be saved in this browser context.');
  try {
    targetStorage.setItem(pluginKey(root), JSON.stringify({
      version: PLUGIN_CONSENT_VERSION,
      plugins: Object.fromEntries([...next.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }));
  } catch (error) {
    throw new Error('Plugin consent could not be saved.', { cause: error });
  }
  return next;
}

export async function hashPluginManifest(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Secure hashing is unavailable; plugin consent cannot be recorded.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hasAutomationConsent(root: string | null | undefined): boolean {
  if (!consentRoot(root)) return false;
  try {
    return storage()?.getItem(automationKey(root)) === '1';
  } catch {
    return false;
  }
}

export function setAutomationConsent(root: string | null | undefined, enabled: boolean): void {
  if (!consentRoot(root)) return;
  try {
    storage()?.setItem(automationKey(root), enabled ? '1' : '0');
  } catch {
    /* private mode: consent simply does not persist */
  }
}

export function notifyWorkspaceConfigChanged(): void {
  try {
    window.dispatchEvent(new Event(WORKSPACE_CONFIG_EVENT));
  } catch {
    /* no window (tests) */
  }
}
