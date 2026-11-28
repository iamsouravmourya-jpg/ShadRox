import { streamChat, type ChatTurn, type ChatToolDefinition } from '../ai';
import { getActiveProvider, getApiKey, getCustomBaseUrl, getSelectedModel } from '../storage';
import { scoutModelFor } from '../providers';
import type { ToolDefinition, ToolOutcome } from './tools';

/**
 * Agent-interaction tools: spawn_subagent and ask_user.
 *
 * spawn_subagent runs a bounded helper agent in a SEPARATE context — its own
 * messages, its own tool loop (the real runToolRounds, imported lazily so the
 * registry can wire this module without an import cycle), its own round and
 * time caps. Only a SUMMARY + files-touched list returns to the main context;
 * the helper's transcript never leaks into it. Scouts are STRICTLY read-only
 * (plan policy + a read-only toolset): writes, shell, git and recursion are all
 * refused at runtime, so a scout can only explore and report.
 *
 * ask_user PAUSES the loop: the handler's promise resolves only when the user
 * picks an option in the ChatPanel question card, dismisses it, or the timeout
 * fires — so a turn can never hang on an unanswered question. The renderer
 * wiring follows the PREVIEW_AGENT_CONTROL_EVENT CustomEvent pattern: this
 * module dispatches ASK_USER_EVENT, App.tsx listens and hands the prompt to
 * ChatPanel, and the pick calls answerPendingQuestion().
 */

/* ------------------------------------------------------------------ *
 * ask_user — the pause/resume broker.
 * ------------------------------------------------------------------ */

export const ASK_USER_EVENT = 'shadrox:ask-user';
export const ASK_USER_RESOLVED_EVENT = 'shadrox:ask-user-resolved';

export const ASK_USER_TIMEOUT_MS = 180_000;
export const ASK_USER_MAX_TIMEOUT_MS = 600_000;
const MAX_QUESTION_CHARS = 500;
const MAX_OPTION_CHARS = 120;

export interface AskUserPrompt {
  id: string;
  question: string;
  options: string[];
  createdAt: number;
}

export interface AskUserOutcome {
  answered: boolean;
  answer: string | null;
  reason: 'answered' | 'cancelled' | 'timeout' | 'no-ui';
}

interface PendingQuestion extends AskUserPrompt {
  resolve: (outcome: AskUserOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingQuestion>();
let questionSeq = 0;

/** The question the UI should currently show (newest), or null. */
export function getPendingAskUser(): AskUserPrompt | null {
  const newest = [...pending.values()].sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!newest) return null;
  const { id, question, options, createdAt } = newest;
  return { id, question, options, createdAt };
}

function settle(id: string, outcome: AskUserOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.timer !== null) clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(outcome);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(ASK_USER_RESOLVED_EVENT, { detail: { id, ...outcome } }));
  }
  return true;
}

/** The user's pick. Only an option that was actually offered is accepted. */
export function answerPendingQuestion(id: string, answer: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (!entry.options.includes(answer)) return false;
  return settle(id, { answered: true, answer, reason: 'answered' });
}

/** Dismiss/cancel: resolves the paused tool with a refusal, never a hang. */
export function cancelPendingQuestion(id: string): boolean {
  return settle(id, { answered: false, answer: null, reason: 'cancelled' });
}

export interface AskUserOptions {
  timeoutMs?: number;
  /** Test seam: replaces the window CustomEvent dispatch. */
  dispatch?: (prompt: AskUserPrompt) => void;
}

/**
 * Register one question and return the promise the tool handler awaits.
 * Exactly one question may be pending at a time — the caller refuses extras.
 */
export function requestUserAnswer(question: string, options: string[], opts: AskUserOptions = {}): Promise<AskUserOutcome> {
  const id = `ask-${++questionSeq}-${Date.now().toString(36)}`;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? ASK_USER_TIMEOUT_MS, 1_000), ASK_USER_MAX_TIMEOUT_MS);
  const prompt: AskUserPrompt = { id, question, options: [...options], createdAt: Date.now() };
  return new Promise<AskUserOutcome>((resolve) => {
    const entry: PendingQuestion = { ...prompt, resolve, timer: null };
    pending.set(id, entry);
    entry.timer = setTimeout(() => settle(id, { answered: false, answer: null, reason: 'timeout' }), timeoutMs);
    const dispatch = opts.dispatch
      ?? ((value: AskUserPrompt) => {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(ASK_USER_EVENT, { detail: value }));
        }
      });
    const hasUi = opts.dispatch !== undefined || (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function');
    if (!hasUi) {
      // Headless (tests, autonomous runs): no card can render, so resolve now
      // instead of parking the turn for the full timeout.
      settle(id, { answered: false, answer: null, reason: 'no-ui' });
      return;
    }
    dispatch(prompt);
  });
}

