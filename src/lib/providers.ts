export type ProviderId = 'gemini' | 'groq';

export type ModelTier = 'free' | 'pro';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  keyPlaceholder: string;
  keyPrefix: string;
  keyHint: string;
  docsUrl: string;
  freeTierNote: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  tier: ModelTier;
  contextWindow?: number;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyPlaceholder: 'AIzaSy...',
    keyPrefix: 'AIza',
    keyHint: 'Google AI Studio se key le (free tier available)',
    docsUrl: 'https://aistudio.google.com/apikey',
    freeTierNote: 'Flash aur Flash-Lite models free tier me chalte hain'
  },
  {
    id: 'groq',
    label: 'Groq',
    keyPlaceholder: 'gsk_...',
    keyPrefix: 'gsk_',
    keyHint: 'Groq console se key le (free tier available)',
    docsUrl: 'https://console.groq.com/keys',
    freeTierNote: 'gpt-oss aur qwen models free tier me chalte hain'
  }
];

export function getProviderMeta(provider: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];
}

/**
 * Curated tier data, based on provider docs checked in Oct 2026.
 * Final availability always depends on the user's own key/plan, so every
 * unknown model is treated as `pro` instead of promising something free.
 */
const GEMINI_FREE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash'
];

const GEMINI_PAID_ONLY_MODELS = ['gemini-4-argon'];

const GROQ_FREE_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.8-27b',
  'groq/compound',
  'groq/compound-mini'
];

/** Non-chat models (speech, moderation) never belong in a code assistant picker. */
const NON_CHAT_PATTERNS = [
  'whisper', 'tts', 'orpheus', 'prompt-guard', 'safeguard-preview',
  'embedding', 'aqa', 'image-generation', 'imagen', 'veo', 'robotics', 'learnlm'
];

export function isChatModel(provider: ProviderId, modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (provider === 'gemini' && !id.startsWith('gemini')) return false;
  return !NON_CHAT_PATTERNS.some((pattern) => id.includes(pattern));
}

export function classifyTier(provider: ProviderId, modelId: string): ModelTier {
  const id = modelId.toLowerCase();

  if (provider === 'gemini') {
    if (GEMINI_PAID_ONLY_MODELS.includes(id)) return 'pro';
    if (GEMINI_FREE_MODELS.includes(id)) return 'free';
    if (id.includes('pro') || id.includes('ultra') || id.includes('argon')) return 'pro';
    return id.includes('flash') ? 'free' : 'pro';
  }

  if (GROQ_FREE_MODELS.includes(id)) return 'free';
  return 'pro';
}

export function prettifyModelId(modelId: string): string {
  const raw = modelId.replace(/^models\//, '');
  const tail = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  return tail
    .split('-')
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (part.length <= 3) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function buildModelList(
  provider: ProviderId,
  modelIds: string[],
  contextWindows: Record<string, number> = {}
): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];

  modelIds.forEach((rawId) => {
    const id = rawId.replace(/^models\//, '');
    if (seen.has(id) || !isChatModel(provider, id)) return;
    seen.add(id);
    models.push({
      id,
      label: prettifyModelId(id),
      provider,
      tier: classifyTier(provider, id),
      contextWindow: contextWindows[id]
    });
  });

  const tierRank: Record<ModelTier, number> = { free: 0, pro: 1 };
  return models.sort((a, b) => {
    if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier];
    return a.label.localeCompare(b.label);
  });
}

export function defaultModelFor(provider: ProviderId, models: ModelInfo[]): string {
  if (models.length === 0) return '';
  const preferred = models.find((m) => m.tier === 'free') || models[0];
  return preferred.id;
}

/** Cheapest possible client-side sanity check before hitting the network. */
export function looksLikeKeyFor(provider: ProviderId, apiKey: string): boolean {
  const key = apiKey.trim();
  if (key.length < 20) return false;
  if (provider === 'groq') return key.startsWith('gsk_');
  return key.startsWith('AIza');
}

/**
 * Guesses which provider a key belongs to from its prefix. Used to catch the
 * common mistake of pasting a Groq key into the Gemini field (or vice versa).
 */
export function detectProviderFromKey(apiKey: string): ProviderId | null {
  const key = apiKey.trim();
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('AIza')) return 'gemini';
  return null;
}
