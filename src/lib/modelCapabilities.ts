import type { ProviderId } from './providers';

/**
 * Model capability registry.
 *
 * Void keeps a static table (reference/void-main/.../common/modelCapabilities.ts)
 * plus a name-based fallback matcher for models the table does not know. The
 * table is keyed by recognizable name patterns instead of exact IDs, so new
 * model releases work without a code change.
 */

export interface ModelCapabilities {
  /** Prompt tokens the model accepts. */
  contextWindow: number;
}

interface CapabilityPattern {
  /** Case-insensitive regex tested against the full model id. */
  pattern: RegExp;
  contextWindow: number;
}

const GEMINI_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /ultra|pro|argon/, contextWindow: 2_000_000 },
  { pattern: /flash-lite/, contextWindow: 1_000_000 },
  { pattern: /flash|thinking/, contextWindow: 1_048_576 },
  { pattern: /gemini/, contextWindow: 131_072 }
];

const GROQ_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /120b|70b|72b|90b|132b|235b|100b/, contextWindow: 131_072 },
  { pattern: /32b|40b|54b/, contextWindow: 131_072 },
  { pattern: /20b|27b|30b|17b|12b/, contextWindow: 131_072 },
  { pattern: /8b|9b|11b|14b/, contextWindow: 131_072 },
  { pattern: /llama-4|qwen3|kimi|deepseek/, contextWindow: 131_072 },
  { pattern: /./, contextWindow: 32_768 }
];

/**
 * A custom endpoint can serve any model in existence, and most gateways do not
 * report a context window, so this matches the families people actually point
 * ShadRox at. Anything unknown keeps the conservative default: guessing too
 * high overflows the real window, guessing too low only trims history.
 */
const CUSTOM_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /gemini.*(?:flash|thinking)/, contextWindow: 1_000_000 },
  { pattern: /gemini/, contextWindow: 131_072 },
  { pattern: /claude|anthropic/, contextWindow: 200_000 },
  { pattern: /gpt-4o|gpt-4\.1|o3|o4|chatgpt-|gpt-5/, contextWindow: 128_000 },
  { pattern: /gpt-4-turbo|gpt-4-0613|gpt-4-32k/, contextWindow: 32_768 },
  { pattern: /gpt-3\.5/, contextWindow: 16_385 },
  { pattern: /deepseek-r1|deepseek-reasoner/, contextWindow: 64_000 },
  { pattern: /deepseek/, contextWindow: 128_000 },
  { pattern: /qwen3|qwen2\.5|qwq/, contextWindow: 131_072 },
  { pattern: /llama-3\.1|llama-3\.2|llama-4/, contextWindow: 131_072 },
  { pattern: /mistral-large|mistral-small|devstral|mistral-nemo/, contextWindow: 131_072 },
  { pattern: /kimi|moonshot/, contextWindow: 131_072 },
  { pattern: /grok/, contextWindow: 131_072 },
  { pattern: /minimax|glm|kimi/, contextWindow: 131_072 }
];

const CAPABILITIES: Record<ProviderId, CapabilityPattern[]> = {
  gemini: GEMINI_CAPABILITIES,
  groq: GROQ_CAPABILITIES,
  custom: CUSTOM_CAPABILITIES
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

/** Best-effort context window for a model id, first match wins. */
export function resolveContextWindow(provider: ProviderId, modelId: string): number {
  const id = modelId.toLowerCase();
  const table = CAPABILITIES[provider] ?? [];
  for (const entry of table) {
    if (entry.pattern.test(id)) return entry.contextWindow;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export { DEFAULT_CONTEXT_WINDOW };