/** Test/host hook: drop every pending question (e.g. on Stop). */
export function clearPendingQuestions(reason: AskUserOutcome['reason'] = 'cancelled'): void {
  for (const id of [...pending.keys()]) settle(id, { answered: false, answer: null, reason });
}

function refusal(message: string): ToolOutcome {
  return { ok: false, content: '', error: message, refused: true };
}

export async function handleAskUser(_workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return refusal('ask_user needs a question.');
  if (question.length > MAX_QUESTION_CHARS) return refusal(`ask_user questions are capped at ${MAX_QUESTION_CHARS} characters.`);
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options = rawOptions.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  if (options.length < 2 || options.length > 4) return refusal('ask_user needs 2 to 4 options.');
  if (options.some((option) => option.length > MAX_OPTION_CHARS)) return refusal(`ask_user options are capped at ${MAX_OPTION_CHARS} characters each.`);
  if (new Set(options).size !== options.length) return refusal('ask_user options must be distinct.');
  if (getPendingAskUser()) return refusal('One question is already waiting for the user. Wait for its answer before asking another.');
  const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined;
  const outcome = await requestUserAnswer(question, options, { timeoutMs });
  if (outcome.answered && outcome.answer !== null) {
    return { ok: true, content: `The user chose: "${outcome.answer}". Continue with that answer; do not ask the same question again.` };
  }
  if (outcome.reason === 'timeout') {
    return refusal('The user did not answer the question before it timed out. Proceed with the safest reasonable default and say which assumption you made, or finish with what you have — do not re-ask immediately.');
  }
  if (outcome.reason === 'no-ui') {
    return refusal('ask_user cannot render a question card in this environment (no UI). Proceed with a stated assumption instead.');
  }
  return refusal('The user dismissed the question without choosing. Take that as "decide yourself": proceed with the safest reasonable default and state the assumption.');
}

/* ------------------------------------------------------------------ *
 * spawn_subagent — a bounded helper in a separate context.
 * ------------------------------------------------------------------ */

/** Hard cap on subagents running at once (Qoder/Kilo-style 2-scout model). */
export const MAX_CONCURRENT_SUBAGENTS = 2;
/** Isolated scout loop: bounded 5 rounds so deep exploration stays focused without bloating main context. */
export const MAX_SUBAGENT_ROUNDS = 5;
export const DEFAULT_SUBAGENT_ROUNDS = 5;
export const SUBAGENT_TIMEOUT_MS = 240_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 2_400;
/** How many times a scout that finishes with zero tool calls is re-nudged before being refused. */
export const ZERO_STEP_RETRIES = 2;
const ZERO_STEP_NUDGE = 'You returned without calling any read-only tool. Before you may finish, inspect real workspace files: call read_file, search_text, find_files, list_directory, outline, or problems on actual files, then call finish with your file:line findings.';
/** The read-only exploration toolset a scout may use — no writes, shell, git, or recursion. */
export const SUBAGENT_READ_ONLY_TOOLS: readonly string[] = [
  'read_file',
  'search_text',
  'find_files',
  'list_directory',
  'outline',
  'problems'
];
const MAX_TASK_CHARS = 4_000;

/* ------------------------------------------------------------------ *
 * Live activity events + abort propagation (Stop cancels scouts).
 * ------------------------------------------------------------------ */

export const SUBAGENT_EVENT = 'shadrox:subagent';

export interface SubagentProgress {
  /** Stable id for this scout across its lifecycle. */
  id: string;
  /** 1-based slot index when spawned in parallel (Agent 1 / Agent 2). */
  index?: 1 | 2;
  /** Concise card title derived from the task or focus paths. */
  title?: string;
  /** Short task label shown in the UI. */
  label: string;
  status: 'running' | 'done' | 'error';
  /** Live description of what tool/file the scout is currently reading or searching. */
  currentAction?: string;
  /** Total tool steps completed by this scout. */
  stepsCount?: number;
  /** Final crisp summary (done) or error message (error). */
  summary?: string;
}

