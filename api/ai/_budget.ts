import {
  CHARS_PER_TOKEN,
  MAX_SYSTEM_INSTRUCTION_CHARS,
  MIN_BUDGET_CHARS,
  capSystemInstruction,
  estimateTokens,
  messageBudgetChars,
  trimMessagesToBudget,
  type BudgetedMessage
} from '../../src/lib/contextBudget.js';
import { DEFAULT_MAX_OUTPUT, resolveBudgetCapabilities } from '../../src/lib/modelCapabilities.js';
import type { ProviderId } from './_types.js';

export interface BudgetedRequest {
  messages: BudgetedMessage[];
  systemInstruction?: string;
  /** Messages the trimmer shortened. */
  trimmed: number;
  trimmedChars: number;
  /**
   * Which table sized this request: the exact-id metadata table
   * (`src/lib/modelMetadata.ts`), the per-provider pattern guesses, or the
   * default. Surfaced so a wrong context window is visible instead of showing
   * up as an opaque provider error.
   */
  capabilitySource: 'metadata_table' | 'pattern_table' | 'default';
  /** Resolved per-response output ceiling, with the conservative default applied. */
  maxOutput: number;
  /** Serialized tool-schema/framing characters reserved outside the message array. */
  framingChars: number;
}

/**
 * Puts the whole request inside the model's context window.
 *
 * `trimMessagesToBudget()` only counts the message array, and
 * `capSystemInstruction()` only knows a global 80k-char ceiling — but the
 * system instruction is billed against the same window as the history, and the
 * helper that reserves half the window for the output never sees it. The result
 * was an over-window request that came back as an opaque provider error.
 *
 * The fix is arithmetic, not a new rule: cap the instruction to what this model
 * can actually carry, then subtract its estimated tokens from the window before
 * the history is trimmed. `src/lib/*` stays untouched (another agent owns it).
 *
 * Window and output ceiling come from `resolveBudgetCapabilities()`, i.e. the
 * published per-model rows in `src/lib/modelMetadata.ts` first and the regex
 * guesses in `src/lib/modelCapabilities.ts` only for a model the table does not
 * list — the same precedence the renderer uses, so client and server cannot
 * disagree about how big the window is.
 *
 * `framingChars` (optional, additive) is the serialized size of everything the
 * request carries OUTSIDE the message array and the system instruction — tool
 * schemas, role/JSON framing, resume wrappers. It is reserved against the same
 * window so the total serialized request, not just the history, fits.
 */
export function budgetRequest(
  provider: ProviderId,
  model: string,
  messages: BudgetedMessage[],
  rawSystemInstruction?: string,
  framingChars = 0
): BudgetedRequest {
  const capabilities = resolveBudgetCapabilities(provider, model);
  const contextWindow = capabilities.contextWindow;
  const maxOutput = capabilities.maxOutput;
  const capabilitySource = capabilities.source ?? 'default';
  const reservedFramingChars = Number.isFinite(framingChars) ? Math.max(0, Math.floor(framingChars)) : 0;
  const framingTokens = Math.ceil(reservedFramingChars / CHARS_PER_TOKEN);
  // messageBudgetChars() is the input budget in characters: the window minus the
  // output reservation. Cap the instruction to a share of that so the history
  // still gets room, and never above the global ceiling. Tool schemas and
  // framing compete for the same input room, so they shrink the share too.
  const inputBudgetChars = Math.max(
    MIN_BUDGET_CHARS,
    messageBudgetChars(contextWindow, maxOutput) - reservedFramingChars
  );
  const systemCap = Math.min(
    MAX_SYSTEM_INSTRUCTION_CHARS,
    Math.max(MIN_BUDGET_CHARS, Math.floor(inputBudgetChars * 0.6))
  );

  const systemInstruction = rawSystemInstruction
    ? capSystemInstruction(rawSystemInstruction, systemCap)
    : undefined;

  const systemTokens = systemInstruction ? estimateTokens(systemInstruction) : 0;
  const effectiveWindow = Math.max(1_000, contextWindow - systemTokens - framingTokens);
  const trimmed = trimMessagesToBudget(messages, effectiveWindow, maxOutput);

  return {
    messages: trimmed.messages,
    systemInstruction,
    trimmed: trimmed.trimmed,
    trimmedChars: trimmed.trimmedChars,
    capabilitySource,
    maxOutput: maxOutput ?? DEFAULT_MAX_OUTPUT,
    framingChars: reservedFramingChars
  };
}
