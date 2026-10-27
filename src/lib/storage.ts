import type { ProviderId } from './providers';
import type { PlanTier, RecentEntry } from './types';
import { mirrorSecureItem, removeSecureItem } from './secureStore';

const STORE_KEYS = {
  apiKey: (provider: ProviderId) => `shadrox.byok.${provider}`,
  selectedModel: (provider: ProviderId) => `shadrox.model.${provider}`,
  activeProvider: 'shadrox.provider.active',
  useSharedKey: 'shadrox.key.shared',
  plan: 'shadrox.plan',
  recents: 'shadrox.recents'
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
  const val = safeGet(STORE_KEYS.activeProvider);
  return val === 'groq' ? 'groq' : 'gemini';
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

/** Whether the user runs on ShadRox's shared key instead of their own. */
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