function emitSubagent(detail: SubagentProgress): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(SUBAGENT_EVENT, { detail }));
  }
}

/** Every in-flight scout controller, so a Stop click aborts them all at once. */
const activeSubagents = new Set<AbortController>();
let runningSubagents = 0;
let subagentSeq = 0;

function deriveScoutTitle(task: string, focusFiles: string[]): string {
  const firstClause = task.split(/[\r\n.;:]+/)[0]?.trim() ?? task;
  const cleaned = firstClause.replace(/^analyze\s+|^inspect\s+|^explore\s+|^audit\s+/i, '').trim() || firstClause;
  if (cleaned.length <= 44) return cleaned;
  if (focusFiles.length > 0) {
    const lead = focusFiles[0].split('/').slice(-2).join('/');
    if (lead.length <= 44) return `Explore ${lead}`;
  }
  return `${cleaned.slice(0, 41).trim()}…`;
}

function describeScoutStep(name: string, args: Record<string, unknown>): string {
  const target = typeof args.path === 'string' && args.path.trim()
    ? args.path.trim()
    : typeof args.query === 'string' && args.query.trim()
      ? `"${args.query.trim().slice(0, 32)}"`
      : '';
  switch (name) {
    case 'read_file':
      return target ? `Reading ${target}` : 'Reading file';
    case 'search_text':
      return target ? `Searching ${target}` : 'Searching text';
    case 'find_files':
      return target ? `Finding files matching ${target}` : 'Finding files';
    case 'list_directory':
      return target ? `Listing ${target}` : 'Listing directory';
    case 'outline':
      return target ? `Outlining ${target}` : 'Reading file outline';
    case 'problems':
      return 'Checking diagnostics';
    case 'finish':
      return 'Compiling file:line report';
    default:
      return target ? `${name} ${target}` : name;
  }
}

/** Host hook (Stop / unmount): abort every running scout immediately. */
export function abortActiveSubagents(): void {
  for (const controller of activeSubagents) controller.abort();
  activeSubagents.clear();
}

/** One model turn for the helper. The host may inject its own (App's stream). */
export type SubagentStream = (messages: ChatTurn[], round: number, signal?: AbortSignal) => Promise<{ text: string; error: string | null }>;

let injectedStream: SubagentStream | null = null;
export function configureSubagentStream(stream: SubagentStream | null): void {
  injectedStream = stream;
}

/**
 * Retry budget for a scout's model call. A scout is a cheap, read-only helper
 * that runs in parallel with its siblings, so a flaky free-tier endpoint must
 * not burn the full writer budget (4 attempts / 30 s) on it: two quick attempts
 * inside 15 s, then the scout reports the error and the writer carries on. The
 * writer's own stream keeps the default budget.
 */
export const SCOUT_RETRY_BUDGET = { maxAttempts: 2, maxElapsedMs: 15_000 } as const;

/** The default helper stream: the user's own BYOK provider, plain text protocol. */
function byokStream(signal: AbortSignal, toolDefinitions?: ChatToolDefinition[]): SubagentStream | { error: string } {
  const provider = getActiveProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) return { error: 'spawn_subagent needs a configured provider key (BYOK). None is set — ask the user to add one in Settings. No helper was started.' };
  const mainModel = getSelectedModel(provider);
  if (!mainModel) return { error: `spawn_subagent: no model is selected for provider "${provider}". Ask the user to pick one in Settings.` };
  // Scouts are read-only and run in parallel: send them to the cheapest fast-tier
  // model the provider can serve, and fall back to the user's main model if that
  // cheaper one is unavailable. The single writer keeps the main (stronger) model.
  const scoutModel = scoutModelFor(provider, mainModel);
  const baseUrl = provider === 'custom' ? getCustomBaseUrl() : undefined;
  if (provider === 'custom' && !baseUrl) return { error: 'spawn_subagent: the custom endpoint has no base URL configured.' };
  const run = async (model: string, messages: ChatTurn[]) => {
    let text = '';
    let error: string | null = null;
    await streamChat(
      { provider, model, apiKey, baseUrl, messages, temperature: 0.2, signal, toolDefinitions, retry: SCOUT_RETRY_BUDGET },
      {
        onDelta: (delta) => { text += delta; },
        onToolCalls: (calls) => {
          // Native tool calls the scout made are re-emitted as text tool blocks so
          // the shared runToolRounds loop parses and executes them uniformly.
          const serialized = JSON.stringify(calls.map((call) => ({ name: call.name, args: call.arguments }))).replaceAll('`', '\\u0060');
          text += `\n\`\`\`shadrox:tools\n${serialized}\n\`\`\``;
        },
        onError: (message) => { error = message; }
      }
    );
    return { text, error };
  };
  return async (messages) => {
    const first = await run(scoutModel, messages);
    const modelUnavailable = first.error && scoutModel !== mainModel
      && /model|not found|404|unsupported|does not exist|invalid|unavailable/i.test(first.error);
    if (modelUnavailable) return run(mainModel, messages);
    return first;
  };
}

