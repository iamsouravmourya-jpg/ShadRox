/**
 * Decides whether a typed request should stay a normal chat turn or be handed
 * to the autonomous run / agent-team engines. It is deliberately deterministic:
 * an extra model round-trip just to classify a prompt would add cost and latency
 * to every message, and the signals below are the ones that actually distinguish
 * a multi-step, multi-area job from a question or a one-file edit.
 *
 * The decision is advisory. The caller still gates on key, workspace, quota and
 * budget, and the chat shows the returned reason so an escalation is never
 * silent.
 */

export type OrchestrationKind = 'chat' | 'autonomy' | 'team';

export interface OrchestrationInput {
  prompt: string;
  mode: 'code' | 'plan' | 'complex';
  /** Files currently known to the workspace; a tiny workspace rarely needs a team. */
  workspaceFileCount: number;
  hasKey: boolean;
  /** Desktop shell plus an open folder: the engines cannot write without both. */
  canRun: boolean;
  /** A stream, run or team is already in flight. */
  busy: boolean;
}

export interface OrchestrationDecision {
  kind: OrchestrationKind;
  /** Why this kind was chosen. Empty for a normal chat turn. */
  reason: string;
}

const TEAM_WORDS =
  /\b(team|agents?|multi[-\s]?agent|frontend.{0,40}backend|backend.{0,40}frontend|full[-\s]?stack|end[-\s]?to[-\s]?end|coordinator|specialists?)\b/i;
const AREA_WORDS: Array<[string, RegExp]> = [
  ['frontend', /\bfront[-\s]?end\b/i],
  ['backend', /\bback[-\s]?end\b/i],
  ['API', /\bapis?\b/i],
  ['UI', /\bui\b/i],
  ['database', /\b(database|schema|migration)\b/i],
  ['tests', /\btests?\b/i],
  ['auth', /\bauth(?:entication|orization)?\b/i],
  ['docs', /\bdocs?\b|\bdocumentation\b/i]
];
const ACTION =
  /\b(implement|build|add|create|refactor|migrate|upgrade|integrate|rewrite|convert|scaffold|wire|connect|fix|redesign|restructure|ship|deliver)\b/i;
const QUESTION_START = /^(what|why|how|where|when|who|which|explain|describe|show|tell|is|are|does|do|can)\b/i;
const NO_EDIT = /\b(just (?:answer|explain|tell)|don'?t (?:edit|change|modify|touch)|no (?:edits?|changes?|code changes?)|read[-\s]?only)\b/i;
const BROAD_SCOPE = /\b(across|every|all|whole|entire|project[-\s]?wide|codebase|multiple files)\b/i;

function areasIn(prompt: string): string[] {
  return AREA_WORDS.filter(([, pattern]) => pattern.test(prompt)).map(([name]) => name);
}

function chat(): OrchestrationDecision {
  return { kind: 'chat', reason: '' };
}

export function decideOrchestration(input: OrchestrationInput): OrchestrationDecision {
  const prompt = input.prompt.trim();

  if (input.busy || !input.hasKey || !input.canRun) return chat();
  // Plan mode is read-only by contract; handing it to an engine that writes
  // files would break the one promise that mode makes.
  if (input.mode === 'plan') return chat();
  if (prompt.length < 40) return chat();
  if (NO_EDIT.test(prompt)) return chat();
  // A pure question stays a question even when it is long.
  if (QUESTION_START.test(prompt) && !ACTION.test(prompt)) return chat();

  const words = prompt.split(/\s+/).length;
  const areas = areasIn(prompt);
  const action = ACTION.test(prompt);
  const broad = BROAD_SCOPE.test(prompt);

  const wantsTeam = TEAM_WORDS.test(prompt) || (action && areas.length >= 3 && words >= 18);
  if (wantsTeam) {
    return {
      kind: 'team',
      reason:
        areas.length >= 2
          ? `Auto: this spans ${areas.join(', ')}, so a coordinator and specialists will split it.`
          : 'Auto: this needs coordinated specialists, so a coordinator will split the work.'
    };
  }

  // A one-liner edit ("fix this", "add a button") is chat; the engines are for
  // work with enough moving parts that planning and verification pay for themselves.
  const substantive = input.mode === 'complex' ? words >= 8 : words >= 28 || broad;
  if (action && substantive && (broad || input.workspaceFileCount >= 8 || input.mode === 'complex')) {
    return {
      kind: 'autonomy',
      reason: 'Auto: multi-step change with real files to touch, so it will plan, edit and verify milestones.'
    };
  }

  return chat();
}
