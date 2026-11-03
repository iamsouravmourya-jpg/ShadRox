/**
 * The planner: turn a goal + the repo's file list into a validated milestone
 * DAG, and turn the model's raw answer into milestones.
 *
 * Two separate concerns, deliberately:
 *   - `parsePlanReply` only parses. Anything it cannot read becomes an
 *     `unparseable` error, never an invented milestone.
 *   - `validatePlan` only judges. It reads the parsed milestones and reports
 *     every reason the plan must not run (empty, oversized, duplicate id,
 *     blank field, unknown dependency, cycle, path outside the workspace).
 *
 * Nothing here calls a model; `createPlanGoal` is the seam that injects the
 * app's real ask-plan function, which is what makes the planner testable.
 */

import { findCycles } from './dag';
import type { Milestone, PlanError, RunBudget } from './types';

/**
 * A milestone leaf from the model's JSON array. Every field is optional because
 * the model's output is untrusted input: the normalizer fills the shape and the
 * validator reports what is missing.
 */
interface RawMilestone {
  id?: unknown;
  title?: unknown;
  instruction?: unknown;
  description?: unknown;
  expectedFiles?: unknown;
  dependsOn?: unknown;
  verifyCommand?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry) => entry.length > 0);
}

/**
 * A workspace-relative path that cannot escape the workspace. Rejects absolute
 * paths (POSIX and Windows), drive letters, UNC paths, NUL bytes and any `..`
 * segment — the same class of path the transactional writer refuses at write
 * time, caught here before a single byte is planned.
 */
export function isSafeRelativePath(value: string): boolean {
  const path = value.trim();
  if (!path) return false;
  if (path.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.startsWith('\\\\') || path.startsWith('//')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  return !path.split(/[\\/]+/).some((segment) => segment === '..');
}

/** Strip a markdown fence if present, then a bare JSON array if one is present. */
export function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

function normalizeMilestone(raw: RawMilestone, index: number): Milestone {
  const title = asString(raw.title) || asString(raw.description);
  return {
    id: asString(raw.id) || `m${index + 1}`,
    title,
    instruction: asString(raw.instruction) || title,
    expectedFiles: asStringArray(raw.expectedFiles),
    dependsOn: asStringArray(raw.dependsOn),
    verifyCommand: asString(raw.verifyCommand) || undefined,
    status: 'pending',
    attempts: []
  };
}

export interface ParsedPlan {
  milestones: Milestone[];
  errors: PlanError[];
}

/** Parse the model's answer. Never throws; a bad answer is a plan error. */
export function parsePlanReply(text: string): ParsedPlan {
  const json = extractJsonArray(text);
  if (json === null) {
    return {
      milestones: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: 'The planner reply contained no JSON array of milestones.' }]
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      milestones: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: `The planner reply was not valid JSON: ${detail}` }]
    };
  }

  if (!Array.isArray(data)) {
    return {
      milestones: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: 'The planner reply was JSON but not an array of milestones.' }]
    };
  }

  const milestones = data.map((item, index) =>
    normalizeMilestone(item && typeof item === 'object' ? (item as RawMilestone) : {}, index)
  );
  return { milestones, errors: [] };
}

/**
 * Every reason the plan must not run, in one pass. Returns an empty array for a
 * runnable plan. Milestone-scoped errors carry the offending id so the panel can
 * point at the right row.
 */
export function validatePlan(milestones: Milestone[], _files: string[], budget: RunBudget): PlanError[] {
  const errors: PlanError[] = [];

  if (milestones.length === 0) {
    errors.push({ milestoneId: null, reason: 'empty', message: 'The planner returned no milestones.' });
    return errors;
  }

  if (milestones.length > budget.maxMilestones) {
    errors.push({
      milestoneId: null,
      reason: 'too-many',
      message: `The plan has ${milestones.length} milestones but the run allows at most ${budget.maxMilestones}.`
    });
  }

  const seen = new Set<string>();
  for (const milestone of milestones) {
    if (seen.has(milestone.id)) {
      errors.push({ milestoneId: milestone.id, reason: 'duplicate-id', message: `Two milestones share the id "${milestone.id}".` });
    }
    seen.add(milestone.id);

    if (!milestone.title || !milestone.instruction) {
      errors.push({ milestoneId: milestone.id, reason: 'blank-field', message: `Milestone "${milestone.id}" is missing a title or instruction.` });
    }

    for (const path of milestone.expectedFiles) {
      if (!isSafeRelativePath(path)) {
        errors.push({
          milestoneId: milestone.id,
          reason: 'bad-path',
          message: `Milestone "${milestone.id}" lists a path outside the workspace: ${path}`
        });
      }
    }
  }

  const ids = new Set(milestones.map((milestone) => milestone.id));
  for (const milestone of milestones) {
    for (const dependency of milestone.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push({
          milestoneId: milestone.id,
          reason: 'unknown-dependency',
          message: `Milestone "${milestone.id}" depends on "${dependency}", which is not in the plan.`
        });
      }
    }
  }

  const cyclic = findCycles(milestones);
  if (cyclic.length > 0) {
    errors.push({
      milestoneId: cyclic[0],
      reason: 'cycle',
      message: `The plan has a dependency cycle through: ${cyclic.join(', ')}.`
    });
  }

  return errors;
}

/** The instruction handed to the model that must return the milestone JSON. */
export function buildPlannerPrompt(goal: string, files: string[], budget: RunBudget): string {
  const fileList = files.slice(0, 400).join('\n') || '(the workspace has no files yet)';
  return [
    'You are the architect for an autonomous coding run inside one project folder.',
    'Decompose the goal below into an ordered set of milestones and return them as JSON.',
    '',
    'GOAL:',
    goal,
    '',
    `CONSTRAINTS: at most ${budget.maxMilestones} milestones; each milestone must be independently runnable once its dependencies pass.`,
    '',
    'Return ONLY a JSON array. Each element:',
    '{ "id": "m1", "title": "one imperative line", "instruction": "the exact instruction to carry out",',
    '  "expectedFiles": ["repo/relative/path.ts"], "dependsOn": ["m0"], "verifyCommand": "optional command to prove it" }',
    '',
    'Rules: ids are unique; dependsOn only references ids in this array; every path is repo-relative (no leading slash, no "..");',
    'omit verifyCommand when there is nothing to run; do not wrap the array in prose.',
    '',
    'FILES CURRENTLY IN THE WORKSPACE:',
    fileList
  ].join('\n');
}

/**
 * Builds the `planGoal` driver dep from the app's ask-plan function. The budget
 * arrives per call (the run-loop passes its own), so the prompt always reflects
 * the cap actually in force.
 */
export function createPlanGoal(askPlan: (prompt: string) => Promise<string>) {
  return async (goal: string, files: string[], budget: RunBudget): Promise<ParsedPlan> => {
    const reply = await askPlan(buildPlannerPrompt(goal, files, budget));
    return parsePlanReply(reply);
  };
}
