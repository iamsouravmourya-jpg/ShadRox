/**
 * The team roster: who is on it, what each one owns, and how a task is phrased
 * for the agent that has to carry it out.
 *
 * The briefs are the whole point of having roles rather than one generic agent.
 * "Frontend" is not a label on a card; it is the sentence that keeps the agent
 * out of the backend while a different agent is editing it, which is what makes
 * a team more than a queue of unrelated edits.
 *
 * The same module also owns the mapping the closing integration turn reads: which
 * role changed which file, which files more than one role wrote, and the plan's
 * ownership map. That turn is the only moment the team sees its own work as one
 * change set, so the rollup lives next to the roles it rolls up, not in the driver.
 */

import { fileClaims, normalizeOwnedPath } from './ownership';
import type {
  AgentRole,
  AgentSpec,
  AgentStatus,
  DiagnosticLine,
  MergeOverlap,
  RoleChangedFiles,
  TaskStatus,
  TeamState,
  TeamTask
} from './types';

/** The coordinator plans and assigns. It never carries a task itself. */
export const COORDINATOR: AgentSpec = {
  id: 'coordinator',
  name: 'Coordinator',
  blurb: 'Reads the goal, splits it into tasks, assigns every task to one specialist.',
  brief: 'You are the coordinator. You do not edit files; you decide who does what, in what order.'
};

export const TEAM_ROSTER: AgentSpec[] = [
  {
    id: 'frontend',
    name: 'Frontend',
    blurb: 'Components, styling, client state, rendering',
    brief:
      'You own the client-facing layer: components, styling, client state and how things render. ' +
      'Leave server code, data access and tests to the other agents.'
  },
  {
    id: 'backend',
    name: 'Backend',
    blurb: 'APIs, data access, services, build config',
    brief:
      'You own the server side: APIs, data access, services and build/runtime configuration. ' +
      'Leave UI code and tests to the other agents.'
  },
  {
    id: 'tests',
    name: 'Tests',
    blurb: 'Test files and fixtures',
    brief:
      'You write and repair tests and fixtures only. Do not weaken a test to make it pass. ' +
      'If the test is right and the product code is wrong, say so in your reply instead of changing the test.'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    blurb: 'Reads the result and reports problems; changes nothing',
    brief:
      'You change nothing. Read the current files and the other agents\' reports, then reply with concrete problems: ' +
      'file, line and what is wrong. If you find nothing, say so plainly.'
  }
];

/** Everyone who can be assigned a task. The coordinator is deliberately absent. */
export const SPECIALIST_ROLES: AgentRole[] = TEAM_ROSTER.map((spec) => spec.id);

export function isSpecialistRole(value: string): value is AgentRole {
  return SPECIALIST_ROLES.includes(value as AgentRole);
}

/** The coordinator is in the map so the closing turn can be phrased in its voice. */
const BY_ROLE = new Map<AgentRole, AgentSpec>(
  [COORDINATOR, ...TEAM_ROSTER].map((spec) => [spec.id, spec] as [AgentRole, AgentSpec])
);

/**
 * The spec for a role. Unknown roles fall back to the first specialist so a view
 * can always render something, and the planner validates the assignee before a
 * run starts so this is never reached with a bad role in practice.
 */
export function findAgent(role: AgentRole): AgentSpec {
  return BY_ROLE.get(role) ?? TEAM_ROSTER[0];
}

export interface AgentView {
  spec: AgentSpec;
  status: AgentStatus;
  /** The title of the task this agent is running right now, if any. */
  currentTask: string | null;
  passed: number;
  failed: number;
  total: number;
}

function rollupStatus(statuses: TaskStatus[]): AgentStatus {
  if (statuses.some((status) => status === 'running')) return 'working';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'pending')) return 'waiting';
  if (statuses.length > 0 && statuses.every((status) => status === 'passed')) return 'done';
  return 'idle';
}

/**
 * Who is doing what, derived from the tasks. Nothing stores an agent's status:
 * a status that can disagree with the task list is a status that will.
 */
