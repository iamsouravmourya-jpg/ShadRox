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
import { inferMilestoneCategory } from './milestoneVerifier';
import { extractExplicitPathsFromText, extractRequirements, formatRequirementChecklistForPrompt } from './requirements';
import { canonicalPathKey, dedupePaths, isCaseInsensitivePlatform, normalizeRepoPath } from '../paths';
import type { Milestone, MilestoneCategory, PlanError, RunBudget } from './types';

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
  category?: unknown;
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

const VALID_CATEGORIES = new Set<MilestoneCategory>([
  'read_only',
  'file_mutation',
  'command_execution',
  'checkpoint'
]);

function normalizeCategory(value: unknown): MilestoneCategory | undefined {
  const raw = asString(value);
  return VALID_CATEGORIES.has(raw as MilestoneCategory) ? (raw as MilestoneCategory) : undefined;
}

function normalizeMilestone(raw: RawMilestone, index: number): Milestone {
  const title = asString(raw.title) || asString(raw.description);
  const instruction = asString(raw.instruction) || title;
  const expectedFiles = asStringArray(raw.expectedFiles);
  const verifyCommand = asString(raw.verifyCommand) || undefined;
  const explicitCategory = normalizeCategory(raw.category);
  const inferred = explicitCategory ?? inferMilestoneCategory({ title, instruction, expectedFiles, verifyCommand });
  const category = explicitCategory ?? (inferred === 'read_only' || inferred === 'checkpoint' ? inferred : undefined);
  return {
    id: asString(raw.id) || `m${index + 1}`,
    title,
    instruction,
    expectedFiles,
    dependsOn: asStringArray(raw.dependsOn),
    verifyCommand,
    ...(category ? { category } : {}),
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

function normalizePlanPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function mergeMilestoneGroup(group: Milestone[], targetFile: string, extraDeps: string[] = []): Milestone {
  const head = group[0];
  const groupIds = new Set(group.map((item) => item.id));
  const combinedTitle =
    group.length === 1
      ? head.title
      : `Update ${targetFile} (${group.map((item) => item.title).join('; ').slice(0, 140)})`;
  const combinedInstruction =
    group.length === 1
      ? head.instruction
      : group
          .map((item, idx) => `${idx + 1}. ${item.title}: ${item.instruction}`)
          .join('\n');
  const dependsOn: string[] = [];
  const seenDeps = new Set<string>();
  for (const dep of [...extraDeps, ...group.flatMap((item) => item.dependsOn)]) {
    if (!dep || groupIds.has(dep) || dep === head.id || seenDeps.has(dep)) continue;
    seenDeps.add(dep);
    dependsOn.push(dep);
  }
  const verifyCommand = [...group].reverse().find((item) => Boolean(item.verifyCommand))?.verifyCommand;
  return {
    id: head.id,
    title: combinedTitle,
    instruction: combinedInstruction,
    expectedFiles: [targetFile],
    dependsOn,
    ...(verifyCommand ? { verifyCommand } : {}),
    status: 'pending',
    attempts: []
  };
}

/**
 * Collapses fragmented consecutive milestones that all edit the exact same
 * pre-existing file (for example 5-7 separate section updates to `src/App.jsx`)
 * into 1-2 structured milestones while remapping downstream dependencies cleanly.
 */
export function coalesceSingleFileMilestones(milestones: Milestone[], files: readonly string[]): Milestone[] {
  if (milestones.length < 3 || files.length === 0) return milestones;

  const caseInsensitive = isCaseInsensitivePlatform() || files.some((file) => /^[a-z]:/i.test(file));
  const existingMap = new Map<string, string>();
  for (const file of files) {
    const clean = normalizePlanPath(file);
    if (clean) existingMap.set(canonicalPathKey(clean, caseInsensitive), clean);
  }

  const keyForSingleExistingFile = (milestone: Milestone): string | null => {
    if (inferMilestoneCategory(milestone) !== 'file_mutation') return null;
    if (milestone.expectedFiles.length !== 1) return null;
    const clean = normalizePlanPath(milestone.expectedFiles[0]);
    if (!clean) return null;
    const key = canonicalPathKey(clean, caseInsensitive);
    return existingMap.has(key) ? key : null;
  };

  const result: Milestone[] = [];
  const idRemap = new Map<string, string>();
  let index = 0;

  while (index < milestones.length) {
    const key = keyForSingleExistingFile(milestones[index]);
    if (!key) {
      result.push(milestones[index]);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < milestones.length && keyForSingleExistingFile(milestones[end]) === key) {
      end += 1;
    }

    const run = milestones.slice(index, end);
    if (run.length < 3) {
      result.push(...run);
      index = end;
      continue;
    }

    const canonicalFile = existingMap.get(key) ?? normalizePlanPath(run[0].expectedFiles[0]);
    if (run.length <= 4) {
      const merged = mergeMilestoneGroup(run, canonicalFile);
      for (const member of run) idRemap.set(member.id, merged.id);
      result.push(merged);
    } else {
      const splitAt = Math.ceil(run.length / 2);
      const firstHalf = run.slice(0, splitAt);
      const secondHalf = run.slice(splitAt);
      const firstMerged = mergeMilestoneGroup(firstHalf, canonicalFile);
      const secondMerged = mergeMilestoneGroup(secondHalf, canonicalFile, [firstMerged.id]);
      for (const member of firstHalf) idRemap.set(member.id, firstMerged.id);
      for (const member of secondHalf) idRemap.set(member.id, secondMerged.id);
      result.push(firstMerged, secondMerged);
    }

    index = end;
  }

  if (idRemap.size === 0) return milestones;

  return result.map((milestone) => {
    const mappedDeps: string[] = [];
    const seen = new Set<string>();
    for (const dep of milestone.dependsOn) {
      const resolved = idRemap.get(dep) ?? dep;
      if (resolved === milestone.id || seen.has(resolved)) continue;
      seen.add(resolved);
      mappedDeps.push(resolved);
    }
    return { ...milestone, dependsOn: mappedDeps };
  });
}

/**
 * Anti-bloat consolidator for small 1-2 file tasks:
 * When a planner emits 4+ granular milestones that only touch <= 2 distinct files
 * on a focused goal, merge consecutive excess steps cleanly so the plan stays
 * atomic (at most 3 milestones) without artificial read/grep/verify bloat.
 */
export function consolidateSmallTaskMilestones(
  milestones: Milestone[],
  goal: string
): Milestone[] {
  if (milestones.length <= 3) return milestones;
  const requirements = extractRequirements(goal);
  if (requirements.length > 4) return milestones;

  const distinctFiles = new Set<string>();
  for (const milestone of milestones) {
    for (const file of milestone.expectedFiles) {
      const clean = normalizePlanPath(file).toLowerCase();
      if (clean) distinctFiles.add(clean);
    }
  }
  if (distinctFiles.size > 2) return milestones;

  // Merge into 2 or 3 cohesive buckets depending on whether there is a trailing verification/command milestone.
  const last = milestones[milestones.length - 1];
  const lastIsVerifyOnly =
    Boolean(last.verifyCommand) &&
    (last.expectedFiles.length === 0 || last.category === 'command_execution');

  const body = lastIsVerifyOnly ? milestones.slice(0, -1) : milestones;
  if (body.length <= (lastIsVerifyOnly ? 2 : 3)) return milestones;

  const hasLeadingPhase =
    body.length > 2 &&
    (inferMilestoneCategory(body[0]) === 'read_only' || inferMilestoneCategory(body[0]) === 'checkpoint') &&
    body[0].expectedFiles.length === 0;
  const leading = hasLeadingPhase ? [body[0]] : [];
  const mutableBody = hasLeadingPhase ? body.slice(1) : body;
  const remainingSlots = (lastIsVerifyOnly ? 2 : 3) - leading.length;
  if (mutableBody.length <= remainingSlots) return milestones;

  const bucketSize = Math.ceil(mutableBody.length / Math.max(1, remainingSlots));
  const consolidated: Milestone[] = [...leading];
  const idRemap = new Map<string, string>();

  for (let start = 0; start < mutableBody.length; start += bucketSize) {
    const slice = mutableBody.slice(start, start + bucketSize);
    const head = slice[0];
    const sliceIds = new Set(slice.map((m) => m.id));
    const expectedFiles: string[] = [];
    const seenFiles = new Set<string>();
    for (const m of slice) {
      for (const file of m.expectedFiles) {
        const clean = normalizePlanPath(file);
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          expectedFiles.push(clean);
        }
      }
    }
    const verifyCommand = [...slice].reverse().find((m) => Boolean(m.verifyCommand))?.verifyCommand;
    const category = slice.some((m) => inferMilestoneCategory(m) === 'file_mutation')
      ? 'file_mutation'
      : inferMilestoneCategory(head);
    const dependsOn: string[] = [];
    const seenDeps = new Set<string>();
    for (const m of slice) {
      for (const dep of m.dependsOn) {
        const mapped = idRemap.get(dep) ?? dep;
        if (!mapped || sliceIds.has(mapped) || mapped === head.id || seenDeps.has(mapped)) continue;
        seenDeps.add(mapped);
        dependsOn.push(mapped);
      }
    }
    for (const member of slice) idRemap.set(member.id, head.id);

    consolidated.push({
      id: head.id,
      title: slice.length === 1 ? head.title : slice.map((m) => m.title).join(' & ').slice(0, 140),
      instruction:
        slice.length === 1
          ? head.instruction
          : slice.map((m, idx) => `${idx + 1}. ${m.title}: ${m.instruction}`).join('\n'),
      expectedFiles,
      dependsOn,
      ...(verifyCommand ? { verifyCommand } : {}),
      ...(category ? { category } : {}),
      status: 'pending',
      attempts: []
    });
  }

  if (lastIsVerifyOnly) {
    const remappedLastDeps: string[] = [];
    const seenLastDeps = new Set<string>();
    for (const dep of last.dependsOn) {
      const mapped = idRemap.get(dep) ?? dep;
      if (!mapped || mapped === last.id || seenLastDeps.has(mapped)) continue;
      seenLastDeps.add(mapped);
      remappedLastDeps.push(mapped);
    }
    if (remappedLastDeps.length === 0 && consolidated.length > 0) {
      remappedLastDeps.push(consolidated[consolidated.length - 1].id);
    }
    consolidated.push({ ...last, dependsOn: remappedLastDeps });
  }

  return consolidated;
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

const ROOT_PRIORITY_RE =
  /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config\.[^/]+|next\.config\.[^/]+|server\.[cm]?[jt]s|index\.html|readme[^/]*|\.env(?:\.[^/]+)?|electron\/main\.[^/]+|electron\/preload\.[^/]+)$/i;

/**
 * Selects a deterministic, high-signal workspace file inventory up to `limit`
 * paths instead of blindly truncating `files.slice(0, 400)`:
 * 1) files explicitly referenced or stem-matched in the goal,
 * 2) root manifests and entry configs,
 * 3) stratified round-robin across top-level directories so `src/`, `electron/`,
 *    `api/`, `landing/`, `tests/` are all represented on large repos.
 */
export function selectPrioritizedWorkspaceFiles(
  goal: string,
  files: readonly string[],
  limit = 800
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const clean = normalizeRepoPath(raw);
    if (!clean) continue;
    const key = canonicalPathKey(clean, true);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(clean);
  }
  if (deduped.length <= limit) return deduped;

  const explicitRefs = extractExplicitPathsFromText(goal);
  const goalLower = goal.toLowerCase();
  const refKeys = new Set(explicitRefs.map((p) => canonicalPathKey(p, true)));
  const refBasenames = new Set(
    explicitRefs.map((p) => p.split('/').pop()?.toLowerCase() ?? '').filter(Boolean)
  );

  const selected: string[] = [];
  const pickedKeys = new Set<string>();
  const add = (path: string) => {
    if (selected.length >= limit) return;
    const key = canonicalPathKey(path, true);
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    selected.push(path);
  };

  // Tier 1: explicitly referenced paths or filename matches mentioned in goal.
  for (const path of deduped) {
    const key = canonicalPathKey(path, true);
    const base = path.split('/').pop()?.toLowerCase() ?? '';
    if (refKeys.has(key) || (base && (refBasenames.has(base) || goalLower.includes(base)))) {
      add(path);
    }
  }

  // Tier 2: root manifests and primary entrypoints.
  for (const path of deduped) {
    if (ROOT_PRIORITY_RE.test(path)) add(path);
  }

  // Tier 3: stratified round-robin across top-level directories.
  const buckets = new Map<string, string[]>();
  for (const path of deduped) {
    const key = canonicalPathKey(path, true);
    if (pickedKeys.has(key)) continue;
    const slash = path.indexOf('/');
    const topDir = slash >= 0 ? path.slice(0, slash) : '(root)';
    const list = buckets.get(topDir);
    if (list) list.push(path);
    else buckets.set(topDir, [path]);
  }

  const queues = [...buckets.values()];
  let cursor = 0;
  while (selected.length < limit && queues.some((q) => cursor < q.length)) {
    for (const q of queues) {
      if (cursor < q.length && selected.length < limit) {
        add(q[cursor]);
      }
    }
    cursor += 1;
  }

  return selected;
}