function filesFromActivity(activity: Array<{ name: string; ok?: boolean; input?: Record<string, unknown> | string }>): string[] {
  const paths = new Set<string>();
  for (const entry of activity) {
    if (!entry.ok || (entry.name !== 'read_file' && entry.name !== 'outline')) continue;
    const input = entry.input && typeof entry.input === 'object' ? entry.input as Record<string, unknown> : null;
    const path = input && typeof input.path === 'string' ? input.path : null;
    if (path) paths.add(path.replace(/\\/g, '/'));
  }
  return [...paths].slice(0, 40);
}

export interface SpawnSubagentOptions {
  signal?: AbortSignal;
  slotIndex?: 1 | 2;
  nested?: boolean;
}

export async function handleSpawnSubagent(
  workspaceId: string,
  args: Record<string, unknown>,
  options?: SpawnSubagentOptions
): Promise<ToolOutcome> {
  if (options?.nested) {
    return refusal('Nested spawn_subagent calls are refused — subagents cannot spawn further subagents.');
  }
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) return refusal('spawn_subagent needs a task: one bounded, self-contained instruction.');
  if (task.length > MAX_TASK_CHARS) return refusal(`spawn_subagent tasks are capped at ${MAX_TASK_CHARS} characters — split the work.`);
  if (!workspaceId) return refusal('spawn_subagent needs an opened folder workspace.');
  const requestedRounds = typeof args.maxRounds === 'number' && Number.isFinite(args.maxRounds) ? Math.trunc(args.maxRounds) : DEFAULT_SUBAGENT_ROUNDS;
  const maxRounds = Math.min(Math.max(requestedRounds, 1), MAX_SUBAGENT_ROUNDS);
  const focusFiles = Array.isArray(args.files)
    ? args.files.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 12)
    : [];

  // Hard concurrency cap: at most MAX_CONCURRENT_SUBAGENTS scouts run at once.
  // The tool loop already caps a single round's batch; this guards any other path.
  if (runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
    return refusal(
      `Subagent cap reached: at most ${MAX_CONCURRENT_SUBAGENTS} subagents run at once. `
      + 'Wait for a running scout to finish, then spawn this one again.'
    );
  }
  if (options?.signal?.aborted) {
    return refusal('Subagent stopped before starting.');
  }

  const subagentId = `scout-${++subagentSeq}-${Date.now().toString(36)}`;
  const slotIndex = options?.slotIndex ?? (runningSubagents === 0 ? 1 : 2);
  const title = deriveScoutTitle(task, focusFiles);
  const label = task.length > 80 ? `${task.slice(0, 79)}…` : task;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options?.signal) {
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  activeSubagents.add(controller);
  runningSubagents += 1;
  let stepsCount = 0;
  let currentAction = focusFiles.length > 0 ? `Inspecting ${focusFiles[0]}` : 'Starting scout exploration';
  emitSubagent({
    id: subagentId,
    index: slotIndex,
    title,
    label,
    status: 'running',
    currentAction,
    stepsCount
  });
  const timer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
  try {
    // Lazy imports: the registry imports this module, and these modules import
    // the registry — dynamic import keeps the cycle out of module evaluation.
    const { runToolRounds } = await import('./toolLoop');
    const { describeTools, nativeToolDefinitions } = await import('./tools');
    const { stripToolBlocks } = await import('./toolProtocol');

    // Scouts are strictly read-only: offer only the exploration toolset via an
    // advisory (read-only) context. The 'plan' policy + disallowSubagents below
    // are the runtime backstops that refuse any write/execute/external/spawn call.
    const readOnlyContext = {
      workspaceOpen: true,
      filePaths: [] as string[],
      previewActive: false,
      activeJobCount: 0,
      terminalAwaitingInput: false,
      checkpointCount: 0,
      turnIntent: 'advisory' as const,
      enabledBundles: new Set<string>(),
      unlockedBundles: new Set<string>(),
      isReadOnlyTurn: true
    };
    const toolLines = describeTools(maxRounds, [], [], readOnlyContext)
      .filter((line) => !line.startsWith('- unlock_tools') && !line.startsWith('- spawn_subagent') && !line.startsWith('SPECIALIZED TOOLS'));
    const readOnlyNativeDefinitions = nativeToolDefinitions(true, readOnlyContext)
      .filter((tool) => SUBAGENT_READ_ONLY_TOOLS.includes(tool.name));

    const stream = injectedStream ?? byokStream(controller.signal, readOnlyNativeDefinitions);
    if (typeof stream !== 'function') {
      emitSubagent({
        id: subagentId,
        index: slotIndex,
        title,
        label,
        status: 'error',
        currentAction: 'Configuration error',
        stepsCount,
        summary: stream.error
      });
      return refusal(stream.error);
    }

    const systemInstruction = [
      'You are a bounded, READ-ONLY scout agent working inside the user\'s opened folder. You have your own isolated context; the main agent sees ONLY your final summary, so make it self-contained and factual.',
      `You have at most ${maxRounds} tool rounds and a hard time ceiling. Work efficiently: batch reads, never stop after only listing directories — perform real read_file or search_text inspections on relevant files, then answer with the finish tool (summary = the report the main agent receives).`,
      'You are strictly READ-ONLY: explore with read_file, search_text, find_files, list_directory, outline, problems only. Writes, shell, git and spawning further subagents are all refused — the main agent applies changes itself.',
      'Return a CRISP, structured report of at most 300 words that cites exact file:line findings (e.g. `src/app.ts:42`) and concise symbol/line references. No preamble, no restating the task.',
      focusFiles.length > 0 ? `Focus files (start here): ${focusFiles.join(', ')}` : '',
      ...toolLines
    ].filter(Boolean).join('\n');

    const messages: ChatTurn[] = [{ role: 'user', content: task }];
    const runScout = async (msgs: ChatTurn[], rounds: number) => runToolRounds({
      messages: msgs,
      systemInstruction,
      workspaceId,
      stream: async (turns: ChatTurn[], round: number) => stream(turns, round, controller.signal),
      maxRounds: rounds,
      aborted: () => controller.signal.aborted,
      signal: controller.signal,
      disallowSubagents: true,
      onToolStep: (event) => {
        if (event.phase === 'start') {
          currentAction = describeScoutStep(event.call.name, event.call.args);
        } else {
          stepsCount += 1;
          currentAction = event.outcome?.ok
            ? describeScoutStep(event.call.name, event.call.args)
            : `Checked ${describeScoutStep(event.call.name, event.call.args)}`;
        }
        emitSubagent({
          id: subagentId,
          index: slotIndex,
          title,
          label,
          status: 'running',
          currentAction,
          stepsCount
        });
      },
      // Scouts are always read-only: 'plan' refuses every write/execute/external
      // effect at the runtime boundary, so allowWrites can never widen a scout.
      policy: { mode: 'plan' }
    });

    let loop = await runScout(messages, maxRounds);
    let zeroStepRetries = 0;
    // A scout that tries to finish without a single read-only tool call is
    // hallucinating from memory: nudge it to inspect real files and re-run,
    // then refuse if it still returns with zero tool calls.
    while (stepsCount === 0 && !controller.signal.aborted && zeroStepRetries < ZERO_STEP_RETRIES) {
      zeroStepRetries += 1;
      messages.push({ role: 'assistant', content: loop.text });
      messages.push({ role: 'user', content: ZERO_STEP_NUDGE });
      loop = await runScout(messages, Math.min(maxRounds, 3));
    }
    if (stepsCount === 0 && !controller.signal.aborted) {
      emitSubagent({
        id: subagentId,
        index: slotIndex,
        title,
        label,
        status: 'error',
        currentAction: 'Scout inspected no files',
        stepsCount: 0,
        summary: 'The scout did not inspect any files.'
      });
      return { ok: false, content: `Subagent inspected no files · ${loop.rounds}/${maxRounds} rounds (read-only scout).`, error: 'The scout returned without calling any read-only tool. It must read real workspace files first.', refused: true, changedFiles: 0 };
    }

    const stopped = controller.signal.aborted;
    const rawSummary = loop.finish?.summary ?? (loop.text ? stripToolBlocks(loop.text) : '');
    const summary = rawSummary.trim().length > MAX_SUBAGENT_SUMMARY_CHARS
      ? `${rawSummary.trim().slice(0, MAX_SUBAGENT_SUMMARY_CHARS)}…(summary bounded)`
      : rawSummary.trim();
    const filesRead = filesFromActivity(loop.activity as Array<{ name: string; ok?: boolean; input?: Record<string, unknown> | string }>);
    if (stopped) {
      emitSubagent({
        id: subagentId,
        index: slotIndex,
        title,
        label,
        status: 'error',
        currentAction: 'Stopped',
        stepsCount,
        summary: 'Stopped before it finished.'
      });
      return { ok: false, content: `Subagent stopped · ${loop.rounds}/${maxRounds} rounds.`, error: 'Subagent stopped.', refused: true };
    }
    const lines = [
      `Subagent ${loop.error ? 'FAILED' : 'finished'} · ${loop.rounds}/${maxRounds} rounds · read-only${loop.capped ? ' · budget-capped' : ''}.`,
      'SUMMARY (the only part that enters the main context):',
      summary || '(the helper produced no summary)',
      `FILES READ: ${filesRead.length > 0 ? filesRead.join(', ') : '(none)'}`,
      `FILES CHANGED (tool-reported): ${loop.changedFiles}`
    ];
    emitSubagent({
      id: subagentId,
      index: slotIndex,
      title,
      label,
      status: loop.error ? 'error' : 'done',
      currentAction: loop.error ? 'Scout failed' : 'Findings ready',
      stepsCount,
      summary: summary || undefined
    });
    if (loop.error) {
      lines.push(`ERROR: ${loop.error}`);
      return { ok: false, content: lines.join('\n'), error: loop.error, changedFiles: loop.changedFiles ?? 0 };
    }
    return { ok: true, content: lines.join('\n'), changedFiles: loop.changedFiles ?? 0 };
  } catch (error) {
    emitSubagent({
      id: subagentId,
      index: slotIndex,
      title,
      label,
      status: 'error',
      currentAction: 'Scout error',
      stepsCount,
      summary: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onParentAbort);
    }
    activeSubagents.delete(controller);
    runningSubagents = Math.max(0, runningSubagents - 1);
  }
}

