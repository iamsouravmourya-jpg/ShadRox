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

/** Beta-phase switch: paid tiers are visible but cannot be selected yet. */
export const PLANS_LOCKED = true;

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}

export function creditsToRupees(credits: number): number {
  return credits * RUPEES_PER_CREDIT;
}
