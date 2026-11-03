/**
 * The coordinator's planner: turn a goal + the repo's file list into a validated
 * team plan, and turn the model's raw answer into tasks.
 *
 * Same two concerns as the solo planner, kept separate on purpose:
 *   - `parseTeamPlan` only parses. Anything it cannot read becomes an
 *     `unparseable` error, never an invented task.
 *   - `validateTeamPlan` only judges. It reports every reason the plan must not
 *     run, including the one check that only exists here: a task assigned to
 *     nobody, or to the coordinator (which does not carry tasks).
 *
 * Nothing here calls a model; `createTeamPlan` is the seam that injects the
 * app's real ask-plan function, which is what makes this testable.
 */

import { findCycles } from '../autonomy/dag';
import { extractJsonArray, isSafeRelativePath } from '../autonomy/plan';
import type { PlanError } from '../autonomy/types';
import { SPECIALIST_ROLES, isSpecialistRole } from './roles';
import type { AgentRole, TeamBudget, TeamPlan, TeamTask } from './types';

/**
 * A task leaf from the model's JSON array. Every field is optional because the
 * model's output is untrusted input: the normalizer fills the shape and the
 * validator reports what is missing.
 */
interface RawTask {
  id?: unknown;
  title?: unknown;
  instruction?: unknown;
  description?: unknown;
  assignee?: unknown;
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

function normalizeTask(raw: RawTask, index: number): TeamTask {
  const title = asString(raw.title) || asString(raw.description);
  return {
    id: asString(raw.id) || `t${index + 1}`,
    title,
    instruction: asString(raw.instruction) || title,
    assignee: asString(raw.assignee) as AgentRole,
    expectedFiles: asStringArray(raw.expectedFiles),
    dependsOn: asStringArray(raw.dependsOn),
    verifyCommand: asString(raw.verifyCommand) || undefined,
    status: 'pending',
    attempts: 0,
    lastReport: null,
    report: '',
    patchesApplied: 0,
    patchFailures: [],
    creditsSpent: 0
  };
}

/** Parse the coordinator's answer. Never throws; a bad answer is a plan error. */
export function parseTeamPlan(text: string): TeamPlan {
  const json = extractJsonArray(text);
  if (json === null) {
    return {
      tasks: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: 'The coordinator reply contained no JSON array of tasks.' }]
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      tasks: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: `The coordinator reply was not valid JSON: ${detail}` }]
    };
  }

  if (!Array.isArray(data)) {
    return {
      tasks: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: 'The coordinator reply was JSON but not an array of tasks.' }]
    };
  }

  const tasks = data.map((item, index) => normalizeTask(item && typeof item === 'object' ? (item as RawTask) : {}, index));
  return { tasks, errors: [] };
}

/**
 * Every reason the plan must not run, in one pass. Returns an empty array for a
 * runnable plan. Task-scoped errors carry the offending id so the panel can point
 * at the right row.
 */
export function validateTeamPlan(tasks: TeamTask[], budget: TeamBudget): PlanError[] {
  const errors: PlanError[] = [];

  if (tasks.length === 0) {
    errors.push({ milestoneId: null, reason: 'empty', message: 'The coordinator produced no tasks.' });
    return errors;
  }

  if (tasks.length > budget.maxTasks) {
    errors.push({
      milestoneId: null,
      reason: 'too-many',
      message: `The plan has ${tasks.length} tasks but a team run allows at most ${budget.maxTasks}.`
    });
  }

  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      errors.push({ milestoneId: task.id, reason: 'duplicate-id', message: `Two tasks share the id "${task.id}".` });
    }
    seen.add(task.id);

    if (!task.title || !task.instruction) {
      errors.push({ milestoneId: task.id, reason: 'blank-field', message: `Task "${task.id}" is missing a title or instruction.` });
    }

    if (!isSpecialistRole(task.assignee)) {
      const named = task.assignee ? `"${task.assignee}"` : 'nobody';
      errors.push({
        milestoneId: task.id,
        reason: 'unknown-assignee',
        message: `Task "${task.id}" is assigned to ${named}. Each task must name one of: ${SPECIALIST_ROLES.join(', ')}.`
      });
    }

    for (const path of task.expectedFiles) {
      if (!isSafeRelativePath(path)) {
        errors.push({
          milestoneId: task.id,
          reason: 'bad-path',
          message: `Task "${task.id}" lists a path outside the workspace: ${path}`
        });
      }
    }
  }

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push({
          milestoneId: task.id,
          reason: 'unknown-dependency',
          message: `Task "${task.id}" depends on "${dependency}", which is not in the plan.`
        });
      }
    }
  }

  const cyclic = findCycles(tasks);
  if (cyclic.length > 0) {
    errors.push({
      milestoneId: cyclic[0],
      reason: 'cycle',
      message: `The plan has a dependency cycle through: ${cyclic.join(', ')}.`
    });
  }

  return errors;
}

/** The instruction handed to the model that must return the task JSON. */
export function buildTeamPlannerPrompt(goal: string, files: string[], budget: TeamBudget): string {
  const fileList = files.slice(0, 400).join('\n') || '(the workspace has no files yet)';
  const roster = SPECIALIST_ROLES.join(', ');
  return [
    'You are the coordinator of a small local engineering team working inside one project folder.',
    'Split the goal below into an ordered list of tasks and return them as JSON.',
    '',
    'GOAL:',
    goal,
    '',
    `THE TEAM — assign every task to exactly one of: ${roster}.`,
    'frontend owns UI and client state; backend owns APIs, data and config;',
    'tests owns test files and fixtures only; reviewer changes nothing and reports problems.',
    '',
    `CONSTRAINTS: at most ${budget.maxTasks} tasks. Give the reviewer one task at the end that changes no files.`,
    'A task that edits files must list them; a task that only investigates must set expectedFiles to [].',
    '',
    'Return ONLY a JSON array. Each element:',
    '{ "id": "t1", "title": "one imperative line", "instruction": "the exact instruction to carry out",',
    '  "assignee": "backend", "expectedFiles": ["repo/relative/path.ts"], "dependsOn": ["t0"],',
    '  "verifyCommand": "optional command to prove it" }',
    '',
    'Rules: ids are unique; dependsOn only references ids in this array; every path is repo-relative',
    '(no leading slash, no ".."); omit verifyCommand when there is nothing to run; do not wrap the array in prose.',
    '',
    'FILES CURRENTLY IN THE WORKSPACE:',
    fileList
  ].join('\n');
}

/**
 * Builds the `planTeam` dep from the app's ask-plan function. The budget arrives
 * per call so the prompt always reflects the cap actually in force.
 */
export function createTeamPlan(askPlan: (prompt: string) => Promise<string>) {
  return async (goal: string, files: string[], budget: TeamBudget): Promise<TeamPlan> => {
    const reply = await askPlan(buildTeamPlannerPrompt(goal, files, budget));
    return parseTeamPlan(reply);
  };
}