/**
 * Scales milestone, turn, tool-call and wall-clock ceilings proportionally when
 * a prompt describes a multi-workstream mega-upgrade (while never shrinking below `base`).
 */
export function computeElasticRunBudget(goal: string, base: RunBudget): RunBudget {
  const requirements = extractRequirements(goal);
  const explicitPaths = extractExplicitPathsFromText(goal).length;
  const words = goal.trim().split(/\s+/).filter(Boolean).length;
  const complexityScore = Math.max(
    requirements.length,
    Math.ceil(explicitPaths / 1.5),
    words >= 350 ? 12 : words >= 180 ? 8 : 1
  );

  if (complexityScore <= 4 && explicitPaths <= 4) {
    return base;
  }

  const maxMilestones = Math.min(20, Math.max(base.maxMilestones, Math.min(18, complexityScore + 2)));
  const maxTurns = Math.min(80, Math.max(base.maxTurns, maxMilestones * 3 + 6));
  const maxToolCalls = Math.max(base.maxToolCalls, maxTurns * 200);
  const maxWallClockMs = Math.max(base.maxWallClockMs, 45 * 60 * 1000);

  return {
    ...base,
    maxMilestones,
    maxTurns,
    maxToolCalls,
    maxWallClockMs
  };
}

/**
 * Extracts explicit file paths mentioned in a goal and resolves bare filenames
 * (e.g. `platformFacade.ts`) to matching workspace paths when available.
 */
