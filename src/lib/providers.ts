export type ProviderId = 'gemini' | 'groq' | 'custom';

/**
 * `own` marks a model that costs whatever the user's own endpoint charges.
 * It is neither free nor ShadRox-Pro, so the picker must not promise either.
 */
export type ModelTier = 'free' | 'pro' | 'own';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  keyPlaceholder: string;
  /** '' for a provider that accepts any key shape. */
  keyPrefix: string;
  keyHint: string;
  docsUrl: string;
  freeTierNote: string;
  /** 'custom' brings its own endpoint, so the UI must ask for a base URL. */
  needsBaseUrl?: boolean;
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
    keyHint: 'Get your key from Google AI Studio (Free tier available)',
    docsUrl: 'https://aistudio.google.com/apikey',
    freeTierNote: 'Flash and Flash-Lite models supported on free tier'
  },
  {
    id: 'groq',
    label: 'Groq',
    keyPlaceholder: 'gsk_...',
    keyPrefix: 'gsk_',
    keyHint: 'Get your key from Groq Console (Free tier available)',
    docsUrl: 'https://console.groq.com/keys',
    freeTierNote: 'High-speed OSS and Qwen models supported on free tier'
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    keyPlaceholder: 'sk-...',
    keyPrefix: '',
    keyHint: 'Any OpenAI-compatible /chat/completions endpoint. Pick a preset or paste your own base URL',
    docsUrl: 'https://openrouter.ai/settings/keys',
    needsBaseUrl: true,
    freeTierNote: 'You pay your endpoint directly. ShadRox never sees or stores the URL against an account'
  }
];

/**
 * Chat-completions endpoints that answer to a well-known key. Anything not here
 * still works through the free-text base URL field — gateways that resell
 * credits are exactly the reason the field is editable.
 */
export interface EndpointPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyPrefixHint: string;
  docsUrl: string;
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyPrefixHint: 'sk-or-...', docsUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyPrefixHint: 'sk-...', docsUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', keyPrefixHint: 'xai-...', docsUrl: 'https://console.x.ai' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyPrefixHint: '...key', docsUrl: 'https://api.together.xyz/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', keyPrefixHint: 'fw-...', docsUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyPrefixHint: '...key', docsUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyPrefixHint: '...key', docsUrl: 'https://cloud.cerebras.ai' },
  { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyPrefixHint: 'sk-...', docsUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'github', label: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', keyPrefixHint: 'ghp_ / gith', docsUrl: 'https://github.com/settings/personal-access-tokens' },
  { id: 'groq', label: 'Groq (compat)', baseUrl: 'https://api.groq.com/openai/v1', keyPrefixHint: 'gsk_...', docsUrl: 'https://console.groq.com/keys' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', keyPrefixHint: 'any text', docsUrl: 'https://ollama.com/library' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', keyPrefixHint: 'any text', docsUrl: 'https://lmstudio.ai/docs' }
];

/** The preset whose base URL matches, or null for a URL the user typed. */
export function findEndpointPreset(baseUrl: string): EndpointPreset | null {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return null;
  return ENDPOINT_PRESETS.find((preset) => normalizeBaseUrl(preset.baseUrl) === normalized) || null;
}

/**
 * Trims a base URL to the origin-plus-path that `/chat/completions` and
 * `/models` are appended to: no trailing slash, no query, no fragment, no
 * embedded credentials. Deliberately forgiving about case and spacing because
 * this is a paste target; it returns '' for anything unparseable and leaves
 * scheme/host policy to the server.
 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return '';
  }
  if (url.username || url.password) return '';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Client-side gate so an obviously broken URL never reaches the network. */
export function looksLikeBaseUrl(raw: string): boolean {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) return false;
  return /^https?:\/\//i.test(normalized);
}

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

/**
 * ShadRox's shared key is a paid key, so it is restricted to models ShadRox marks
 * as Pro (the same `classifyTier` rule the server enforces). When the shared key
 * is on there is no BYOK key to list models from, so the picker uses this small
 * static catalog instead.
 */
const SHARED_MODELS: Record<ProviderId, string[]> = {
  gemini: ['gemini-4-argon'],
  groq: [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.3-70b-versatile',
    'moonshotai/kimi-k2-instruct',
    'qwen/qwen3-32b'
  ],
  // ShadRox has no key of its own for arbitrary endpoints, so there is nothing
  // to share. The picker stays empty and BYOK is the only path.
  custom: []
};

/** Default shared-key model per provider. Scout is the cheapest fast-tier option,
 *  which is what the Pro plan's pricing is modelled on. */
