import type { ProviderId } from './providers';
import { lookupModelMetadata } from './modelMetadata';

/**
 * Model capability registry.
 *
 * Void keeps a static table (reference/void-main/.../common/modelCapabilities.ts)
 * plus a name-based fallback matcher for models the table does not know. The
 * table is keyed by recognizable name patterns instead of exact IDs, so new
 * model releases work without a code change.
 *
 * Resolution order — an order, not a vote:
 * 1. the exact-id metadata table in `./modelMetadata.ts` (Cline-derived,
 *    Apache-2.0): the only source here that is a published per-model number
 *    rather than a regex guess;
 * 2. the pattern tables below, for models the metadata table does not list;
 * 3. the conservative defaults.
 * A model absent from (1) therefore behaves exactly as it did before (1) was
 * wired in, so a missing row cannot crash or oversize a request.
 */

export interface ModelCapabilities {
  /** Prompt tokens the model accepts. */
  contextWindow: number;
  /**
   * Maximum tokens the model can emit in a single response.
   * When present, `contextBudget` uses this instead of the
   * "half the window" heuristic so the input budget is not
   * needlessly shrunk for models that actually cap output well
   * below contextWindow / 2.
   */
  maxOutput?: number;
  /** Which source produced the numbers, so a caller can log the precedence honestly. */
  source?: 'metadata_table' | 'pattern_table' | 'default';
  /**
   * Whether the model can call tools. `undefined` means unverified, not `false`
   * — a route that requires it must treat unknown as "not usable" (fail closed).
   */
  toolCalls?: boolean;
  /** Whether the model supports structured/JSON responses. `undefined` is unverified. */
  structuredResponses?: boolean;
  /** Whether the provider offers prompt caching for this model. `undefined` is unverified. */
  cacheEligible?: boolean;
}

interface CapabilityPattern {
  /** Case-insensitive regex tested against the full model id. */
  pattern: RegExp;
  contextWindow: number;
  maxOutput?: number;
}

const GEMINI_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /ultra|pro|argon/, contextWindow: 2_000_000, maxOutput: 8_192 },
  { pattern: /flash-lite/,      contextWindow: 1_000_000, maxOutput: 8_192 },
  { pattern: /flash|thinking/,  contextWindow: 1_048_576, maxOutput: 8_192 },
  { pattern: /gemini/,          contextWindow: 131_072,   maxOutput: 8_192 },
];

const GROQ_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /120b|70b|72b|90b|132b|235b|100b/, contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /32b|40b|54b/,                      contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /20b|27b|30b|17b|12b/,              contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /8b|9b|11b|14b/,                    contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /llama-4|qwen3|kimi|deepseek/,       contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /./,                                 contextWindow: 32_768,  maxOutput: 4_096 },
];

/**
 * A custom endpoint can serve any model in existence, and most gateways do not
 * report a context window, so this matches the families people actually point
 * ShadRox at. Anything unknown keeps the conservative default: guessing too
 * high overflows the real window, guessing too low only trims history.
 */
const CUSTOM_CAPABILITIES: CapabilityPattern[] = [
  { pattern: /gemini.*(?:flash|thinking)/, contextWindow: 1_000_000, maxOutput: 8_192 },
  { pattern: /gemini/,                     contextWindow: 131_072,   maxOutput: 8_192 },
  { pattern: /claude|anthropic/,           contextWindow: 200_000,   maxOutput: 8_096 },
  { pattern: /gpt-4o|gpt-4\.1|o3|o4|chatgpt-|gpt-5/, contextWindow: 128_000, maxOutput: 16_384 },
  { pattern: /gpt-4-turbo|gpt-4-0613|gpt-4-32k/,     contextWindow: 32_768,  maxOutput: 4_096 },
  { pattern: /gpt-3\.5/,                  contextWindow: 16_385,    maxOutput: 4_096 },
  { pattern: /deepseek-r1|deepseek-reasoner/, contextWindow: 64_000, maxOutput: 8_192 },
  { pattern: /deepseek/,                  contextWindow: 128_000,   maxOutput: 8_192 },
  { pattern: /qwen3|qwen2\.5|qwq/,        contextWindow: 131_072,   maxOutput: 8_192 },
  { pattern: /llama-3\.1|llama-3\.2|llama-4/, contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /mistral-large|mistral-small|devstral|mistral-nemo/, contextWindow: 131_072, maxOutput: 8_192 },
  { pattern: /kimi|moonshot/,             contextWindow: 131_072,   maxOutput: 8_192 },
  { pattern: /grok/,                      contextWindow: 131_072,   maxOutput: 8_192 },
  { pattern: /minimax|glm/,               contextWindow: 131_072,   maxOutput: 8_192 },
];