export function teamAgentViews(state: TeamState | null): AgentView[] {
  const tasks = state?.tasks ?? [];
  return TEAM_ROSTER.map((spec) => {
    const mine = tasks.filter((task) => task.assignee === spec.id);
    const running = mine.find((task) => task.status === 'running');
    return {
      spec,
      status: rollupStatus(mine.map((task) => task.status)),
      currentTask: running ? running.title : null,
      passed: mine.filter((task) => task.status === 'passed').length,
      failed: mine.filter((task) => task.status === 'failed' || task.status === 'blocked').length,
      total: mine.length
    };
  });
}

/**
 * Compose the instruction one agent is handed for one task: who it is, what it
 * owns, the task itself, the files it may touch, and what the team already knows.
 */
export function buildTaskInstruction(task: TeamTask, sharedContext: string): string {
  const spec = findAgent(task.assignee);
  const files =
    task.expectedFiles.length > 0
      ? ['You may edit only these files:', task.expectedFiles.map((path) => `- ${path}`).join('\n')].join('\n')
      : 'This task changes no files. Reply with your findings only; do not emit edits.';

  const sections: string[] = [
    `You are the ${spec.name} agent on a local project team.`,
    spec.brief,
    '',
    `TASK ${task.id}: ${task.title}`,
    '',
    task.instruction,
    '',
    files
  ];

  if (sharedContext) {
    sections.push('', 'WHAT THE OTHER AGENTS REPORTED BEFORE THIS TASK:', sharedContext);
  }

  sections.push('', 'Reply with the change itself, not a plan for it.');
  return sections.join('\n');
}

/** ─── The closing integration pass: the rollup it reads, and how it is phrased ── */

/** How many files one line lists before it is shortened, and how many diagnostics. */
const MAX_LISTED_FILES = 12;
const MAX_LISTED_DIAGNOSTICS = 24;

