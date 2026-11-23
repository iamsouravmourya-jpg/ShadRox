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
  /\b(implement|build|add|create|refactor|migrate|upgrade|integrate|rewrite|convert|scaffold|wire|connect|fix|redesign|restructure|ship|deliver|decompose|harden|split)\b/i;
const QUESTION_START = /^(what|why|how|where|when|who|which|explain|describe|show|tell|is|are|does|do|can)\b/i;
const NO_EDIT = /\b(just (?:answer|explain|tell)|don'?t (?:edit|change|modify|touch)|no (?:edits?|changes?|code changes?)|read[-\s]?only)\b/i;
const BROAD_SCOPE = /\b(across|every|all|whole|entire|project[-\s]?wide|codebase|multiple files|monolith|decompose|audit\s+report)\b/i;
const EXPLICIT_PATH_COUNT_RE =
  /(?:^|[\s`'"(\[,])((?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s`'")\],:;?!])/g;
const CROSS_CUTTING_RE =
  /\b(?:decompose|modulariz\w+|monolith|security\s+hardening|version\s+bump|cross[-\s]?cutting|workstream|subsystem|architecture\s+upgrade|audit\s+fix)\b/i;

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
  const explicitPaths = explicitPathCount(prompt);
  const structuredItems = structuredItemCount(prompt);
  const broad = BROAD_SCOPE.test(prompt) || explicitPaths >= 4 || structuredItems >= 4;
  const crossCutting = CROSS_CUTTING_RE.test(prompt) || explicitPaths >= 6 || structuredItems >= 5;
  const explicitTeam = TEAM_WORDS.test(prompt);

  // UI-only areas (frontend, UI) describe a single domain. A prompt whose every
  // detected area is UI/frontend is a single-component UI task — it stays in
  // single-agent (chat/autonomy) mode and is never handed to a 5-role team
  // that would spin up unnecessary backend/database/auth specialists.
  const UI_ONLY_AREAS = new Set(['frontend', 'UI']);
  const hasNonUiArea = areas.some((a) => !UI_ONLY_AREAS.has(a));
  const uiOnly = areas.length > 0 && !hasNonUiArea;

  // Multi-area or multi-file requests escalate even when the prompt is short:
  // "login add karo aur dashboard bhi" touches auth + UI + files, which is
  // real multi-area work even in Hindi/Hinglish.
  const multiAreaOrMultiFile = (areas.length >= 2 && hasNonUiArea) || explicitPaths >= 2;

  // Explicit team wording always goes to the team. Otherwise, multi-area work
  // goes to the team ONLY when it is not a cross-cutting mega-refactor spanning
  // 6+ files or 5+ numbered/bulleted workstreams (which autonomous runs handle
  // cleanly without 4-role ownership collisions). UI-only prompts never form a
  // team — there are no backend/database tasks to distribute.
  const wantsTeam = explicitTeam || (action && areas.length >= 3 && hasNonUiArea && words >= 18 && !crossCutting && !uiOnly);
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
  // Multi-area or multi-file work is substantive even at lower word counts.
  const substantive = input.mode === 'complex'
    ? words >= 8
    : words >= 28 || broad || multiAreaOrMultiFile;
  if (action && substantive && (broad || multiAreaOrMultiFile || input.workspaceFileCount >= 8 || input.mode === 'complex')) {
    return {
      kind: 'autonomy',
      reason: 'Auto: multi-step change with real files to touch, so it will plan, edit and verify milestones.'
    };
  }

  return chat();
}