export function extractGoalTargetFiles(goal: string, workspaceFiles: readonly string[] = []): string[] {
  const caseInsensitive = isCaseInsensitivePlatform() || workspaceFiles.some((file) => /^[a-z]:/i.test(file));
  const extracted = extractExplicitPathsFromText(goal);
  if (extracted.length === 0) return [];
  if (workspaceFiles.length === 0) return dedupePaths(extracted, caseInsensitive);

  const byCanonical = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const raw of workspaceFiles) {
    const clean = normalizeRepoPath(raw);
    if (!clean) continue;
    byCanonical.set(canonicalPathKey(clean, caseInsensitive), clean);
    const base = clean.split('/').pop()?.toLowerCase() ?? '';
    if (base) {
      const list = byBasename.get(base);
      if (list) list.push(clean);
      else byBasename.set(base, [clean]);
    }
  }

  const resolved: string[] = [];
  for (const rawTarget of extracted) {
    const clean = normalizeRepoPath(rawTarget);
    if (!clean) continue;
    const exact = byCanonical.get(canonicalPathKey(clean, caseInsensitive));
    if (exact) {
      resolved.push(exact);
      continue;
    }
    if (!clean.includes('/')) {
      const matches = byBasename.get(clean.toLowerCase());
      if (matches && matches.length > 0) {
        resolved.push(...matches);
        continue;
      }
    }
    resolved.push(clean);
  }

  return dedupePaths(resolved, caseInsensitive);
}

