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
    contextWindow: 2_097_152,
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
