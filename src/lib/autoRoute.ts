/**
 * Auto routing: cheap model in, strong model out.
 *
 * The expensive part of a turn is 10-20k tokens of repo context going to an
 * answer model. This decides, before any request leaves the app, whether a
 * priced cheap model should condense that context into a digest first and which
 * model writes the answer. Every price, budget and ceiling here is read from
 * modelRates / modelRouter / plans; nothing in this file sets one.
 */

import { RUPEES_PER_CREDIT, getPlanMeta } from './plans';
import { costRupees, isPriced, type TokenSplit } from './modelRates';
import {
  routeRequest,
  routingIsOperatorOwned,
  routingSavings,
  type RouteRole
} from './modelRouter';
import type { PlanTier } from './types';

/**
 * A verbatim digest keeps about a quarter of what it was handed: paths,
 * signatures and the lines the request touches, with all the surrounding code
 * and comment prose gone. Underestimating it would overstate the saving.
 */
const DIGEST_TOKEN_RATIO = 0.25;

/**
 * What the answer model still receives once the digest has replaced the repo
 * dump — the question, the edit protocol and the short history the caller
 * already measured. ASSUMPTION, not a measurement: 800 tokens is what those
 * parts cost a typical edit turn, and it is deliberately counted on top of the
 * digest so a decision never claims the answer model saw only the digest.
 */
const CONVERSATION_TOKENS = 800;

/** The reply the answer model writes; the same 1.2k split the rate table is tested at. */
const ANSWER_OUTPUT_TOKENS = 1_200;

/**
 * Below this the entire context is under a fifth of one ₹0.24 credit — 20k
 * tokens is exactly one credit on the default edit model — so a second pass
 * would buy back less than the round-trip and the risk of losing an identifier
 * are worth. The case this feature exists for is the 10-20k dump.
 */
export const CONDENSE_MIN_INPUT_TOKENS = 4_000;

/** Roles a user turn can carry. `select` and `summarize` are the cheap passes
 *  themselves and `complete` is a single-pass fill-in, so none gets a digest. */
const CONDENSABLE_ROLES: RouteRole[] = ['chatter', 'edit', 'premium'];

export type TaskComplexity = 'simple' | 'moderate' | 'architectural' | 'reasoning';

export interface ComplexityResult {
  complexity: TaskComplexity;
  reason: string;
  recommendedRole: RouteRole;
}

/**
 * Classifies the incoming prompt's technical complexity to inform auto-routing
 * and specialist team escalation decisions.
 */
export function classifyTaskComplexity(text: string, attachedFilesCount = 0): ComplexityResult {
  const lower = text.toLowerCase();
  if (
    lower.includes('architect') ||
    lower.includes('migrate') ||
    lower.includes('redesign') ||
    lower.includes('refactor entire') ||
    attachedFilesCount > 4
  ) {
    return {
      complexity: 'architectural',
      reason: 'Multi-file structural change requiring frontier model coordination',
      recommendedRole: 'premium'
    };
  }
  if (
    lower.includes('why') ||
    lower.includes('root cause') ||
    lower.includes('debug') ||
    lower.includes('deep think') ||
    lower.includes('analyze') ||
    lower.includes('reason')
  ) {
    return {
      complexity: 'reasoning',
      reason: 'Analytical reasoning task requiring deep thought trace',
      recommendedRole: 'chatter'
    };
  }
  if (lower.length > 400 || attachedFilesCount > 1 || lower.includes('implement') || lower.includes('build')) {
    return {
      complexity: 'moderate',
      reason: 'Standard multi-step code modification',
      recommendedRole: 'edit'
    };
  }
  return {
    complexity: 'simple',
    reason: 'Direct single-turn query or small modification',
    recommendedRole: 'edit'
  };
}

export interface AutoInput {
  role: RouteRole;
  estimatedInputTokens: number;
  availableModels: string[];
  userModel: string;
  isSharedKey: boolean;
  plan: PlanTier;
}
export interface AutoDecision {
  enabled: boolean;
  /** The model that writes the answer — the user's own unless the operator pays. */
  answerModel: string;
  condenseModel: string | null;
  reason: string;
  /** Input the ANSWER call sees, i.e. the digest in place of the raw context. */
  estInputTokens: number;
  /** Output the ANSWER call writes; the digest output is billed but not shown. */
  estOutputTokens: number;
  credits: number;
  savingsFactor: number | null;
  withinBudget: boolean;
}

function nonNegativeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function digestTokensFor(rawTokens: number): number {
  return rawTokens > 0 ? Math.max(1, Math.round(rawTokens * DIGEST_TOKEN_RATIO)) : 0;
}

/**
 * Rupees as credits, rounded up to one decimal: a partial credit is billed as a
 * partial credit, never quietly as a whole one. The epsilon keeps an exact
 * boundary (₹0.84 = 3.5 credits) from being pushed a tenth higher by the float
 * noise of summing two rounded rupee figures.
 */
