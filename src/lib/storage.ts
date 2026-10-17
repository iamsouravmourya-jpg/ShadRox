import type { ProviderId } from './providers';
import type { PlanTier, RecentEntry } from './types';

const STORE_KEYS = {
  apiKey: (provider: ProviderId) => `devora.byok.${provider}`,
  selectedModel: (provider: ProviderId) => `devora.model.${provider}`,
  activeProvider: 'devora.provider.active',
  useSharedKey: 'devora.key.shared',
  plan: 'devora.plan',
  session: 'devora.session',
  recents: 'devora.recents'
} as const;

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
    console.warn(`[devora] could not persist ${key}`, err);
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getApiKey(provider: ProviderId): string {
  return safeGet(STORE_KEYS.apiKey(provider)) || '';
}

export function setApiKey(provider: ProviderId, apiKey: string): void {
  if (apiKey.trim()) {
    safeSet(STORE_KEYS.apiKey(provider), apiKey.trim());
  } else {
    safeRemove(STORE_KEYS.apiKey(provider));
  }
}

export function getActiveProvider(): ProviderId {
  return safeGet(STORE_KEYS.activeProvider) === 'groq' ? 'groq' : 'gemini';
}

export function setActiveProvider(provider: ProviderId): void {
  safeSet(STORE_KEYS.activeProvider, provider);
}

export function getSelectedModel(provider: ProviderId): string {
  return safeGet(STORE_KEYS.selectedModel(provider)) || '';
}

export function setSelectedModel(provider: ProviderId, modelId: string): void {
  if (modelId) safeSet(STORE_KEYS.selectedModel(provider), modelId);
}

/** Whether the user runs on Devora's shared key instead of their own. */
export function getUseSharedKey(): boolean {
  return safeGet(STORE_KEYS.useSharedKey) === 'true';
}

export function setUseSharedKey(value: boolean): void {
  if (value) safeSet(STORE_KEYS.useSharedKey, 'true');
  else safeRemove(STORE_KEYS.useSharedKey);
}

export function getPlan(): PlanTier {
  const raw = safeGet(STORE_KEYS.plan);
  return raw === 'pro' || raw === 'adv' || raw === 'enterprise' ? raw : 'free';
}

export function setPlan(plan: PlanTier): void {
  safeSet(STORE_KEYS.plan, plan);
}

export function getSessionToken(): string {
  return safeGet(STORE_KEYS.session) || '';
}

export function setSessionToken(token: string): void {
  safeSet(STORE_KEYS.session, token);
}

export function clearSessionToken(): void {
  safeRemove(STORE_KEYS.session);
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

/** Remembers an opened folder/file so Stage 2 can show a real "recently opened" list. */
export function pushRecentWorkspace(entry: Omit<RecentEntry, 'id' | 'openedAt'>): RecentEntry[] {
  const next: RecentEntry[] = [
    { ...entry, id: `${entry.kind}-${entry.path}-${Date.now()}`, openedAt: Date.now() },
    ...getRecentWorkspaces().filter((item) => item.path !== entry.path)
  ].slice(0, MAX_RECENTS);

  safeSet(STORE_KEYS.recents, JSON.stringify(next));
  return next;
}