const CAPABILITIES: Record<ProviderId, CapabilityPattern[]> = {
  gemini: GEMINI_CAPABILITIES,
  groq: GROQ_CAPABILITIES,
  custom: CUSTOM_CAPABILITIES
};

const DEFAULT_CONTEXT_WINDOW = 32_000;
/** Conservative output cap used when the model is not in any table. */
const DEFAULT_MAX_OUTPUT = 4_096;

/**
 * The table in `./modelMetadata.ts`, in this module's shape. A row is a
 * published per-model number, so it always wins over the pattern guesses —
 * including for `provider: 'custom'`, where the id is the same model reached
 * through a gateway, and for Groq/OpenRouter-namespaced ids
 * (`openai/gpt-4o` is still GPT-4o's window).
 */
function metadataCapabilities(provider: ProviderId, modelId: string): ModelCapabilities | null {
  const row = lookupModelMetadata(modelId, provider);
  if (!row) return null;
  return {
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutputTokens,
    source: 'metadata_table'
  };
}

/** Best-effort context window for a model id, first match wins. */
export function resolveContextWindow(provider: ProviderId, modelId: string): number {
  return resolveCapabilities(provider, modelId).contextWindow;
}

/**
 * Full capability record for a model — contextWindow plus the per-model
 * maxOutput ceiling. Use this instead of `resolveContextWindow` when you
 * also need to size the output reservation accurately.
 *
 * Metadata table first, then the per-provider pattern tables, then the
 * defaults; see the header for why that order is the safe one.
 */
export function resolveCapabilities(provider: ProviderId, modelId: string): ModelCapabilities {
  const fromTable = metadataCapabilities(provider, modelId);
  if (fromTable) return fromTable;

  const id = modelId.toLowerCase();
  const table = CAPABILITIES[provider] ?? [];
  for (const entry of table) {
    if (entry.pattern.test(id)) {
      return {
        contextWindow: entry.contextWindow,
        ...(entry.maxOutput !== undefined ? { maxOutput: entry.maxOutput } : {}),
        source: 'pattern_table'
      };
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/**
 * The one budget resolver every caller should use: it returns the numbers plus
 * where they came from, so `api/ai/_budget.ts` and the renderer provably share
 * a single precedence instead of each re-implementing a lookup.
 */
export function resolveBudgetCapabilities(provider: ProviderId, modelId: string): ModelCapabilities {
  return resolveCapabilities(provider, modelId);
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT };

/** The features a request needs before a route may be used for it. */
export interface RequiredCapabilities {
  toolCalls?: boolean;
  structuredResponses?: boolean;
  cacheEligible?: boolean;
  /** The payload's input budget must fit inside this window. */
  minContextWindow?: number;
}

export interface CapabilityCheck {
  /** True only when every requirement is met by a verified `true`. */
  satisfied: boolean;
  /** Requirements the model explicitly lacks. */
  missing: string[];
  /** Requirements no registry entry proves either way — treated as unmet. */
  unknown: string[];
}

/**
 * Whether a model may serve a request that requires certain features. Unknown
 * capability fails closed: `undefined` is not proof the feature exists, so a
 * route that needs it is refused rather than silently degraded (plan.md S07).
 */
export function checkCapabilities(caps: ModelCapabilities, required: RequiredCapabilities): CapabilityCheck {
  const missing: string[] = [];
  const unknown: string[] = [];
  const flag = (name: keyof RequiredCapabilities, want: boolean | undefined, have: boolean | undefined): void => {
    if (!want) return;
    if (have === undefined) unknown.push(name);
    else if (!have) missing.push(name);
  };
  flag('toolCalls', required.toolCalls, caps.toolCalls);
  flag('structuredResponses', required.structuredResponses, caps.structuredResponses);
  flag('cacheEligible', required.cacheEligible, caps.cacheEligible);
  if (required.minContextWindow !== undefined && caps.contextWindow < required.minContextWindow) {
    missing.push('contextWindow');
  }
  return { satisfied: missing.length === 0 && unknown.length === 0, missing, unknown };
}

/**
 * Whether a route or fallback change invalidates the earlier fit: a different
 * context window or output ceiling means the payload must be refitted.
 */
export function routeNeedsRefit(before: ModelCapabilities, after: ModelCapabilities): boolean {
  return before.contextWindow !== after.contextWindow || before.maxOutput !== after.maxOutput;
}
