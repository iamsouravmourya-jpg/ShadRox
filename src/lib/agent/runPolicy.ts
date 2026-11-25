export type PermissionMode = 'ask' | 'plan' | 'agent' | 'team';

export type ToolEffect = 'read' | 'write' | 'execute' | 'external' | 'control';

export interface RequestScope {
  workspaceId: string;
  allowedPaths?: readonly string[];
  maxReadFiles?: number;
  maxReadBytes?: number;
}

export interface RunPolicy {
  mode: PermissionMode;
  scope?: RequestScope;
}

export function allowsEffect(mode: PermissionMode, effect: ToolEffect): boolean {
  if (effect === 'control' || effect === 'read') return true;
  return mode === 'agent' || mode === 'team';
}

export type ApplyHold = 'none' | 'auto-apply-off' | 'plan-approval' | 'permission-mode';

/**
 * Why a finished reply's changes are not going to disk by themselves.
 *
 * Auto-apply is a user preference and a plan gate is a run-level decision, so
 * neither can be allowed to override the permission mode: an ask or plan turn
 * stages its edits for review and stops there.
 */
export function holdReplyApply(input: {
  autoApplyChanges: boolean;
  awaitingPlanApproval: boolean;
  permissionMode: PermissionMode;
}): ApplyHold {
  if (!input.autoApplyChanges) return 'auto-apply-off';
  if (input.awaitingPlanApproval) return 'plan-approval';
  if (!allowsEffect(input.permissionMode, 'write')) return 'permission-mode';
  return 'none';
}

export function shouldGatePlanApproval(permissionMode: PermissionMode, stepCount: number, fileCount: number): boolean {
  if (allowsEffect(permissionMode, 'write')) return false;
  return stepCount > 2 || fileCount > 1;
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'plan' || value === 'agent' || value === 'team' ? value : 'ask';
}

export type TurnIntentKind = 'conversational' | 'advisory' | 'execution';

export type ToolBundleCategory =
  | 'core'
  | 'preview'
  | 'git'
  | 'delete'
  | 'web'
  | 'memory'
  | 'code_intel'
  | 'review'
  | 'jobs'
  | 'terminal'
  | 'interaction'
  | 'apply_patch'
  | 'mcp';

export interface TurnIntentInput {
  prompt: string;
  attachedFiles?: readonly string[];
  pinnedSymbols?: readonly unknown[];
  hasImage?: boolean;
  isSkill?: boolean;
  workspaceOpen?: boolean;
  previewActive?: boolean;
  activeJobCount?: number;
  terminalAwaitingInput?: boolean;
  hasActiveTerminal?: boolean;
  checkpointCount?: number;
  hasGitRepo?: boolean;
  webAvailable?: boolean;
  multiFileSignal?: boolean;
}

export interface TurnIntentResult {
  kind: TurnIntentKind;
  enabledBundles: Set<ToolBundleCategory>;
  writesFiles: boolean;
  skipVerify: boolean;
  effectivePermissionMode: PermissionMode;
  reason: string;
}

const PURE_CONVERSATIONAL_RE =
  /^(?:hi+|hello+|hey+|hii+|yo+|sup|good\s+(?:morning|afternoon|evening|night)|namaste|hola|thanks?(?:\s+you)?|thank\s+you(?:\s+(?:so|very)\s+much)?|thx|ty|ok(?:ay)?|cool|nice|great|awesome|got\s+it|sounds\s+good|sure|bye|goodbye|see\s+ya|how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|help|kya\s+haal(?:\s+hai)?|kaise\s+ho|shukriya|dhanyavaad|theek\s+hai|badhiya|mast)[.!?\s]*$/i;

const FILE_PATH_OR_EXT_RE =
  /(?:^|[\s`'"(\[,])(?:(?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+\.(?:[cm]?[jt]sx?|py|json|css|scss|sass|html|htm|md|yml|yaml|sql|sh|rs|go|toml|env|svg))(?=$|[\s`'")\],:;?!])/;

const STACK_OR_ERROR_RE =
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EADDRINUSE|TS\d{3,5}|UnhandledPromiseRejection)\b|(?:^|\n)\s*at\s+\S+\s+\([^)]+:\d+:\d+\)/m;

