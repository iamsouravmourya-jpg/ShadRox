// Adapted from Cline model metadata normalization (Apache-2.0).

export interface ModelMetadata {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheReadPricePerMillion: number;
  supportsPromptCache: boolean;
  supportsVision: boolean;
  supportsReasoningBudget: boolean;
}

export const KNOWN_MODELS_CATALOG: Record<string, ModelMetadata> = {
  // Gemini Models
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    cacheReadPricePerMillion: 0.0375,
    supportsPromptCache: true,
    supportsVision: true,
    supportsReasoningBudget: true
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    // 1M input, not the 2M figure that circulated for the preview: sizing a
    // request from the larger number gets a provider 400, not a longer answer.
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.00,
    cacheReadPricePerMillion: 0.3125,
    supportsPromptCache: true,
    supportsVision: true,
    supportsReasoningBudget: true
  },

  // Groq Models
  'llama-3.3-70b-versatile': {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B Versatile',
    provider: 'groq',
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
    cacheReadPricePerMillion: 0.59,
    supportsPromptCache: false,
    supportsVision: false,
    supportsReasoningBudget: false
  },
  'deepseek-r1-distill-llama-70b': {
    id: 'deepseek-r1-distill-llama-70b',
    name: 'DeepSeek R1 Distill Llama 70B',
    provider: 'groq',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 0.99,
    cacheReadPricePerMillion: 0.75,
    supportsPromptCache: false,
    supportsVision: false,
    supportsReasoningBudget: true
  },

  // OpenAI / Compatible Models
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPricePerMillion: 2.50,
    outputPricePerMillion: 10.00,
    cacheReadPricePerMillion: 1.25,
    supportsPromptCache: true,
    supportsVision: true,
    supportsReasoningBudget: false
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    cacheReadPricePerMillion: 0.075,
    supportsPromptCache: true,
    supportsVision: true,
    supportsReasoningBudget: false
  }
};

const DEFAULT_FALLBACK_METADATA: ModelMetadata = {
  id: 'custom-model',
  name: 'Custom Endpoint Model',
  provider: 'custom',
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  inputPricePerMillion: 0.20,
  outputPricePerMillion: 0.80,
  cacheReadPricePerMillion: 0.20,
  supportsPromptCache: false,
  supportsVision: false,
  supportsReasoningBudget: false
};

export function resolveModelMetadata(modelId: string): ModelMetadata {
  if (!modelId) return DEFAULT_FALLBACK_METADATA;
  const normalized = modelId.toLowerCase().trim();

  // Exact match
  if (KNOWN_MODELS_CATALOG[normalized]) {
    return KNOWN_MODELS_CATALOG[normalized];
  }

  // Prefix match
  for (const [key, meta] of Object.entries(KNOWN_MODELS_CATALOG)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { ...meta, id: modelId };
    }
  }

  return { ...DEFAULT_FALLBACK_METADATA, id: modelId, name: modelId };
}

/**
 * Table lookup for *budget* decisions: returns a catalog row only when the model
 * id really names it, and `null` otherwise so the caller can fall back to the
 * pattern guesses in `./modelCapabilities.ts`.
 *
 * This is deliberately stricter than `resolveModelMetadata`, whose fuzzy
 * substring rule is fine for a pricing display and dangerous for a context
 * window: `gemini-2.5-flash-lite` contains `gemini-2.5-flash`, and inheriting
 * that row's 1,048,576-token window would oversize a 1M request by ~5% and make
 * the provider reject it. Over there, an approximate number is a nicer label;
 * over here it is an overflow.
 *
 * Accepted forms of a hit, in order:
 * 1. exact id, lowercased/trimmed;
 * 2. the id with its leading gateway namespace segment removed
 *    (`google/gemini-2.5-flash`, `openai/gpt-4o`, `x-ai/grok-3`);
 * 3. the same, after dropping a REST path prefix (`models/gemini-2.5-flash`).
 * Anything else — dated variants, version suffixes, unknown families — is a
 * miss, which is the safe answer: the fallback tables are more conservative.
 */
/** Gateway namespaces that name a vendor unambiguously. */
const NAMESPACE_PROVIDERS: Record<string, ModelMetadata['provider']> = {
  google: 'gemini',
  gemini: 'gemini',
  openai: 'openai',
  groq: 'groq'
};

/** A row only sizes a request for the provider that publishes that window. */
function providerMatches(row: ModelMetadata, rawId: string, provider?: string): boolean {
  if (!provider || provider === 'custom' || provider === row.provider) return true;
  const namespace = rawId.includes('/') ? rawId.split('/')[0]! : '';
  return NAMESPACE_PROVIDERS[namespace] === row.provider;
}

export function lookupModelMetadata(modelId: string, provider?: string): ModelMetadata | null {
  const raw = (modelId || '').toLowerCase().trim();
  if (!raw) return null;

  const candidates: string[] = [raw];
  const withoutPath = raw.replace(/^(?:models|cachedcontents)\//i, '');
  if (withoutPath !== raw) candidates.push(withoutPath);

  const segments = withoutPath.split('/');
  if (segments.length > 1) {
    // Namespace first, id last: `anthropic/vertex/claude-…` style routing.
    candidates.push(segments[segments.length - 1]);
    candidates.push(segments.slice(1).join('/'));
  }

  for (const candidate of candidates) {
    const row = KNOWN_MODELS_CATALOG[candidate];
    if (row && providerMatches(row, raw, provider)) return row;
  }
  return null;
}
