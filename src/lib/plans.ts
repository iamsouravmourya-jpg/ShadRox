import type { PlanTier } from './types';

export interface PlanMeta {
  id: PlanTier;
  label: string;
  price: string;
  monthlyCap: number;
  gstNote: string;
  blurb: string;
  perks: string[];
  popular?: boolean;
}

/**
 * Plans definition with accurate pricing & chat limits:
 * - Free (BYOK): unlimited messages
 * - Pro: ₹499/month (includes GST, no extra tax) — 250 messages / month
 * - Adv: ₹1,099/month (includes GST, no extra tax) — 500 messages / month cap
 * - Enterprise: Custom
 */
export const PLANS: PlanMeta[] = [
  {
    id: 'free',
    label: 'Free (BYOK)',
    price: '₹0',
    monthlyCap: Infinity,
    gstNote: 'Always free — with your own key',
    blurb: 'Bring your own API key (BYOK) — unlimited messages, ₹0 to you and to ShadRox.',
    perks: [
      'Unlimited messages / month — BYOK, no cap, ₹0 cost',
      'Gemini + Groq free models support',
      'Unlimited local workspaces & files',
      'Direct disk write-back + live project preview'
    ]
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '₹499/mo',
    monthlyCap: 250,
    gstNote: 'GST included (no additional taxes)',
    blurb: 'ShadRox shared key — 250 messages/month, fast models.',
    popular: true,
    perks: [
      '250 messages / month included',
      '₹499 flat — GST included (no extra tax)',
      'ShadRox shared key — fast tier models',
      'Priority streaming & automated file patching',
      'Full workspace checkpoints & instant restore'
    ]
  },
  {
    id: 'adv',
    label: 'Adv',
    price: '₹1,099/mo',
    monthlyCap: 500,
    gstNote: 'GST included (no additional taxes)',
    blurb: 'For large codebases & continuous workflows — 500 messages cap.',
    perks: [
      '500 messages / month cap',
      '₹1,099 flat — GST included (no extra tax)',
      'Fast tier + premium advanced models',
      'Extended context window & semantic retrieval',
      '50 checkpoints restore timeline'
    ]
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    price: 'Custom',
    monthlyCap: 5000,
    gstNote: 'Custom contracts & invoicing',
    blurb: 'For teams, custom quotas, and enterprise security compliance.',
    perks: [
      'Custom / high-volume message quotas',
      'SSO + shared secrets vault',
      'Audit log + usage export',
      'Dedicated engineering support & SLA'
    ]
  }
];

export const DEFAULT_PLAN: PlanTier = 'free';

/** Beta-phase switch: paid tiers are visible but cannot be selected yet. */
export const PLANS_LOCKED = true;

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}
