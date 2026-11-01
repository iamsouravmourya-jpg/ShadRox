import type { ProviderId } from './providers';
import type { PlanTier, RecentEntry } from './types';
import {
  deleteSecretItem,
  mirrorSecureItem,
  purgePlaintextSecret,
  readSecretItem,
  removeSecureItem,
  writeSecretItem
} from './secureStore';

const STORE_KEYS = {
  apiKey: (provider: ProviderId) => `shadrox.byok.${provider}`,
  selectedModel: (provider: ProviderId) => `shadrox.model.${provider}`,
  activeProvider: 'shadrox.provider.active',
  useSharedKey: 'shadrox.key.shared',
  plan: 'shadrox.plan',
  recents: 'shadrox.recents',
  /** The custom endpoint's base URL. Not a credential, so it stays in plain storage. */
  customBaseUrl: 'shadrox.endpoint.custom.baseurl',
  /** Model ids the user typed for an endpoint that does not list /models. */
  customExtraModels: 'shadrox.endpoint.custom.models'
} as const;

const PROVIDER_IDS: ProviderId[] = ['gemini', 'groq', 'custom'];

const MAX_RECENTS = 8;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[shadrox] could not persist ${key}`, err);
  }
  mirrorSecureItem(key, value);
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  removeSecureItem(key);
}

/**
 * Provider keys go through the secret path: on desktop they live in the
 * OS-encrypted store plus session memory and are never written to localStorage,
 * in a browser there is no alternative so localStorage stays the store.
 */
export function getApiKey(provider: ProviderId): string {
  const key = STORE_KEYS.apiKey(provider);
  return readSecretItem(key) || '';
}

export function setApiKey(provider: ProviderId, apiKey: string): void {
  const key = STORE_KEYS.apiKey(provider);
  if (apiKey.trim()) {
    writeSecretItem(key, apiKey.trim());
  } else {
    deleteSecretItem(key);
  }
  // Older builds mirrored the plaintext key into localStorage. Drop it on
  // desktop; in a browser localStorage is the store, so nothing is stale.
  purgePlaintextSecret(key);
}

export function getActiveProvider(): ProviderId {
  const val = safeGet(STORE_KEYS.activeProvider);
  // Any id the app no longer knows about falls back to the default; a saved
  // value must never be silently rewritten into a different provider.
  return PROVIDER_IDS.includes(val as ProviderId) ? (val as ProviderId) : 'gemini';
}

export function setActiveProvider(provider: ProviderId): void {
  safeSet(STORE_KEYS.activeProvider, provider);
}

/** Base URL for the BYOK custom endpoint. Empty string means "not configured". */
export function getCustomBaseUrl(): string {
  return safeGet(STORE_KEYS.customBaseUrl) || '';
}

export function setCustomBaseUrl(baseUrl: string): void {
  const value = baseUrl.trim();
  if (value) safeSet(STORE_KEYS.customBaseUrl, value);
  else safeRemove(STORE_KEYS.customBaseUrl);
}

/** Comma-separated model ids the user declared for an endpoint without /models. */
export function getCustomExtraModels(): string[] {
  const raw = safeGet(STORE_KEYS.customExtraModels);
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function setCustomExtraModels(modelIds: string[]): void {
  const value = modelIds.map((entry) => entry.trim()).filter(Boolean).join(',');
  if (value) safeSet(STORE_KEYS.customExtraModels, value);
  else safeRemove(STORE_KEYS.customExtraModels);
}

export function getSelectedModel(provider: ProviderId): string {
  return safeGet(STORE_KEYS.selectedModel(provider)) || '';
}

export function setSelectedModel(provider: ProviderId, modelId: string): void {
  if (modelId) safeSet(STORE_KEYS.selectedModel(provider), modelId);
}

/** Whether the user runs on ShadRox's shared key instead of their own. */
export function getUseSharedKey(): boolean {
  return safeGet(STORE_KEYS.useSharedKey) === 'true';
}

export function setUseSharedKey(value: boolean): void {
  if (value) safeSet(STORE_KEYS.useSharedKey, 'true');
  else safeRemove(STORE_KEYS.useSharedKey);
}

/**
 * The old ladder had tiers this one no longer has. Reading them maps the user
 * to their nearest successor instead of silently dropping them to Free; a
 * stored 'pro' is the one ambiguous value and resolves to the new Pro, which
 * grants more than the old tier did rather than less.
 */
const LEGACY_PLAN_MIGRATION: Record<string, PlanTier> = {
  adv: 'pro',
  enterprise: 'pro'
};

export function getPlan(): PlanTier {
  const raw = safeGet(STORE_KEYS.plan);
  if (raw === 'free' || raw === 'starter' || raw === 'pro') return raw;
  return LEGACY_PLAN_MIGRATION[raw ?? ''] ?? 'free';
}

export function setPlan(plan: PlanTier): void {
  safeSet(STORE_KEYS.plan, plan);
}

export function getRecentWorkspaces(): RecentEntry[] {
  const raw = safeGet(STORE_KEYS.recents);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

export interface PushRecentInput {
  id?: string;
  name: string;
  path: string;
  filePaths?: string[];
  fileCount: number;
  kind: 'folder' | 'file';
}

export function pushRecentWorkspace(input: PushRecentInput): RecentEntry[] {
  const id = input.id || (
    input.kind === 'folder'
      ? `folder-${input.path}`
      : `file-${input.filePaths?.length ? input.filePaths.join('|') : input.path}`
  );
  const current = getRecentWorkspaces().filter((item) => item.id !== id);
  const next: RecentEntry[] = [{ ...input, id, openedAt: Date.now() }, ...current].slice(0, MAX_RECENTS);
  safeSet(STORE_KEYS.recents, JSON.stringify(next));
  return next;
}

export function removeRecentWorkspace(id: string): RecentEntry[] {
  const next = getRecentWorkspaces().filter((item) => item.id !== id);
  safeSet(STORE_KEYS.recents, JSON.stringify(next));
  return next;
}

export const recordRecentWorkspace = pushRecentWorkspace;
