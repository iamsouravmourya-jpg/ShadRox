/**
 * Token budgeting and context pruning.
 *
 * Ported from Void's weighted message trimmer
 * (reference/void-main/src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts)
 * and stripped of every VS Code dependency. Void's rules:
 *
 * - No real tokenizer: CHARS_PER_TOKEN = 4.
 * - Half the context window is reserved for the model's output.
 * - Every message gets a trim weight; the greedy loop cuts the heaviest
 *   message down to TRIM_TO_LEN chars (plus "...") until the budget fits.
 * - Assistant/tool history is trimmed first (×10), system last (×0.01),
 *   and the first + last messages are treated as nearly untouchable (×0.05).
 * - Older messages weigh more than newer ones (index ramp 2 → 1).
 */

export const CHARS_PER_TOKEN = 4;
export const TRIM_TO_LEN = 120;
export const MAX_TRIM_ITERATIONS = 100;
export const MIN_BUDGET_CHARS = 5_000;
export const RESERVED_OUTPUT_FLOOR_TOKENS = 4_096;
export const MAX_SYSTEM_INSTRUCTION_CHARS = 80_000;

export interface BudgetedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TrimResult {
  messages: BudgetedMessage[];
  /** Messages shortened by the trimmer. */
  trimmed: number;
  /** Characters dropped in total. */
  trimmedChars: number;
}

/** Rough token count, matching Void's chars/4 heuristic. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens kept aside so the model always has room to answer. */
export function reservedOutputTokens(contextWindow: number): number {
  return Math.max(Math.floor(contextWindow / 2), RESERVED_OUTPUT_FLOOR_TOKENS);
}

/** Maximum characters the request (messages) may occupy for a given model. */
export function messageBudgetChars(contextWindow: number): number {
  const reserved = reservedOutputTokens(contextWindow);
  return Math.max((contextWindow - reserved) * CHARS_PER_TOKEN, MIN_BUDGET_CHARS);
}

const ROLE_MULTIPLIER: Record<BudgetedMessage['role'], number> = {
  system: 0.01,
  user: 1,
  assistant: 10
};

/** Older messages are cheaper to lose than recent ones. */
function indexMultiplier(index: number, count: number): number {
  if (count <= 1) return 1;
  return 2 - index / (count - 1);
}

/**
 * Trims message history into the model's budget using Void's weighted greedy
 * algorithm. Returns a new array; the input is never mutated.
 */
export function trimMessagesToBudget(
  messages: BudgetedMessage[],
  contextWindow: number
): TrimResult {
  const budget = messageBudgetChars(contextWindow);
  const result = messages.map((message) => ({ ...message }));
  let total = result.reduce((sum, message) => sum + message.content.length, 0);
  let trimmed = 0;
  let trimmedChars = 0;
  let iterations = 0;

  while (total > budget && iterations < MAX_TRIM_ITERATIONS) {
    iterations += 1;

    let victim = -1;
    let victimWeight = -1;
    const last = result.length - 1;

    result.forEach((message, index) => {
      if (message.content.length <= TRIM_TO_LEN) return;

      const edgeMultiplier = index === 0 || index === last ? 0.05 : 1;
      const weight =
        message.content.length *
        ROLE_MULTIPLIER[message.role] *
        indexMultiplier(index, result.length) *
        edgeMultiplier;

      if (weight > victimWeight) {
        victimWeight = weight;
        victim = index;
      }
    });

    if (victim === -1) break;

    const message = result[victim];
    trimmedChars += message.content.length - TRIM_TO_LEN;
    message.content = `${message.content.slice(0, TRIM_TO_LEN)}...`;
    trimmed += 1;
    total = result.reduce((sum, entry) => sum + entry.content.length, 0);
  }

  return { messages: result, trimmed, trimmedChars };
}

/** Hard cap for the system instruction so a huge context dump cannot crowd out the reply. */
export function capSystemInstruction(text: string, maxChars = MAX_SYSTEM_INSTRUCTION_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n… [system context trimmed, ${text.length} chars total] …\n\n`;
  const headChars = Math.floor((maxChars - marker.length) * 0.6);
  const tailChars = maxChars - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}