const CODEBASE_NOUN_RE =
  /\b(?:file|files|folder|directory|repo|repository|project|codebase|workspace|component|components|page|pages|route|routes|router|endpoint|endpoints|api|apis|server|backend|frontend|hook|hooks|function|class|module|package\.json|tsconfig|vite|next\.config|tailwind|css|html|svg|logo|icon|navbar|sidebar|footer|header|modal|preview|browser|console|dom|terminal|shell|command|debugger|breakpoint|call\s*stack|checkpoint|git|diff|branch|build|lint|typecheck|error|errors|bug|bugs|warning|warnings|crash|blank\s*(?:page|screen)?|white\s*screen|this\s+app|this\s+page|this\s+file|this\s+code|this\s+project|this\s+repo|is\s+app|yahan)\b/i;

const EXECUTION_IMPERATIVE_RE =
  /\b(?:implement|build|create|add|edit|modify|update|change|fix|repair|debug|refactor|rewrite|patch|write|replace|insert|extract|convert|delete|remove|rename|move|wire|connect|integrate|scaffold|setup|install|run|test|verify|start|stop|restart|design|style|make|generate|draw|(?<!-)render|optimize|clean|split|decompose|migrate|upgrade|deploy|commit|restore|revert|apply|banao|bana\s*de|kar\s*de|fix\s*kar|theek\s*kar|likh|badal|hata)\b/i;

const EXPLORATION_VERB_RE =
  /\b(?:scan|explore|inspect|check|find|search|list|read|open|trace|audit|review|explain|describe|summarize|walkthrough|overview|check\s*kar|dekho|samjhao)\b/i;

const NO_EDIT_GUARD_RE =
  /\b(?:just\s+(?:answer|explain|tell|review|plan|list|show)|don'?t\s+(?:edit|change|modify|touch|write)|do\s+not\s+(?:edit|change|modify|touch|write)|without\s+(?:editing|changing|modifying)|no\s+(?:edits?|changes?|code\s+changes?|writes?)|read[-\s]?only|plan\s+only)\b/i;

const PLAN_ASK_RE =
  /^(?:make|create|give|write|propose|draft|outline)\s+(?:a|an|me\s+a)?\s*(?:plan|architecture|roadmap|proposal|approach|design\s+doc)\b|\b(?:how\s+should\s+(?:we|i)|what\s+is\s+the\s+best\s+way\s+to|suggest\s+(?:an?\s+)?(?:approach|plan|architecture)|architectural\s+plan)\b/i;

const QUESTION_LEAD_RE =
  /^(?:what|why|how|where|when|who|which|explain|describe|summarize|review|audit|compare|walkthrough|overview|scan|explore|list|show|tell|can\s+you\s+(?:explain|show|tell|describe|summarize|review|list|trace|help\s+me\s+understand)|is|are|does|do)\b/i;

const INTERROGATIVE_QA_LEAD_RE =
  /^(?:why|what|how|when|where|which|who|is|are|does|do|explain|describe)\b/i;

const POLITE_OR_ACTION_REQUEST_RE =
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:fix|edit|update|change|add|create|build|implement|patch|refactor|write|delete|remove|run|test|verify|start|stop|restart|install|make|rename|move|wire|connect|integrate)\b|\b(?:and\s+(?:fix|edit|update|change|add|create|build|implement|patch|refactor|write|delete|remove|rename|move|wire|connect|integrate|apply)|fix\s+it|update\s+it|patch\s+it|please\s+(?:fix|edit|update|change|add|create|build|implement|patch|refactor|write|delete|remove|run|test|verify))\b/i;

const FRAMEWORK_OR_CODE_QA_RE =
  /\b(?:react|next\.?js|vue|svelte|angular|solid|astro|vite|webpack|typescript|javascript|node\.?js|express|prisma|drizzle|tailwind|redux|zustand|useeffect|usestate|usememo|usecallback|useref|usecontext|strict\s*mode|hydrat(?:e|ion)|re-?render(?:s|ing)?|ssr|csr|rsc|jsx|tsx|async|await|promise|middleware|cors|jwt|oauth|dom|state|props|effect|memo)\b|\bmy\s+(?:app|code|component|hook|effect|state|build|server|api|query|route)\b/i;

const GENERAL_CONCEPTUAL_QA_RE =
  /^(?:what\s+(?:is|are)|why\s+(?:does|do|is|are)|how\s+(?:does|do|can\s+i)|explain|describe|compare|difference\s+between)\b/i;