export const DEFAULT_SHARED_MODEL: Record<ProviderId, string> = {
  gemini: 'gemini-4-argon',
  groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  custom: ''
};

/** Pro-tier models ShadRox's shared key can serve for this provider. */
export function buildSharedModelList(provider: ProviderId): ModelInfo[] {
  return buildModelList(provider, SHARED_MODELS[provider]);
}

/** Non-chat models (speech, moderation) never belong in a code assistant picker. */
const NON_CHAT_PATTERNS = [
  'whisper', 'tts', 'orpheus', 'prompt-guard', 'safeguard-preview',
  'embedding', 'aqa', 'image-generation', 'imagen', 'veo', 'robotics', 'learnlm',
  // Names arbitrary endpoints expose that are still not chat models.
  'moderation', 'audio', 'realtime', 'transcribe', 'dall-e', 'rerank', 'embed'
];

export function isChatModel(provider: ProviderId, modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (provider === 'gemini' && !id.startsWith('gemini')) return false;
  return !NON_CHAT_PATTERNS.some((pattern) => id.includes(pattern));
}

export function classifyTier(provider: ProviderId, modelId: string): ModelTier {
  const id = modelId.toLowerCase();

  if (provider === 'custom') return 'own';

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
    // Hand-typed ids come from a comma-separated settings field, so spaces and
    // empty entries between commas are normal, not meaningful.
    const id = rawId.trim().replace(/^models\//, '');
    if (!id || seen.has(id) || !isChatModel(provider, id)) return;
    seen.add(id);
    models.push({
      id,
      label: prettifyModelId(id),
      provider,
      tier: classifyTier(provider, id),
      contextWindow: contextWindows[id]
    });
  });

  const tierRank: Record<ModelTier, number> = { free: 0, own: 1, pro: 2 };
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
  // A custom endpoint issues whatever its operator chooses, and local servers
  // accept any non-empty placeholder, so nothing about the shape can be checked.
  if (provider === 'custom') return key.length > 0;
  if (key.length < 20) return false;
  if (provider === 'groq') return key.startsWith('gsk_');
  return key.startsWith('AIza');
}

/**
 * Guesses which provider a key belongs to from its prefix. Used to catch the
 * common mistake of pasting a Groq key into the Gemini field (or vice versa).
 * A custom endpoint is exempt: gateways re-issue upstream credentials under
 * their own key, so a prefix means nothing there.
 */
export function detectProviderFromKey(apiKey: string): ProviderId | null {
  const key = apiKey.trim();
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('AIza')) return 'gemini';
  return null;
}

/**
 * Explains why a candidate key cannot be used, naming the credential the user
 * probably pasted. The key itself is never echoed: callers only ever see a
 * prefix class and a link to the provider's key page.
 */
export function describeKeyFormatProblem(provider: ProviderId, apiKey: string): string | null {
  const key = apiKey.trim();
  if (looksLikeKeyFor(provider, key)) return null;

  const meta = getProviderMeta(provider);

  if (provider === 'custom') {
    return `Enter the key this endpoint issues. Local servers such as Ollama and LM Studio accept any placeholder text — the endpoint itself is what rejects or accepts it.`;
  }

  // Google sign-in tokens (Gemini CLI, Code Assist, gcloud) start with AQ./ya29.
  // They are hour-long OAuth tokens, not API keys, and the Gemini API rejects them.
  if (key.startsWith('AQ.') || key.startsWith('ya29.')) {
    return `That is a Google sign-in token, not a Gemini API key — it expires and the Gemini API rejects it. Open Google AI Studio (${meta.docsUrl}), click "Create API key", and paste the key that starts with AIza.`;
  }
  if (key.startsWith('sk-')) {
    return `That looks like an OpenAI-format key. ${meta.label} needs a key starting with ${meta.keyPrefix} — create one at ${meta.docsUrl}, or switch to "Custom endpoint" and point it at an OpenAI-compatible URL.`;
  }
  if (key.startsWith('xai-')) {
    return `That looks like an xAI key. ${meta.label} needs a key starting with ${meta.keyPrefix} — create one at ${meta.docsUrl}, or use "Custom endpoint" with https://api.x.ai/v1.`;
  }
  if (key.startsWith('gsk_')) {
    return `That looks like a Groq key. Select Groq above, or point "Custom endpoint" at https://api.groq.com/openai/v1.`;
  }
  if (key.startsWith('AIza')) {
    return `That looks like a Google AI Studio key. Select Google Gemini above, or create a ${meta.label} key at ${meta.docsUrl}.`;
  }
  return `That does not look like a ${meta.label} key — it should start with ${meta.keyPrefix}. Create one at ${meta.docsUrl}.`;
}
