import { BETA_UNLOCKED_PLANS } from './plans';
import type { PlanTier } from './types';

/**
 * Beta switch for ShadRox's server-side shared key. The surface opens as soon as
 * the operator unlocks any paid tier, so an unlocked plan can see the control
 * instead of the whole ladder being hidden behind one flat flag.
 */
export const SHARED_KEY_ENABLED = BETA_UNLOCKED_PLANS.length > 0;

/**
 * Eligibility, not a key. This only says the signed-in plan may use the "Use
 * ShadRox Shared Key" control; it hands out no credential and proves nothing can
 * be spent. The enforcement stays in api/ai/_access.ts, which requires
 * SHADROX_ALLOW_SHARED_KEY=1 plus that provider's key in the server process's
 * environment — on a tester machine neither exists, so the request fails with the
 * existing clear message rather than silently spending someone else's credential.
 */
export function isSharedKeyEligible(plan: PlanTier): boolean {
  return BETA_UNLOCKED_PLANS.includes(plan);
}
