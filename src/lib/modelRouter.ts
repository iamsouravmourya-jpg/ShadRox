/**
 * Cost router: which model does which part of a turn.
 *
 * The saving this exists for is asymmetric pricing — the work that only picks
 * context is worth ~₹0.02 and the work that writes the patch is worth ₹0.11 to
 * ₹2.35, so they must not run on the same model. Every ceiling here is derived
 * from CREDIT_RATES/RUPEES_PER_CREDIT in plans.ts; nothing in this file sets a
 * price, it only spends the ones already approved.
 */

import { CREDIT_RATES, RUPEES_PER_CREDIT, type CreditRate } from './plans';
import { USD_TO_INR, costRupees, costUsd, isPriced, type TokenSplit } from './modelRates';

export type RouteRole = 'select' | 'summarize' | 'chatter' | 'edit' | 'premium' | 'complete';

/**
 * Overhead roles are folded into the request they serve, so they may only cost
 * a share of that request's own credit budget.
 */
const OVERHEAD_SHARE = 0.25;

const ROLE_CREDIT_RATE: Record<RouteRole, CreditRate | null> = {
  chatter: 'chatter',
  edit: 'codeEdit',
  premium: 'premiumRefactor',
  complete: 'tabCompletion',
  select: null,
  summarize: null
};

/** What the plan says one request of this role may cost, in rupees. */
export function roleBudgetRupees(role: RouteRole): number {
  const rate = ROLE_CREDIT_RATE[role];
  const credits = rate ? CREDIT_RATES[rate] : role === 'select' ? CREDIT_RATES.codeEdit : CREDIT_RATES.chatter;
  const share = rate ? 1 : OVERHEAD_SHARE;
  return RUPEES_PER_CREDIT * credits * share;
}

export interface RouteChoice {
  role: RouteRole;
  /** Null when the key serves no model this file can price. */
  model: string | null;
  rupees: number;
  /** Rupees as a multiple of the ₹0.24 credit budget. */
  credits: number;
  withinBudget: boolean;
  reason: string;
}

/**
 * A role is a capability ask, not only a budget: "premium" must mean a model
 * that writes good code, and then the budget picks the cheapest one that can
 * afford to. Without these families, cost-only routing would send a refactor to
 * the same model that summarises history.
 */
const ROLE_FAMILIES: Record<RouteRole, RegExp[]> = {
  select: [/ling-\d/, /mercury-\d/, /gpt-oss-/, /qwen\d\.\d-flash/, /flash-lite/, /nemotron.*(nano|lightning)/, /mistral-nemo/, /ministral-3b/],
  summarize: [/scaledown-/, /ling-\d/, /qwen\d\.\d-flash/, /gpt-5-nano/, /mercury-\d/, /flash-lite/],
  chatter: [/ling-\d/, /qwen\d\.\d-flash/, /deepseek-v4-flash/, /gpt-6-luna/, /haiku/, /flash-lite/, /gpt-5-nano/, /mimo-/],
  edit: [/deepseek-v4-flash/, /mimo-v\d.*flash/, /qwen\d\.\d-.*flash/, /glm-\d\.\d-flash/, /gpt-6-luna/, /haiku/, /qwen3-coder/, /nemotron-3-super/, /minimax-m\d.*flash/],
  premium: [/kimi-k\d\.\d-code/, /deepseek-v4-pro/, /qwen3-coder$/, /claude-sonnet/, /gpt-6-sol/, /gemini-4-argon/, /kimi-k\d$/],
  complete: [/gpt-5-nano/, /gpt-4\.1-nano/, /gpt-4o-mini/, /flash-lite/, /ministral-3b/, /ling-\d/, /gpt-oss-20b/]
};

function servesRole(role: RouteRole, model: string): boolean {
  return ROLE_FAMILIES[role].some((pattern) => pattern.test(model.toLowerCase()));
}

/**
 * Cheapest priced model that fits the role's budget. When nothing fits, the
 * cheapest overall is returned with `withinBudget: false` — the caller decides
 * whether to degrade the context or bill more credits, this file does not
 * silently pick an unaffordable model.
 */
export function routeRequest(role: RouteRole, tokens: TokenSplit, availableModels: string[]): RouteChoice {
  const budget = roleBudgetRupees(role);
  const models = (availableModels || []).filter((model) => model && isPriced(model));
  if (models.length === 0) {
    return { role, model: null, rupees: 0, credits: 0, withinBudget: false, reason: 'no priceable model on this key' };
  }

  const inRole = models.filter((model) => servesRole(role, model));
  // Unrounded rupees drive the fit test and the credit ratio; rounding twice
  // would drift a request that sits exactly on a credit boundary.
  const byCost = (list: string[]) =>
    list.map((model) => ({ model, exact: costUsd(model, tokens) * USD_TO_INR })).sort((a, b) => a.exact - b.exact);

  if (inRole.length === 0) {
    const fallback = byCost(models)[0];
    return {
      role,
      model: fallback.model,
      rupees: round2(fallback.exact),
      credits: round2(fallback.exact / RUPEES_PER_CREDIT),
      // Budget fit is not the point here: no model of this class exists on the
      // key, so reporting `withinBudget: true` would hide the gap.
      withinBudget: false,
      reason: `this key serves no ${role}-class model; cheapest priced model instead`
    };
  }

  const costs = byCost(inRole);
  const fitted = costs.find((entry) => entry.exact <= budget);
  const winner = fitted ?? costs[0];
  const rupees = round2(winner.exact);
  const reason = fitted
    ? `cheapest ${role} model inside ₹${round2(budget)}`
    : `no ${role} model fits ₹${round2(budget)}; cheapest in class is ₹${rupees}`;

  return {
    role,
    model: winner.model,
    rupees,
    credits: round2(winner.exact / RUPEES_PER_CREDIT),
    withinBudget: Boolean(fitted),
    reason
  };
}

/** What routing saves against running the same role on the user's picked model. */
export function routingSavings(role: RouteRole, tokens: TokenSplit, userModel: string, availableModels: string[]) {
  const naive = costRupees(userModel, tokens);
  const routed = routeRequest(role, tokens, availableModels);
  return {
    naiveRupees: naive,
    routedRupees: routed.rupees,
    savedRupees: round2(naive - routed.rupees),
    savedFactor: routed.rupees > 0 ? round1(naive / routed.rupees) : 0,
    routedModel: routed.model
  };
}

/**
 * Routing is optional on BYOK — the tokens are the user's own money and their
 * model choice is deliberate. It is mandatory on a shared key, where context
 * size is the only thing between the plan and a loss.
 */
export function routingIsOperatorOwned(isSharedKey: boolean): boolean {
  return isSharedKey;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
