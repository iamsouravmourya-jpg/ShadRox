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
 * - Free (BYOK): 100 messages / month cap
 * - Pro: ₹499/month (includes GST, no extra tax) — 250 messages / month
 * - Adv: ₹1,099/month (includes GST, no extra tax) — 500 messages / month cap
 * - Enterprise: Custom
 */
export const PLANS: PlanMeta[] = [
  {
    id: 'free',
    label: 'Free (BYOK)',
    price: '₹0',
    monthlyCap: 100,
    gstNote: 'Hamesha free — apni key ke saath',
    blurb: 'Apni key laao (BYOK) — 100 messages/month cap.',
    perks: [
      '100 messages / month cap (BYOK)',
      'Gemini + Groq free models support',
      'Unlimited local workspaces & files',
      'Disk write-back + live project preview'
    ]
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '₹499/mo',
    monthlyCap: 250,
    gstNote: 'GST included (alag se koi GST nahi)',
    blurb: 'Devora shared key — 250 messages/month, fast models.',
    popular: true,
    perks: [
      '250 messages / month included',
      '₹499 flat — GST included (no extra tax)',
      'Devora shared key — fast tier models',
      'Priority streaming & AST automated file updates',
      'Full workspace checkpoints & instant restore'
    ]
  },
  {
    id: 'adv',
    label: 'Adv',
    price: '₹1,099/mo',
    monthlyCap: 500,
    gstNote: 'GST included (alag se koi GST nahi)',
    blurb: 'Bade codebase aur lambe chat workflows ke liye — 500 messages cap.',
    perks: [
      '500 messages / month message cap',
      '₹1,099 flat — GST included (no extra tax)',
      'Fast tier + premium advanced models',
      'Extended context window & deep semantic retrieval',
      '50 checkpoints restore timeline'
    ]
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    price: 'Custom',
    monthlyCap: 5000,
    gstNote: 'Custom contracts & invoicing',
    blurb: 'Teams, custom message caps aur enterprise compliance.',
    perks: [
      'Custom / high-volume message quotas',
      'SSO + shared secrets vault',
      'Audit log + usage export',
      'Dedicated engineering support & SLA'
    ]
  }
];

export const DEFAULT_PLAN: PlanTier = 'free';

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}
