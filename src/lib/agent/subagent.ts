import { streamChat, type ChatTurn } from '../ai';
import { getActiveProvider, getApiKey, getCustomBaseUrl, getSelectedModel } from '../storage';
import type { ToolDefinition, ToolOutcome } from './tools';

/**
 * Agent-interaction tools: spawn_subagent and ask_user.
 *
 * spawn_subagent runs a bounded helper agent in a SEPARATE context — its own
 * messages, its own tool loop (the real runToolRounds, imported lazily so the
 * registry can wire this module without an import cycle), its own round and
 * time caps. Only a SUMMARY + files-touched list returns to the main context;
 * the helper's transcript never leaks into it. By default the helper is
 * read-only (plan policy); writes require an explicit allowWrites and still
 * travel through the same verified tool path as the main agent.
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

export const MAX_SUBAGENT_ROUNDS = 12;
export const DEFAULT_SUBAGENT_ROUNDS = 8;
export const SUBAGENT_TIMEOUT_MS = 240_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 2_000;
const MAX_TASK_CHARS = 4_000;

/** One model turn for the helper. The host may inject its own (App's stream). */
export type SubagentStream = (messages: ChatTurn[], round: number) => Promise<{ text: string; error: string | null }>;

let injectedStream: SubagentStream | null = null;
export function configureSubagentStream(stream: SubagentStream | null): void {
  injectedStream = stream;
}

/** The default helper stream: the user's own BYOK provider, plain text protocol. */
function byokStream(signal: AbortSignal): SubagentStream | { error: string } {
  const provider = getActiveProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) return { error: 'spawn_subagent needs a configured provider key (BYOK). None is set — ask the user to add one in Settings. No helper was started.' };
  const model = getSelectedModel(provider);
  if (!model) return { error: `spawn_subagent: no model is selected for provider "${provider}". Ask the user to pick one in Settings.` };
  const baseUrl = provider === 'custom' ? getCustomBaseUrl() : undefined;
  if (provider === 'custom' && !baseUrl) return { error: 'spawn_subagent: the custom endpoint has no base URL configured.' };
  return async (messages) => {
    let text = '';
    let error: string | null = null;
    await streamChat(
      { provider, model, apiKey, baseUrl, messages, temperature: 0.2, signal },
      {
        onDelta: (delta) => { text += delta; },
        onError: (message) => { error = message; }
      }
    );
    return { text, error };
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

export async function handleSpawnSubagent(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) return refusal('spawn_subagent needs a task: one bounded, self-contained instruction.');
  if (task.length > MAX_TASK_CHARS) return refusal(`spawn_subagent tasks are capped at ${MAX_TASK_CHARS} characters — split the work.`);
  if (!workspaceId) return refusal('spawn_subagent needs an opened folder workspace.');
  const allowWrites = args.allowWrites === true;
  const requestedRounds = typeof args.maxRounds === 'number' && Number.isFinite(args.maxRounds) ? Math.trunc(args.maxRounds) : DEFAULT_SUBAGENT_ROUNDS;
  const maxRounds = Math.min(Math.max(requestedRounds, 1), MAX_SUBAGENT_ROUNDS);
  const focusFiles = Array.isArray(args.files)
    ? args.files.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 12)
    : [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
  try {
    const stream = injectedStream ?? byokStream(controller.signal);
    if (typeof stream !== 'function') return refusal(stream.error);
    // Lazy imports: the registry imports this module, and these modules import
    // the registry — dynamic import keeps the cycle out of module evaluation.
    const { runToolRounds } = await import('./toolLoop');
    const { describeTools } = await import('./tools');
    const { stripToolBlocks } = await import('./toolProtocol');

    const systemInstruction = [
      'You are a bounded helper agent working inside the user\'s opened folder. You have your own context; the main agent sees ONLY your final summary, so make it self-contained and factual.',
      `You have at most ${maxRounds} tool rounds and a hard time ceiling. Work efficiently: batch reads, then answer with the finish tool (summary = the report the main agent receives).`,
      allowWrites
        ? 'You MAY write files through the verified tool path, but only what the task asks for. List every file you changed in the summary.'
        : 'You are READ-ONLY: explore, read and report. Do not attempt writes — they will be refused. The main agent applies changes itself.',
      focusFiles.length > 0 ? `Focus files (start here): ${focusFiles.join(', ')}` : '',
      ...describeTools(maxRounds)
    ].filter(Boolean).join('\n');

    const messages: ChatTurn[] = [{ role: 'user', content: task }];
    const loop = await runToolRounds({
      messages,
      systemInstruction,
      workspaceId,
      stream: async (turns) => stream(turns, 0),
      maxRounds,
      aborted: () => controller.signal.aborted,
      signal: controller.signal,
      policy: { mode: allowWrites ? 'agent' : 'plan' }
    });

    const rawSummary = loop.finish?.summary ?? stripToolBlocks(loop.text);
    const summary = rawSummary.trim().length > MAX_SUBAGENT_SUMMARY_CHARS
      ? `${rawSummary.trim().slice(0, MAX_SUBAGENT_SUMMARY_CHARS)}…(summary bounded)`
      : rawSummary.trim();
    const filesRead = filesFromActivity(loop.activity as Array<{ name: string; ok?: boolean; input?: Record<string, unknown> | string }>);
    const lines = [
      `Subagent ${loop.error ? 'FAILED' : 'finished'} · ${loop.rounds}/${maxRounds} rounds · ${allowWrites ? 'write-capable' : 'read-only'}${loop.capped ? ' · budget-capped' : ''}${controller.signal.aborted ? ' · timed out/stopped' : ''}.`,
      'SUMMARY (the only part that enters the main context):',
      summary || '(the helper produced no summary)',
      `FILES READ: ${filesRead.length > 0 ? filesRead.join(', ') : '(none)'}`,
      `FILES CHANGED (tool-reported): ${loop.changedFiles}`
    ];
    if (loop.error) {
      lines.push(`ERROR: ${loop.error}`);
      return { ok: false, content: lines.join('\n'), error: loop.error, changedFiles: loop.changedFiles };
    }
    return { ok: true, content: lines.join('\n'), changedFiles: loop.changedFiles };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
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
    description: 'Run a bounded helper agent in an isolated context for a self-contained sub-task (read-only unless allowWrites:true).',
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
    allowWrites: { type: 'boolean', description: 'Allow verified disk writes (default false).' },
    maxRounds: { type: 'integer', description: 'Round cap (default 8, max 12).' }
  },
  required: ['task'],
  additionalProperties: false
};

export const INTERACTION_SCHEMAS: Record<string, Record<string, unknown>> = {
  ask_user: ASK_USER_SCHEMA,
  spawn_subagent: SPAWN_SUBAGENT_SCHEMA
};