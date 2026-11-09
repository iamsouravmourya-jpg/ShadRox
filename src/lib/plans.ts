import type { PlanTier } from './types';

export interface PlanMeta {
  id: PlanTier;
  label: string;
  price: string;
  gstNote: string;
  creditsPerMonth: number;
  blurb: string;
  perks: string[];
  popular?: boolean;
}

/**
 * One credit is the ceiling on what ShadRox may pay upstream for it, landed in
 * India (catalogue USD x the ₹/$ rate in modelRates, which includes GST). The
 * ₹699 pack's 800 credits therefore cannot cost more than ₹280 to serve, and
 * that ceiling is what leaves the margin at the price the pack is sold at.
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

/**
 * - Free (BYOK): all three options — Gemini, Groq and any custom
 *   OpenAI-compatible endpoint — unlimited and ₹0 forever. Nothing is gated.
 * - Starter: ₹699 including GST — 800 credits / month (₹280 COGS ceiling).
 * - Heavy: ₹1,299 including GST — 1,600 credits / month (₹560 COGS ceiling).
 *
 * Two packs, not a ladder: one for a student doing small-to-medium edits, one
 * for a freelancer running agent loops and repo indexing all day. Both are
 * priced so the worst-case month still leaves ₹296 / ₹510 after GST and the
 * payment gateway, and the free BYOK route stays the escape hatch for anyone
 * who would rather pay their provider.
 */
export const PLANS: PlanMeta[] = [
  {
    id: 'free',
    label: 'Free (BYOK)',
    price: '₹0',
    gstNote: 'No tax — you pay the model provider directly',
    creditsPerMonth: Infinity,
    blurb: 'Bring your own key. Gemini, Groq and any custom endpoint, all unlimited, ₹0 from ShadRox — forever.',
    perks: [
      'Unlimited messages — no cap on any BYOK option',
      'Gemini free and unlimited',
      'Groq free and unlimited',
      'Custom OpenAI-compatible endpoints (OpenRouter, Together, OpenAI, your own server, Ollama, LM Studio) free and unlimited',
      'Every editor feature: patches to disk, preview, checkpoints, terminal, no watermark or trial clock'
    ]
  },
  {
    id: 'starter',
    label: 'Starter Pack',
    price: '₹699',
    gstNote: 'GST included — ₹699 is the full amount',
    creditsPerMonth: 800,
    blurb: 'The zero-setup pack: ShadRox pays the provider, routes each task to the cheapest model that can do it, and meters real tokens against 800 credits.',
    popular: true,
    perks: [
      'No API key to buy, validate or top up — the shared key is wired in',
      'Reader model (Nova Micro) picks the context, GLM 4.7 Flash writes the patch, DeepSeek V4.1 Flash takes the hard refactors',
      '800 credits a month — about 800 file edits, ~4,000 chat turns, or ~10,000 Tab completions',
      'GST included in ₹699; failed and rolled-back requests are never billed',
      'Free BYOK stays unlimited — your own key is never metered or capped',
      'Priority streaming and automated multi-file patching'
    ]
  },
  {
    id: 'heavy',
    label: 'Heavy Pack',
    price: '₹1,299',
    gstNote: 'GST included — ₹1,299 is the full amount',
    creditsPerMonth: 1600,
    blurb: 'For all-day agent work: twice the credits, a continuously indexed workspace, and room for long multi-file runs without watching the meter.',
    perks: [
      '1,600 credits a month — about 1,600 file edits, ~8,000 chat turns, or ~20,000 Tab completions',
      'Continuous codebase indexing so large-context requests stay on the 1M-token coder model',
      'Bigger autonomous budgets: team runs and multi-step plans can reserve more before they stop',
      'Same zero-setup key and routing as Starter — no API key to buy, top up or validate',
      'GST included in ₹1,299; failed and rolled-back requests are never billed',
      'Free BYOK stays unlimited — your own key is never metered or capped'
    ]
  }
];

export const DEFAULT_PLAN: PlanTier = 'free';

/**
 * Beta-phase unlock list: the paid packs the developer has opened for selection.
 * Free is always selectable; every other tier needs a name in this array. Empty
 * it to lock the whole ladder.
 */
// Paid plans and the shared-key path are intentionally unavailable to beta
// testers. The catalogue prices remain visible for the future launch window.
export const BETA_UNLOCKED_PLANS: PlanTier[] = [];

export function isPlanSelectable(plan: PlanTier): boolean {
  return plan === 'free' || BETA_UNLOCKED_PLANS.includes(plan);
}

/** Tiers still withheld, so the UI only says "locked" when something really is. */
export function getLockedPlanIds(): PlanTier[] {
  return PLANS.map((entry) => entry.id).filter((id) => !isPlanSelectable(id));
}

/**
 * What the UI may honestly claim a plan gives you, in one line.
 *
 * Credits buy the shared-key path, and that path only runs when the operator
 * enables it server-side (api/ai/_access.ts: SHADROX_ALLOW_SHARED_KEY=1 plus the
 * provider key in that process). quota.ts meters by plan, not by key, so the
 * local counter moves even when the user's own key answered — say all of that
 * instead of advertising server-run AI this build cannot deliver.
 */
export function getPlanEntitlementNote(plan: PlanTier, sharedKeyEligible: boolean): string {
  const meta = getPlanMeta(plan);
  if (!Number.isFinite(meta.creditsPerMonth)) {
    return 'Nothing is metered on this plan — your own key pays the provider, so ShadRox bills no credits.';
  }
  const allotment = `${meta.creditsPerMonth.toLocaleString('en-IN')} credits a month`;
  const meter =
    'Turns carried by your own key are neither counted nor capped — the meter and the cap apply only to requests that run on the ShadRox shared key.';
  return sharedKeyEligible
    ? `${allotment} pay for requests run on the ShadRox shared key. That key answers only while the operator has it enabled on the server; on a plain beta install your own BYOK key still carries every request. ${meter}`
    : `${allotment} pay for requests run on the ShadRox shared key, and this beta does not open that path for ${meta.label}. ${meter}`;
}

/**
 * No payment integration exists in this repo, so a plan switch is an entitlement
 * flip on this device only. Every upgrade control has to admit that.
 */
export const BETA_UPGRADE_NOTE =
  'Beta tester lock: ₹699 Starter and ₹1,299 Heavy are catalogue prices only. No checkout or shared-key access is available in this beta; prices may change before launch.';

/**
 * What the plan card may put where a price goes. The pack's real price is the
 * headline, because that is the number the business runs on; the note says
 * outright that this build cannot charge it yet, so ₹699 never reads as a
 * checkout that does not exist.
 */
export function getPlanPriceDisplay(plan: PlanTier): { headline: string; note: string } {
  const meta = getPlanMeta(plan);
  if (!Number.isFinite(meta.creditsPerMonth)) {
    return { headline: meta.price, note: meta.gstNote };
  }
  return {
    headline: meta.price,
    note: `${meta.gstNote} · no checkout in this beta`
  };
}

/** One honest word for a tier's state, used as the card badge. */
export function getPlanStateLabel(plan: PlanTier): string {
  if (!Number.isFinite(getPlanMeta(plan).creditsPerMonth)) return 'Free forever';
  return isPlanSelectable(plan) ? 'Available in beta' : 'Locked during beta';
}

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}

export function creditsToRupees(credits: number): number {
  return credits * RUPEES_PER_CREDIT;
}