const META_FOLLOWUP_RE =
  /(?:\b(?:kyu|kyun|kyon)\s+(?:nhi|nahi|nai)\s+(?:kar|kiya|kr|hua|ho)|^(?:why\s+(?:didn'?t|did\s+not|aren'?t|are\s+not|haven'?t|wouldn'?t)\s+you|why\s+did\s+you\s+(?:just|stop|ignore|skip|reply|respond|wait)|what\s+were\s+you\s+doing)\b|\b(?:kya\s+kar\s+raha\s+(?:tha|hai)|kyu\s+bol\s+raha|pehle\s+(?:kyu|kyon)\s+(?:nhi|nahi)\s+kiya|tune\s+(?:kyu|kyon)\s+(?:nhi|nahi)|tumne\s+(?:kyu|kyon)\s+(?:nhi|nahi)|ab\s+(?:jakar|jaake)\s+hua|aise\s+kyu\s+kiya)\b)/i;

const BUNDLE_RULES: Array<[ToolBundleCategory, RegExp]> = [
  ['preview', /\b(?:preview|ui|ux|css|tailwind|style|layout|blank|white\s*screen|screenshot|render|console|dom|viewport|responsive|navbar|sidebar|modal|button|logo|svg|icon|page|route|component|visual|animation|dark\s*mode|theme|frontend)\b/i],
  ['git', /\b(?:git|commit|commits|branch|branches|diff|staged|unstaged|merge|rebase|stash|blame)\b/i],
  ['delete', /\b(?:delete|remove|rm|unlink|drop\s+file)\b/i],
  ['web', /\b(?:web|search\s+(?:online|web|google|docs)|internet|url|https?:\/\/|fetch|documentation|mdn|npm\s+package|latest\s+version)\b/i],
  ['memory', /\b(?:memory|remember|project\.md|note\s+for\s+future|conventions?)\b/i],
  ['code_intel', /\b(?:references?|usages?|definition|go\s+to\s+def|rename\s+symbol|semantic\s+search|callers|where\s+is\s+\S+\s+used|refactor)\b/i],
  ['review', /\b(?:diff\s*review|code\s*review|review\s+(?:my|the|this)\s+(?:diff|changes)|audit\s+diff)\b/i],
  ['jobs', /\b(?:background\s+job|jobs|job_control|running\s+server|dev\s+server|port\s+already\s+in\s+use|eaddrinuse|kill\s+server)\b/i],
  ['terminal', /\b(?:terminal|pty|stdin|waiting\s+for\s+input|interactive\s+prompt|answer\s+prompt)\b/i],
  ['interaction', /\b(?:ask\s+me|subagents?|spawn[_\s]+(?:sub)?agents?|spawn\s+agent|delegate|use\s+(?:sub)?agents?|(?:parallel|multiple|2|two|do)\s+(?:sub)?agents?|swarm|scouts?)\b/i],
  ['apply_patch', /\b(?:multi[-\s]?file|across\s+files|refactor|migrate|patch|apply_patch|full[-\s]?stack|end[-\s]?to[-\s]?end)\b/i],
  ['mcp', /\b(?:mcp|external\s+tool|connector|plugin)\b/i]
];

