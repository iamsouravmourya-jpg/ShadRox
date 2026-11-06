import { costRupees, type TokenSplit } from './modelRates';
import { RUPEES_PER_CREDIT } from './plans';

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache tokens already included in inputTokens. */
  cachedTokens?: number;
}

/**
 * What one real turn cost, from the token split the provider reported.
 *
 * Returns null whenever the split is unknown. A guessed charge would silently
 * drift the credit balance, and the balance is the one number the operator has
 * to trust.
 */
export function creditsForTurn(modelId: string, usage: TurnUsage): number | null {
  const { inputTokens, outputTokens } = usage;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  if ((inputTokens as number) < 0 || (outputTokens as number) < 0) return null;

  const tokens: TokenSplit = { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
  const rupees = costRupees(modelId, tokens);
  if (rupees <= 0) return 0;
  return Math.ceil((rupees / RUPEES_PER_CREDIT) * 10) / 10;
}

/** A credit figure small enough to read as a fraction should not read as 0. */
export function formatCredits(credits: number | null): string {
  if (credits === null) return '—';
  if (credits === 0) return '0';
  if (credits < 0.1) return credits.toFixed(2);
  return credits.toFixed(1);
}

/**
 * The split to show in the footer. A provider that reported only a total gets
 * the total alone, so the UI never has to guess which half is which.
 */
export function formatTokenSplit(usage: TurnUsage, totalTokens: number): string {
  const cached = usage.cachedTokens && usage.cachedTokens > 0 ? ` · ${usage.cachedTokens} cached` : '';
  if (Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
    return `${usage.inputTokens} in / ${usage.outputTokens} out${cached}`;
  }
  return `${totalTokens} tok${cached}`;
}