/** Files a task actually wrote, normalised and de-duplicated, in first-write order. */
function writtenBy(task: TeamTask): string[] {
  const files: string[] = [];
  for (const raw of task.touchedFiles ?? []) {
    const file = normalizeOwnedPath(raw);
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * Which role changed which file, roles in order of first write. A task that wrote
 * nothing (an investigation, a blocked task) contributes no line, so the report
 * only ever claims bytes that reached disk.
 */
export function changedFilesByRole(tasks: readonly TeamTask[]): RoleChangedFiles[] {
  const byRole = new Map<AgentRole, RoleChangedFiles>();
  for (const task of tasks) {
    const files = writtenBy(task);
    if (files.length === 0) continue;
    const entry = byRole.get(task.assignee) ?? { role: task.assignee, taskIds: [], files: [] };
    entry.taskIds.push(task.id);
    for (const file of files) {
      if (!entry.files.includes(file)) entry.files.push(file);
    }
    byRole.set(task.assignee, entry);
  }
  return [...byRole.values()];
}

/** Every file the team changed, union across roles, in first-write order. */
export function changedFileUnion(tasks: readonly TeamTask[]): string[] {
  const files: string[] = [];
  for (const task of tasks) {
    for (const file of writtenBy(task)) {
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

/**
 * Files more than one task wrote — the breakage no per-task check can see, because
 * each task only ever looked at its own files. Detected on what reached disk, not
 * on what the plan claimed, so a task that never wrote cannot raise a false alarm.
 */
export function writeOverlaps(tasks: readonly TeamTask[]): MergeOverlap[] {
  const writers = new Map<string, { taskId: string; role: AgentRole }[]>();
  for (const task of tasks) {
    for (const file of writtenBy(task)) {
      const list = writers.get(file) ?? [];
      list.push({ taskId: task.id, role: task.assignee });
      writers.set(file, list);
    }
  }

  const overlaps: MergeOverlap[] = [];
  for (const [file, list] of writers) {
    if (list.length < 2) continue;
    const order = list.map((writer) => `${writer.taskId} (${writer.role})`).join(' then ');
    overlaps.push({
      file,
      roles: [...new Set(list.map((writer) => writer.role))],
      taskIds: list.map((writer) => writer.taskId),
      note: `${file} was written by ${order} — only the last write is on disk, so the earlier role's change is gone.`
    });
  }
  return overlaps;
}

export interface OwnershipMapEntry {
  file: string;
  /** `t1 (frontend)`, in plan order: who was allowed to write this. */
  owners: string[];
}

/** The plan's own claim list, so the merge turn can compare intent against disk. */
export function ownershipMap(tasks: TeamTask[]): OwnershipMapEntry[] {
  return [...fileClaims(tasks)].map(([file, owners]) => ({
    file,
    owners: owners.map((task) => `${task.id} (${task.assignee})`)
  }));
}

export interface IntegrationBriefInput {
  goal: string;
  /** The role carrying the closing turn: the coordinator, or the reviewer. */
  role: AgentRole;
  byRole: RoleChangedFiles[];
  ownership: OwnershipMapEntry[];
  overlaps: MergeOverlap[];
  /** Diagnostics for the changed files, taken after every task had settled. */
  diagnostics: DiagnosticLine[];
  /** Files the apply policy held back; they are proposed, not landed. */
  awaitingReview: string[];
}

function fileList(files: readonly string[]): string {
  if (files.length === 0) return '(none)';
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  return files.length > MAX_LISTED_FILES ? `${shown} (+${files.length - MAX_LISTED_FILES} more)` : shown;
}

/** Errors first: the closing turn reads the top of this list, not the whole build. */
function diagnosticLines(diagnostics: readonly DiagnosticLine[]): string {
  if (diagnostics.length === 0) return '- nothing was reported for these files.';
  const ordered = [...diagnostics].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return ordered
    .slice(0, MAX_LISTED_DIAGNOSTICS)
    .map((line) => `- ${line.severity} ${line.path}:${line.line}:${line.column} ${line.message}`)
    .join('\n');
}

/**
 * Compose the closing turn's instruction: what each role changed, who was allowed
 * to change it, which files two roles both wrote, and what the checker now says
 * about all of them together. The overlaps get their own block, because a merge
 * that quietly keeps the last write is the failure this turn exists to catch.
 */
export function buildIntegrationInstruction(input: IntegrationBriefInput): string {
  const spec = findAgent(input.role);
  const sections: string[] = [
    `You are the ${spec.name} agent on a local project team. Every task has now finished, and you carry the one closing integration pass.`,
    spec.brief,
    '',
    `GOAL: ${input.goal}`,
    '',
    'WHAT EACH ROLE CHANGED:',
    input.byRole.length > 0
      ? input.byRole.map((entry) => `- ${entry.role} (${entry.taskIds.join(', ')}): ${fileList(entry.files)}`).join('\n')
      : '- no task wrote any file.',
    '',
    'OWNERSHIP MAP — which task each file was assigned to:',
    input.ownership.length > 0
      ? input.ownership.map((entry) => `- ${entry.file}: ${entry.owners.join(', ')}`).join('\n')
      : '- the plan assigned no files.',
    '',
    input.overlaps.length > 0
      ? [
          'OVERLAPS — more than one task wrote these files. These are NOT accepted silently:',
          input.overlaps.map((overlap) => `- ${overlap.note}`).join('\n'),
          '',
          'Decide which version must survive, apply it, and name the other one in your reply.'
        ].join('\n')
      : 'OVERLAPS: none — every changed file has exactly one writer.',
    '',
    'DIAGNOSTICS FOR ALL CHANGED FILES, TOGETHER (each task passed its own check; this is the whole-team view):',
    diagnosticLines(input.diagnostics),
    '',
    `AWAITING USER REVIEW (proposed, deliberately not written): ${fileList(input.awaitingReview)}`,
    '',
    'Fix only what the team broke BETWEEN its tasks — a renamed prop, a moved symbol, a signature two',
    'roles read differently. Add no new scope, and change no file outside the list above.',
    '',
    'Reply with the change itself, not a plan for it, then one line saying whether the pieces fit.'
  ];
  return sections.join('\n');
}

/**
 * The role for the closing turn. `coordinator` integrates and may repair; `reviewer`
 * reads and reports. Anything else falls back to the coordinator, since only these
 * two are allowed to see the whole change set at once.
 */
export function integrationRole(role: AgentRole | undefined): AgentRole {
  return role === 'reviewer' ? 'reviewer' : 'coordinator';
}

