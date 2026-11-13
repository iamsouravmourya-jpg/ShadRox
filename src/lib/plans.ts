/**
 * Internal cost arithmetic, not a currency the app sells.
 *
 * A "credit" is one unit of upstream model spend, priced at the ceiling below.
 * It exists so an autonomous run can estimate work and stop at a budget. No
 * balance is stored, metered or displayed anywhere, and nothing is purchased
 * with it — every request runs on the user's own provider key.
 */
export const RUPEES_PER_CREDIT = 0.35;

export const CREDIT_RATES = {
  /** Question, explanation, plan-mode reply on the reader model. */
  chatter: 0.2,
  /** Assistant wrote or patched a file on the coder model. */
  codeEdit: 1.2,
  /** Escalated to the refactor model; billed only when it applies. */
  premiumRefactor: 3,
  /** One accepted ghost-text completion. */
  tabCompletion: 0.06
} as const;

export type CreditRate = keyof typeof CREDIT_RATES;
