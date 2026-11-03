/**
 * The team roster: who is on it, what each one owns, and how a task is phrased
 * for the agent that has to carry it out.
 *
 * The briefs are the whole point of having roles rather than one generic agent.
 * "Frontend" is not a label on a card; it is the sentence that keeps the agent
 * out of the backend while a different agent is editing it, which is what makes
 * a team more than a queue of unrelated edits.
 */

import type { AgentRole, AgentSpec, AgentStatus, TaskStatus, TeamState, TeamTask } from './types';

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

const BY_ROLE = new Map(TEAM_ROSTER.map((spec) => [spec.id, spec]));

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
