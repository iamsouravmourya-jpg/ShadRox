import { classifyTurnIntent, type PermissionMode } from './agent/runPolicy';

/**
 * Decides whether a typed request runs in the direct single-agent tool loop
 * ('chat'), the autonomous milestone runner ('autonomy'), or the specialist
 * team ('team').
 *
 * Strict mode routing contract:
 *  - Specialist Team ('team') runs ONLY when the user explicitly selected Team mode.
 *    Prompt keywords ("team", "agent", "full-stack") or multi-area asks NEVER
 *    auto-escalate an Agent turn into Specialist Team.
 *  - Agent mode ('permissionMode === "agent"' / 'mode === "code"') ALWAYS runs in
 *    the fast, direct single-agent loop (Read -> Plan/Edit -> Scoped Verify).
 *  - Only explicit complex refinement ('mode === "complex"') escalates broad multi-step
 *    edits to the autonomous milestone runner.
 */

export type OrchestrationKind = 'chat' | 'autonomy' | 'team';

export interface OrchestrationInput {
  prompt: string;
  mode: 'code' | 'plan' | 'complex';
  /** Active permission mode chosen by the user ('ask' | 'plan' | 'agent' | 'team'). */
  permissionMode?: PermissionMode;
  /** Files currently known to the workspace. */
  workspaceFileCount: number;
  hasKey: boolean;
  /** Desktop shell plus an open folder: the engines cannot write without both. */
  canRun: boolean;
  /** A stream, run or team is already in flight. */
  busy: boolean;
}

export interface OrchestrationDecision {
  kind: OrchestrationKind;
  /** Why this kind was chosen. Empty for a direct single-agent turn. */
  reason: string;
}

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
  /\b(implement|build|add|create|refactor|migrate|upgrade|integrate|rewrite|convert|scaffold|wire|connect|fix|redesign|restructure|ship|deliver|decompose|harden|split)\b/i;
const QUESTION_START = /^(what|why|how|where|when|who|which|explain|describe|show|tell|is|are|does|do|can)\b/i;
const NO_EDIT = /\b(just (?:answer|explain|tell)|don'?t (?:edit|change|modify|touch)|no (?:edits?|changes?|code changes?)|read[-\s]?only)\b/i;
const BROAD_SCOPE = /\b(across|every|all|whole|entire|project[-\s]?wide|codebase|multiple files|monolith|decompose|audit\s+report)\b/i;
const EXPLICIT_PATH_COUNT_RE =
  /(?:^|[\s`'"(\[,])((?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s`'")\],:;?!])/g;

function areasIn(prompt: string): string[] {
  return AREA_WORDS.filter(([, pattern]) => pattern.test(prompt)).map(([name]) => name);
}

function explicitPathCount(prompt: string): number {
  const seen = new Set<string>();
  EXPLICIT_PATH_COUNT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_PATH_COUNT_RE.exec(prompt)) !== null) {
    seen.add(match[1].replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase());
  }
  return seen.size;
}

function structuredItemCount(prompt: string): number {
  return (prompt.match(/(?:^|\n)\s*(?:\d+[.)]\s+|#{1,4}\s+|[-*•]\s+)/g) ?? []).length;
}

function chat(): OrchestrationDecision {
  return { kind: 'chat', reason: '' };
}

export function decideOrchestration(input: OrchestrationInput): OrchestrationDecision {
  const prompt = input.prompt.trim();

  if (input.busy || !input.hasKey || !input.canRun) return chat();
  // Ask and Plan modes are strictly read-only — never route them into Team or Autonomy.
  if (input.mode === 'plan' || input.permissionMode === 'ask' || input.permissionMode === 'plan') return chat();
  if (prompt.length < 40) return chat();
  if (NO_EDIT.test(prompt)) return chat();
  if (QUESTION_START.test(prompt) && !ACTION.test(prompt)) return chat();
  if (input.permissionMode !== 'team' && classifyTurnIntent({ prompt }).kind !== 'execution') return chat();

  // Specialist Team runs ONLY when the user explicitly selected Team mode.
  if (input.permissionMode === 'team') {
    return {
      kind: 'team',
      reason: 'Team mode selected: coordinator and specialist agents will handle this task.'
    };
  }

  // Agent mode ('code' refine mode or explicit 'agent' permission mode) ALWAYS stays in the
  // direct single-agent loop (Read -> Plan/Edit -> Scoped Verify) — never auto-escalating.
  if (input.mode !== 'complex') {
    return chat();
  }

  const words = prompt.split(/\s+/).length;
  const areas = areasIn(prompt);
  const action = ACTION.test(prompt);
  const explicitPaths = explicitPathCount(prompt);
  const structuredItems = structuredItemCount(prompt);
  const broad = BROAD_SCOPE.test(prompt) || explicitPaths >= 4 || structuredItems >= 4;
  const UI_ONLY_AREAS = new Set(['frontend', 'UI']);
  const hasNonUiArea = areas.some((a) => !UI_ONLY_AREAS.has(a));
  const multiAreaOrMultiFile = (areas.length >= 2 && hasNonUiArea) || explicitPaths >= 2;
  const substantive = words >= 8 || broad || multiAreaOrMultiFile;

  if (action && substantive) {
    return {
      kind: 'autonomy',
      reason: 'Auto: complex multi-step change with real files to touch, so it will plan, edit and verify milestones.'
    };
  }

  return chat();
}
