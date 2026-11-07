/**
 * Explicit prompt templates and honest refinement (S18).
 *
 * A short request like "is file me bug dekh" is not a bug — it is the user
 * saying what they want. Nothing here rewrites it on its own: a template is only
 * composed when the user picks one, and refinement only runs when the user asks
 * for it. The user's own words are kept verbatim and their chosen mode and
 * targets stay authoritative, so a refinement can never quietly turn Plan into
 * Agent or attach a file they did not attach.
 *
 * Language is theirs too. These templates add no "answer in English" clause and
 * no translation step; a Hinglish request stays Hinglish.
 */

import type { RefineMode } from './types';

export type TemplateId = 'explain' | 'fix' | 'refactor' | 'review' | 'plan';

export interface PromptTemplate {
  id: TemplateId;
  label: string;
  /** Editable guidance prepended to whatever the user typed. */
  guidance: string;
}

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: 'explain',
    label: 'Explain',
    guidance: 'Explain what this does and how it works, reading the actual code before answering.'
  },
  {
    id: 'fix',
    label: 'Fix',
    guidance: 'Find the bug, name its cause, and make the smallest change that fixes it.'
  },
  {
    id: 'refactor',
    label: 'Refactor',
    guidance: 'Refactor for clarity without changing behavior, and keep the public interface the same.'
  },
  {
    id: 'review',
    label: 'Review',
    guidance: 'Review this for correctness, edge cases and clarity; list findings worst-first with the evidence for each.'
  },
  {
    id: 'plan',
    label: 'Plan',
    guidance: 'Write a step-by-step plan first. Do not change any file.'
  }
];

/** The template for a slash id, or null when the id is unknown. */
export function findTemplate(id: string): PromptTemplate | null {
  return PROMPT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * Compose a template with the user's own draft. The draft is appended verbatim,
 * so the user's wording — and its language — survives. An unknown id, or an
 * empty draft under a known id, returns the draft unchanged rather than guessing.
 */
export function applyTemplate(id: string, draft: string): string {
  const template = findTemplate(id);
  if (!template) return draft;
  const trimmed = draft.trim();
  if (trimmed.length === 0) return template.guidance;
  return `${template.guidance}\n\n${draft}`;
}

export interface DraftSnapshot {
  text: string;
  mode: RefineMode;
  targets: readonly string[];
}

export interface RefinementGuard {
  ok: boolean;
  /** Machine-readable reasons a refinement result must be rejected. */
  violations: string[];
}

function normalizeTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Whether a refinement result may replace the draft. Refinement is allowed to
 * reword, but never to change the chosen mode or to attach a target the user did
 * not attach — those are silent scope changes, not tidying.
 */
export function guardRefinement(before: DraftSnapshot, after: DraftSnapshot): RefinementGuard {
  const violations: string[] = [];
  if (before.mode !== after.mode) violations.push('mode-changed');
  const original = new Set(before.targets.map(normalizeTarget));
  if (after.targets.some((target) => !original.has(normalizeTarget(target)))) violations.push('target-added');
  return { ok: violations.length === 0, violations };
}

/** Undoing refinement restores the original draft and its pins, as a copy. */
export function restoreDraft(snapshot: DraftSnapshot): { text: string; mode: RefineMode; targets: string[] } {
  return { text: snapshot.text, mode: snapshot.mode, targets: [...snapshot.targets] };
}

export type RefinementChoice = 'keep' | 'refine';

/**
 * Refinement runs only on an explicit choice. There is no "refine every send"
 * default, so a send never hides a second model call from the user.
 */
export function willRefineOnSend(choice: RefinementChoice): boolean {
  return choice === 'refine';
}

export interface RefinementResult {
  /** True when the result is safe to apply to the composer. */
  accepted: boolean;
  /** True when a refinement call actually ran. */
  ran: boolean;
  text: string;
  mode: RefineMode;
  targets: readonly string[];
  /** Credits the refinement call cost, taken from its usage — never omitted. */
  costCredits: number;
  violations: string[];
}

/**
 * The whole refinement step in one place: run only on choice, judge the result,
 * and report the cost. A rejected result changes nothing and still reports what
 * the call cost, so the spend is visible either way.
 */
export function refineDraft(input: {
  choice: RefinementChoice;
  before: DraftSnapshot;
  /** The refinement call's proposal; ignored entirely when the choice is `keep`. */
  proposed?: DraftSnapshot;
  costCredits?: number;
}): RefinementResult {
  if (!willRefineOnSend(input.choice) || !input.proposed) {
    return {
      accepted: false,
      ran: false,
      text: input.before.text,
      mode: input.before.mode,
      targets: [...input.before.targets],
      costCredits: 0,
      violations: []
    };
  }
  const guard = guardRefinement(input.before, input.proposed);
  const applied = guard.ok ? input.proposed : input.before;
  return {
    accepted: guard.ok,
    ran: true,
    text: applied.text,
    mode: applied.mode,
    targets: [...applied.targets],
    costCredits: Math.max(0, input.costCredits ?? 0),
    violations: guard.violations
  };
}
