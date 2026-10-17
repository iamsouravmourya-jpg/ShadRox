import type { PlanTier } from './types';

export interface PlanMeta {
  id: PlanTier;
  label: string;
  price: string;
  blurb: string;
  perks: string[];
}

/**
 * Mock pricing for the UI only — no checkout, no database. Free is the real
 * working plan today (BYOK); everything above it just renders.
 */
export const PLANS: PlanMeta[] = [
  {
    id: 'free',
    label: 'Free',
    price: '₹0',
    blurb: 'Apni key laao (BYOK) — sab core features khule hain.',
    perks: ['Gemini + Groq free models', 'Unlimited local workspaces', 'Disk write-back + live preview']
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '₹399/mo',
    blurb: 'Devora ki shared key — koi setup nahi, seedha likho.',
    perks: [
      'Devora shared key — fast tier models',
      '600 messages / month included',
      'Priority streaming'
    ]
  },
  {
    id: 'adv',
    label: 'Adv',
    price: '₹899/mo',
    blurb: 'Bade codebase aur lambi chat ke liye.',
    perks: [
      'Fast tier + premium models',
      '1,200 fast + 100 premium messages / month',
      'Restore timeline 50 checkpoints'
    ]
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    price: 'Custom',
    blurb: 'Team aur compliance ke liye.',
    perks: ['SSO + shared secrets vault', 'Audit log + usage export', 'Dedicated support']
  }
];

export const DEFAULT_PLAN: PlanTier = 'free';

export function getPlanMeta(plan: PlanTier): PlanMeta {
  return PLANS.find((entry) => entry.id === plan) || PLANS[0];
}