/** The instruction handed to the model that must return the milestone JSON. */
export function buildPlannerPrompt(goal: string, files: string[], budget: RunBudget): string {
  const inventory = selectPrioritizedWorkspaceFiles(goal, files, 800);
  const fileList = inventory.join('\n') || '(the workspace has no files yet)';
  const checklist = formatRequirementChecklistForPrompt(extractRequirements(goal));
  const explicitTargets = extractGoalTargetFiles(goal, files);
  const sections = [
    'You are the architect for an autonomous coding run inside one project folder.',
    'Decompose the goal below into an ordered set of milestones and return them as JSON.',
    '',
    'GOAL:',
    goal
  ];
  if (checklist) {
    sections.push('', checklist);
  }
  sections.push(
    '',
    `CONSTRAINTS: at most ${budget.maxMilestones} milestones; each milestone must be independently runnable once its dependencies pass.`,
    '',
    'Return ONLY a JSON array. Each element:',
    '{ "id": "m1", "title": "one imperative line", "instruction": "the exact instruction to carry out",',
    '  "expectedFiles": ["repo/relative/path.ts"], "dependsOn": ["m0"], "category": "file_mutation", "verifyCommand": "optional build/test command" }',
    '',
    'Rules: ids are unique; dependsOn only references ids in this array; every path is repo-relative (no leading slash, no "..");',
    'category is optional: "file_mutation" | "read_only" | "command_execution" | "checkpoint";',
    'ensure EVERY item in the requirement checklist and EVERY target file in the goal is assigned to a milestone;',
    ...(explicitTargets.length > 0
      ? [
          `when explicit target file(s) (${explicitTargets.slice(0, 6).join(', ')}) are named in the goal, scope edits to those target files unless direct callers require updates; do NOT schedule cleanup of pre-existing errors in unrelated files;`
        ]
      : []),
    'Keep 1-2 file tasks consolidated into 1-3 cohesive milestones — do NOT emit separate search/read/verify/checkpoint milestones unless explicitly requested;',
    'when updating multiple cohesive UI sections inside a single existing file (e.g. App.jsx or one page component), group those edits into 1-2 structured milestones rather than creating 5-7 section-by-section milestones;',
    'never emit shell file-existence commands (test -f, ls, dir, Test-Path) as verifyCommand — file presence is verified automatically; only set verifyCommand for real build/test/typecheck scripts and omit verifyCommand otherwise; do not wrap the array in prose.',
    '',
    'FILES CURRENTLY IN THE WORKSPACE:',
    fileList
  );
  return sections.join('\n');
}

