/**
 * Consent lives outside the repository on purpose. A workspace can ship plugin
 * and automation manifests, but nothing runs until the user enables it here;
 * otherwise cloning a repository would be enough to start spending credits.
 */

const PLUGIN_PREFIX = 'shadrox.plugins.enabled.v1.';
const AUTOMATION_PREFIX = 'shadrox.automations.enabled.v1.';

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

export function readPluginConsent(root: string | null | undefined): Set<string> {
  const normalized = consentRoot(root);
  if (!normalized) return new Set();
  try {
    const raw = storage()?.getItem(pluginKey(root));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setPluginEnabled(root: string | null | undefined, id: string, enabled: boolean): Set<string> {
  const normalized = consentRoot(root);
  const next = readPluginConsent(root);
  if (!normalized || !id) return next;
  if (enabled) next.add(id);
  else next.delete(id);
  try {
    storage()?.setItem(pluginKey(root), JSON.stringify([...next].sort()));
  } catch {
    /* private mode: consent simply does not persist */
  }
  return next;
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