function creditsOf(rupees: number): number {
  const credits = Math.ceil(((Math.max(0, rupees) / RUPEES_PER_CREDIT) - 1e-9) * 10) / 10;
  return credits > 0 ? credits : 0;
}

/** Says out loud that the estimate for this model is the premium assumption. */
function unpricedClause(model: string): string {
  if (!model || isPriced(model)) return '';
  return `${model} is not in the price registry, so its rate is the premium assumption and this turn is not cheap`;
}

export function decideAutoRoute(input: AutoInput): AutoDecision {
  const rawTokens = nonNegativeTokens(input.estimatedInputTokens);
  const models = (Array.isArray(input.availableModels) ? input.availableModels : []).filter(
    (model) => typeof model === 'string' && model.length > 0
  );
  const userModel = input.userModel || '';
  const operatorOwned = routingIsOperatorOwned(input.isSharedKey);

  // quota.ts treats a non-finite monthly allotment as unmetered and spends no
  // credit against it. That removes the answer-side swap (ShadRox is not paying
  // for the call, so the user's own model choice stands) but NOT the cheap first
  // pass: on BYOK every context token is billed to the user's own key, so reading
  // the repo with the cheapest model is a saving they actually receive.
  const metered = Number.isFinite(getPlanMeta(input.plan).creditsPerMonth);

  const digest = digestTokensFor(rawTokens);
  const condenseSplit: TokenSplit = { inputTokens: rawTokens, outputTokens: digest };
  const wantsCondense = CONDENSABLE_ROLES.includes(input.role) && rawTokens >= CONDENSE_MIN_INPUT_TOKENS;
  const condenseRoute = wantsCondense ? routeRequest('select', condenseSplit, models) : null;
  const condenseModel = condenseRoute?.model ?? null;

  const answerInput = condenseModel ? digest + CONVERSATION_TOKENS : rawTokens;
  const answerSplit: TokenSplit = { inputTokens: answerInput, outputTokens: ANSWER_OUTPUT_TOKENS };
  const routeAnswer = operatorOwned && metered;
  const answerRoute = routeAnswer ? routeRequest(input.role, answerSplit, models) : null;
  const answerModel = (routeAnswer ? answerRoute?.model : null) || userModel;

  const costed = answerModel ? costRupees(answerModel, answerSplit) : 0;
  const rupees = costed + (condenseModel ? costRupees(condenseModel, condenseSplit) : 0);

  const savings = routeAnswer
    ? routingSavings(input.role, { inputTokens: rawTokens, outputTokens: ANSWER_OUTPUT_TOKENS }, userModel || answerModel, models)
    : null;
  const savingsFactor = savings && savings.savedFactor > 0 ? savings.savedFactor : null;

  const withinBudget = metered
    ? (answerRoute ? answerRoute.withinBudget : isPriced(answerModel)) && (condenseRoute ? condenseRoute.withinBudget : true)
    : isPriced(answerModel);

  const parts: string[] = [];
  if (!metered) {
    parts.push(
      'Free (BYOK) has no credit meter — every token is paid to your own provider, so the answer stays on the model you picked'
    );
  } else if (answerRoute && !answerRoute.model) {
    parts.push(`no priceable model on this key, so the answer stays on ${userModel || 'the request model'}`);
  } else if (routeAnswer && answerRoute) {
    parts.push(`answer on ${answerModel} — ${answerRoute.reason}`);
  } else {
    parts.push(`your key: ${userModel || 'the model you picked'} writes the answer, routing does not replace it`);
  }

  if (condenseModel && condenseRoute) {
    parts.push(
      `${condenseModel} digests ${rawTokens} context tokens into ~${digest} — ${condenseRoute.reason}, so the answer reads ${answerInput}`
    );
  } else if (condenseRoute && !(answerRoute && !answerRoute.model)) {
    parts.push(`no digest: ${condenseRoute.reason}`);
  } else if (!CONDENSABLE_ROLES.includes(input.role)) {
    parts.push(`no digest: a ${input.role} request is already the cheap single pass`);
  } else if (rawTokens < CONDENSE_MIN_INPUT_TOKENS) {
    parts.push(`no digest: ${rawTokens} tokens is too little context to pay for a second pass`);
  }

  const unpriced = withinBudget ? '' : unpricedClause(answerModel);
  if (unpriced) parts.push(unpriced);

  return {
    enabled: Boolean(condenseModel) || (routeAnswer && Boolean(answerRoute?.model) && answerModel !== userModel),
    answerModel,
    condenseModel,
    reason: parts.join('. ') + '.',
    estInputTokens: answerInput,
    estOutputTokens: ANSWER_OUTPUT_TOKENS,
    credits: metered ? creditsOf(rupees) : 0,
    savingsFactor,
    withinBudget
  };
}