const MULTI_DIR_PATH_RE = /(?:^|[\s`'"(\[,])((?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+)(?=$|[\s`'")\],:;?!])/g;
const MULTI_MODULE_CUE_RE = /\b(?:across\s+(?:modules|folders|directories|files)|multi[-\s]?(?:file|module)|multiple\s+(?:modules|directories|folders|files|components|pages)|both\s+(?:frontend|client|backend|server)\s+and\s+(?:frontend|client|backend|server))\b/i;

function hasMultiDirectoryOrModuleCue(prompt: string): boolean {
  if (MULTI_MODULE_CUE_RE.test(prompt)) return true;
  const dirs = new Set<string>();
  let match: RegExpExecArray | null;
  MULTI_DIR_PATH_RE.lastIndex = 0;
  while ((match = MULTI_DIR_PATH_RE.exec(prompt)) !== null) {
    const clean = match[1].replace(/^\.\//, '');
    const slash = clean.lastIndexOf('/');
    if (slash > 0) dirs.add(clean.slice(0, slash).toLowerCase());
    if (dirs.size >= 2) return true;
  }
  return false;
}

export function detectIntentToolBundles(input: TurnIntentInput): Set<ToolBundleCategory> {
  const bundles = new Set<ToolBundleCategory>(['core']);
  const prompt = input.prompt.trim();

  if (input.previewActive) bundles.add('preview');
  if ((input.activeJobCount ?? 0) > 0) bundles.add('jobs');
  if (input.terminalAwaitingInput) bundles.add('terminal');
  const multiCue = Boolean(input.multiFileSignal) || hasMultiDirectoryOrModuleCue(prompt);
  if (multiCue) bundles.add('apply_patch');
  // Multi-file / multi-module work is exactly when parallel read-only scouts pay
  // off: auto-enable the interaction bundle (spawn_subagent) without bloating the
  // lean core bundle every other execution turn carries.
  if (multiCue) bundles.add('interaction');

  for (const [bundle, pattern] of BUNDLE_RULES) {
    if (!pattern.test(prompt)) continue;
    if (bundle === 'web' && input.webAvailable === false) continue;
    if (bundle === 'git' && input.hasGitRepo === false) continue;
    bundles.add(bundle);
  }
  return bundles;
}

export function classifyTurnIntent(input: TurnIntentInput): TurnIntentResult {
  const prompt = input.prompt.trim();
  const hasAttachments =
    (input.attachedFiles?.length ?? 0) > 0 ||
    (input.pinnedSymbols?.length ?? 0) > 0 ||
    input.hasImage === true ||
    input.isSkill === true;
  const hasConcreteFileOrStackCue =
    hasAttachments ||
    FILE_PATH_OR_EXT_RE.test(prompt) ||
    STACK_OR_ERROR_RE.test(prompt) ||
    prompt.includes('`');

  if (
    !hasConcreteFileOrStackCue &&
    META_FOLLOWUP_RE.test(prompt) &&
    !POLITE_OR_ACTION_REQUEST_RE.test(prompt)
  ) {
    return {
      kind: 'conversational',
      enabledBundles: new Set<ToolBundleCategory>(),
      writesFiles: false,
      skipVerify: true,
      effectivePermissionMode: 'ask',
      reason: 'meta follow-up about assistant behavior without workspace action'
    };
  }

  const hasFileOrCodeCue =
    hasConcreteFileOrStackCue ||
    CODEBASE_NOUN_RE.test(prompt) ||
    FRAMEWORK_OR_CODE_QA_RE.test(prompt);

  if (!hasFileOrCodeCue) {
    if (!prompt || PURE_CONVERSATIONAL_RE.test(prompt)) {
      return {
        kind: 'conversational',
        enabledBundles: new Set<ToolBundleCategory>(),
        writesFiles: false,
        skipVerify: true,
        effectivePermissionMode: 'ask',
        reason: 'pure conversational greeting or acknowledgement'
      };
    }
    if (
      GENERAL_CONCEPTUAL_QA_RE.test(prompt) &&
      !EXECUTION_IMPERATIVE_RE.test(prompt) &&
      !EXPLORATION_VERB_RE.test(prompt)
    ) {
      return {
        kind: 'conversational',
        enabledBundles: new Set<ToolBundleCategory>(),
        writesFiles: false,
        skipVerify: true,
        effectivePermissionMode: 'ask',
        reason: 'general conceptual Q&A without workspace cues'
      };
    }
  }

  const enabledBundles = detectIntentToolBundles(input);

  if (NO_EDIT_GUARD_RE.test(prompt) || PLAN_ASK_RE.test(prompt)) {
    return {
      kind: 'advisory',
      enabledBundles,
      writesFiles: false,
      skipVerify: true,
      effectivePermissionMode: 'ask',
      reason: 'read-only advisory or planning request'
    };
  }

  if (
    ((QUESTION_LEAD_RE.test(prompt) || EXPLORATION_VERB_RE.test(prompt)) && !EXECUTION_IMPERATIVE_RE.test(prompt)) ||
    (INTERROGATIVE_QA_LEAD_RE.test(prompt) && !POLITE_OR_ACTION_REQUEST_RE.test(prompt))
  ) {
    return {
      kind: 'advisory',
      enabledBundles,
      writesFiles: false,
      skipVerify: true,
      effectivePermissionMode: 'ask',
      reason: 'workspace exploration or explanation without mutation intent'
    };
  }

  return {
    kind: 'execution',
    enabledBundles,
    writesFiles: true,
    skipVerify: false,
    effectivePermissionMode: 'agent',
    reason: 'execution, build, debug, or modification intent'
  };
}