/**
 * Builds the `planGoal` driver dep from the app's ask-plan function. The budget
 * arrives per call (the run-loop passes its own), so the prompt always reflects
 * the cap actually in force. Automatically runs up to 2 validation self-repair
 * retries when the planner emits invalid JSON or structural plan errors.
 */
export function createPlanGoal(askPlan: (prompt: string) => Promise<string>) {
  return async (goal: string, files: string[], budget: RunBudget): Promise<ParsedPlan> => {
    const basePrompt = buildPlannerPrompt(goal, files, budget);
    let prompt = basePrompt;
    let lastResult: ParsedPlan = { milestones: [], errors: [] };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reply = await askPlan(prompt);
      const parsed = parsePlanReply(reply);
      if (parsed.errors.length === 0) {
        const coalesced = consolidateSmallTaskMilestones(
          coalesceSingleFileMilestones(parsed.milestones, files),
          goal
        );
        const validationErrors = validatePlan(coalesced, files, budget);
        if (validationErrors.length === 0) {
          return { milestones: coalesced, errors: [] };
        }
        lastResult = { milestones: coalesced, errors: validationErrors };
        prompt = [
          basePrompt,
          '',
          'PREVIOUS PLAN FAILED VALIDATION. Fix every error listed below and return ONLY the corrected JSON array:',
          ...validationErrors.map((e) => `- ${e.reason}: ${e.message}`)
        ].join('\n');
      } else {
        lastResult = parsed;
        prompt = [
          basePrompt,
          '',
          'PREVIOUS REPLY COULD NOT BE PARSED AS A MILESTONE JSON ARRAY. Fix these errors and return ONLY valid JSON:',
          ...parsed.errors.map((e) => `- ${e.reason}: ${e.message}`)
        ].join('\n');
      }
    }

    return lastResult;
  };
}
