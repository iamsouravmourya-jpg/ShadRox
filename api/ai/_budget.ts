import {
  MAX_SYSTEM_INSTRUCTION_CHARS,
  MIN_BUDGET_CHARS,
  capSystemInstruction,
  estimateTokens,
  messageBudgetChars,
  trimMessagesToBudget,
  type BudgetedMessage
} from '../../src/lib/contextBudget.js';
import { resolveContextWindow } from '../../src/lib/modelCapabilities.js';
import type { ProviderId } from './_types.js';

export interface BudgetedRequest {
  messages: BudgetedMessage[];
  systemInstruction?: string;
  /** Messages the trimmer shortened. */
  trimmed: number;
  trimmedChars: number;
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
 */
export function budgetRequest(
  provider: ProviderId,
  model: string,
  messages: BudgetedMessage[],
  rawSystemInstruction?: string
): BudgetedRequest {
  const contextWindow = resolveContextWindow(provider, model);
  // messageBudgetChars() is the input budget in characters: the window minus the
  // output reservation. Cap the instruction to a share of that so the history
  // still gets room, and never above the global ceiling.
  const inputBudgetChars = messageBudgetChars(contextWindow);
  const systemCap = Math.min(
    MAX_SYSTEM_INSTRUCTION_CHARS,
    Math.max(MIN_BUDGET_CHARS, Math.floor(inputBudgetChars * 0.6))
  );

  const systemInstruction = rawSystemInstruction
    ? capSystemInstruction(rawSystemInstruction, systemCap)
    : undefined;

  const systemTokens = systemInstruction ? estimateTokens(systemInstruction) : 0;
  const effectiveWindow = Math.max(1_000, contextWindow - systemTokens);
  const trimmed = trimMessagesToBudget(messages, effectiveWindow);

  return {
    messages: trimmed.messages,
    systemInstruction,
    trimmed: trimmed.trimmed,
    trimmedChars: trimmed.trimmedChars
  };
}
