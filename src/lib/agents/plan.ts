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
import {
  extractJsonArray,
  isSafeRelativePath,
  selectPrioritizedWorkspaceFiles
} from '../autonomy/plan';
import { extractExplicitPathsFromText, extractRequirements, formatRequirementChecklistForPrompt } from '../autonomy/requirements';
import type { PlanError } from '../autonomy/types';
import { repairCoordinatorPlanJson } from './coordinatorResilience';
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
    patchFailures: []
  };
}

/** Parse the coordinator's answer. Never throws; a bad answer is a plan error. */
export function parseTeamPlan(text: string): TeamPlan {
  let data: unknown;
  let parsed = false;
  let parseFailure = 'The coordinator reply contained no JSON array of tasks.';

  const json = extractJsonArray(text);
  if (json !== null) {
    try {
      data = JSON.parse(json);
      parsed = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      parseFailure = `The coordinator reply was not valid JSON: ${detail}`;
    }
  }

  if (!parsed) {
    const repaired = repairCoordinatorPlanJson(text);
    if (repaired.ok) {
      const candidate = repaired.value;
      if (Array.isArray(candidate)) {
        data = candidate;
        parsed = true;
      } else if (candidate && typeof candidate === 'object' && Array.isArray((candidate as { tasks?: unknown }).tasks)) {
        data = (candidate as { tasks: unknown[] }).tasks;
        parsed = true;
      } else if (candidate && typeof candidate === 'object') {
        return {
          tasks: [],
          errors: [{ milestoneId: null, reason: 'unparseable', message: 'The coordinator reply was JSON but not an array of tasks.' }]
        };
      }
    }
  }

  if (!parsed) {
    return {
      tasks: [],
      errors: [{ milestoneId: null, reason: 'unparseable', message: parseFailure }]
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

/**
 * Scales task, turn, tool-call and wall-clock ceilings proportionally when
 * a team prompt spans many requirements or files (while never shrinking below `base`).
 */
export function computeElasticTeamBudget(goal: string, base: TeamBudget): TeamBudget {
  const requirements = extractRequirements(goal);
  const explicitPaths = extractExplicitPathsFromText(goal).length;
  const words = goal.trim().split(/\s+/).filter(Boolean).length;
  const complexityScore = Math.max(
    requirements.length,
    Math.ceil(explicitPaths / 1.5),
    words >= 350 ? 10 : words >= 180 ? 7 : 1
  );

  if (complexityScore <= 4 && explicitPaths <= 4) {
    return base;
  }

  const maxTasks = Math.min(16, Math.max(base.maxTasks, Math.min(14, complexityScore + 2)));
  const maxTurns = Math.min(64, Math.max(base.maxTurns, maxTasks * 3 + 4));
  const maxToolCalls = Math.max(base.maxToolCalls, maxTurns * 200);
  const maxWallClockMs = Math.max(base.maxWallClockMs, 45 * 60 * 1000);

  return {
    ...base,
    maxTasks,
    maxTurns,
    maxToolCalls,
    maxWallClockMs
  };
}

/** The instruction handed to the model that must return the task JSON. */
export function buildTeamPlannerPrompt(
  goal: string,
  files: string[],
  budget: TeamBudget,
  workspaceManifest?: string
): string {
  const inventory = selectPrioritizedWorkspaceFiles(goal, files, 800);
  const fileList = inventory.join('\n') || '(the workspace has no files yet)';
  const roster = SPECIALIST_ROLES.join(', ');
  const checklist = formatRequirementChecklistForPrompt(extractRequirements(goal));
  const sections = [
    'You are the coordinator of a small local engineering team working inside one project folder.',
    'Split the goal below into an ordered list of tasks and return them as JSON.',
    '',
    'GOAL:',
    goal
  ];
  if (checklist) {
    sections.push('', checklist);
  }
  sections.push(
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
    '(no leading slash, no ".."); omit verifyCommand when there is nothing to run; do not wrap the array in prose.'
  );
  if (workspaceManifest && workspaceManifest.trim()) {
    sections.push('', workspaceManifest.trim());
  }
  sections.push('', 'FILES CURRENTLY IN THE WORKSPACE:', fileList);
  return sections.join('\n');
}

/**
 * Builds the `planTeam` dep from the app's ask-plan function. The budget arrives
 * per call so the prompt always reflects the cap actually in force. Automatically
 * runs up to 2 validation self-repair retries when the coordinator returns
 * invalid JSON or plan validation errors.
 */
export function createTeamPlan(
  askPlan: (prompt: string) => Promise<string>,
  getWorkspaceManifest?: () => Promise<string | null>
) {
  return async (goal: string, files: string[], budget: TeamBudget): Promise<TeamPlan> => {
    const manifest = (await getWorkspaceManifest?.()) ?? undefined;
    const basePrompt = buildTeamPlannerPrompt(goal, files, budget, manifest);
    let prompt = basePrompt;
    let lastPlan: TeamPlan = { tasks: [], errors: [] };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reply = await askPlan(prompt);
      const parsed = parseTeamPlan(reply);
      if (parsed.errors.length === 0) {
        const validationErrors = validateTeamPlan(parsed.tasks, budget);
        if (validationErrors.length === 0) {
          return parsed;
        }
        lastPlan = { tasks: parsed.tasks, errors: validationErrors };
        prompt = [
          basePrompt,
          '',
          'PREVIOUS TEAM PLAN FAILED VALIDATION. Fix every error below and return ONLY the corrected JSON array:',
          ...validationErrors.map((e) => `- ${e.reason}: ${e.message}`)
        ].join('\n');
      } else {
        lastPlan = parsed;
        prompt = [
          basePrompt,
          '',
          'PREVIOUS REPLY COULD NOT BE PARSED AS A TASK JSON ARRAY. Fix these errors and return ONLY valid JSON:',
          ...parsed.errors.map((e) => `- ${e.reason}: ${e.message}`)
        ].join('\n');
      }
    }

    return lastPlan;
  };
}