/* ------------------------------------------------------------------ *
 * Registry surface.
 * ------------------------------------------------------------------ */

export const INTERACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'ask_user',
    description: 'Pause and ask the user ONE multiple-choice decision (2-4 options).',
    parameters: 'question: string, options: string[2-4], timeoutMs?: number'
  },
  {
    name: 'spawn_subagent',
    description: 'Run ONE read-only scout in an isolated context for a self-contained exploration sub-task (max 2 run at once; no recursion). Returns a crisp file:line summary only.',
    parameters: 'task: string, files?: string[], allowWrites?: boolean, maxRounds?: number'
  }
];

export const ASK_USER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Clear question for the user.' },
    options: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 4,
      description: '2-4 distinct short options.'
    },
    timeoutMs: { type: 'integer', description: 'Optional timeout ms (default 180000).' }
  },
  required: ['question', 'options'],
  additionalProperties: false
};

export const SPAWN_SUBAGENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Self-contained instruction for helper.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Focus file paths.' },
    allowWrites: { type: 'boolean', description: 'Deprecated: scouts are always read-only.' },
    maxRounds: { type: 'integer', description: 'Round cap (default 5, max 5).' }
  },
  required: ['task'],
  additionalProperties: false
};

export const INTERACTION_SCHEMAS: Record<string, Record<string, unknown>> = {
  ask_user: ASK_USER_SCHEMA,
  spawn_subagent: SPAWN_SUBAGENT_SCHEMA
};