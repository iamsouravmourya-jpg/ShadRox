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
 * One credit is what ShadRox pays upstream for the cheapest useful call, in
 * rupees. Every multiplier below is expressed against that unit, so the credit
 * ladder is really a spend ladder: worst-case COGS = credits x this number.
 */
export const RUPEES_PER_CREDIT = 0.24;

export const CREDIT_RATES = {
  /** Question, explanation, plan-mode reply — no file touched. */
  chatter: 0.4,
  /** Assistant wrote or patched a file with the fast-tier model. */
  codeEdit: 1,
  /** Escalated to a premium model for a refactor; billed only when it applies. */
  premiumRefactor: 6,
  /** One accepted ghost-text completion. */
  tabCompletion: 0.1
} as const;

export type CreditRate = keyof typeof CREDIT_RATES;

/**
 * - Free (BYOK): all three options — Gemini, Groq and any custom
 *   OpenAI-compatible endpoint — unlimited and ₹0 forever. Nothing is gated.
 * - Starter: ₹399 + GST — 800 credits / month.
 * - Pro: ₹999 + GST — 2,200 credits / month (cheaper per credit than Starter).
 *
 * Paid tiers buy convenience, not access the free tier withholds: no key to
 * fetch, routing that picks the model per task, and heavier context.
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
    label: 'Starter',
    price: '₹399 + GST',
    gstNote: '₹399 plus GST — shown in full before you pay',
    creditsPerMonth: 800,
    blurb: 'Skip the API-key choreography: ShadRox pays the provider and routes each task to a model that fits it.',
    popular: true,
    perks: [
      'No API key to buy, validate or top up — the shared key is wired in',
      'Auto routing: chat gets a cheap fast model, code edits get a capable one, you choose nothing',
      '800 credits a month — roughly 800 applied file edits, or ~2,000 chat-and-explain turns',
      'One pooled budget: chat, edits and Tab completions all draw from the same 800',
      'Failed and rolled-back requests are never billed',
      'Priority streaming and automated multi-file patching'
    ]
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '₹999 + GST',
    gstNote: '₹999 plus GST — shown in full before you pay',
    creditsPerMonth: 2200,
    blurb: 'Same zero-setup key, bigger budget and the heavy-context features for real codebases.',
    perks: [
      '2,200 credits a month at a cheaper per-credit rate than Starter',
      'Premium models for hard refactors, not just the fast tier',
      'Extended context window with semantic retrieval across the workspace',
      'Full checkpoint timeline — restore any applied change set instantly',
      'Everything in Starter: no API key, auto routing, unbilled failures',
      'Priority streaming and automated multi-file patching'
    ]
  }
];

export const DEFAULT_PLAN: PlanTier = 'free';

/**
 * Beta-phase unlock list: the paid tiers the developer has opened for selection.
 * Free is always selectable; every other tier needs a name in this array. Empty
 * it to lock the whole ladder, add 'pro' to open Pro too.
 */
export const BETA_UNLOCKED_PLANS: PlanTier[] = ['starter'];

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
    'The counter on this device moves for any paid plan, even when your own key ran the request, and the server does not enforce it yet.';
  return sharedKeyEligible
    ? `${allotment} pay for requests run on the ShadRox shared key. That key answers only while the operator has it enabled on the server; on a plain beta install your own BYOK key still carries every request. ${meter}`
    : `${allotment} pay for requests run on the ShadRox shared key, and this beta does not open that path for ${meta.label}. ${meter}`;
}

/**
 * No payment integration exists in this repo, so a plan switch is an entitlement
 * flip on this device only. Every upgrade control has to admit that.
 */
export const BETA_UPGRADE_NOTE =
  'Beta: nothing is charged and no payment is taken yet — this only flips your plan on this device.';

/**
 * What the plan card may put where a price goes. No payment integration exists
 * in this repo, so a paid tier is listed at ₹0 today and the catalogue price is
 * shown only as a label, never as something that can be bought.
 */
export function getPlanPriceDisplay(plan: PlanTier): { headline: string; note: string } {
  const meta = getPlanMeta(plan);
  if (!Number.isFinite(meta.creditsPerMonth)) {
    return { headline: meta.price, note: meta.gstNote };
  }
  return {
    headline: '₹0 during beta',
    note: `Listed at ${meta.price} — no payment is integrated in this build.`
  };
}

/** One honest word for a tier's state, used as the card badge. */
export function getPlanStateLabel(plan: PlanTier): string {
  if (!Number.isFinite(getPlanMeta(plan).creditsPerMonth)) return 'Free forever';
  return isPlanSelectable(plan) ? 'Beta — all features unlocked' : 'Locked during beta';
}

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}

export function creditsToRupees(credits: number): number {
  return credits * RUPEES_PER_CREDIT;
}
