import type { ChatTurn } from '../ai';
import { availableToolNames, classifyToolEffect, isControlTool, isKnownTool, MAX_CALLS_PER_ROUND, runTool, summarizeCall, TOOL_DEFINITIONS, type ToolCall, type ToolOutcome } from './tools';
import type { McpToolHandle } from './mcpTools';
import { parseToolBlocks, serializeCallKey, serializeResults, stripToolBlocks } from './toolProtocol';
import { applyTaskUpdates, completionGuard, renderTaskPlan, type TaskPlan } from './taskPlan';
import { FINISH_TOOL_NAME, parseFinishDetails, renderFinishSummary } from './finishTool';
import { allowsEffect, type RunPolicy, type ToolEffect } from './runPolicy';
import type { AttemptRecord, AttemptState } from '../taskUsage';
import type { FailureReceipt } from '../repairProof';
import { flightRecorder } from '../observability/flightRecorder';
import { toolErrorCode } from '../observability/failureTaxonomy';
import { getDesktopBridge } from '../desktop';
import {
  beginTurn, endTurn, hasMutations, isDocsOnlyTurn, changedPathList, noteRead, noteWrite, noteUnknownWrite,
  noteVerification, needsVerification, satisfyingVerification, verificationDemand, type AgentTurnState
} from './turnState';
import { detectScaffoldIntent, detectAddPageIntent, scaffoldNudge, addPageNudge, previewNudge } from './scaffold';
import { compactToolObservations, upsertWorkingMemory, type WorkingMemoryState } from './loopContext';
import { createFailureRepeatTracker, failureNudge, failureBlockMessage } from './stuck';
import { ensureTurnCheckpoint } from './checkpoints';
import { isVerifyCommand } from './verifyProject';
import { confinePatches, isInsideWorkspaceRoot } from '../autonomy/confinement';
import type { ToolExecutionEvent } from '../autonomy/types';

/**
 * Runs the tool rounds of one assistant turn.
 *
 * The caller supplies `stream`, so this stays a pure control loop: the same code
 * drives a chat turn and a headless autonomous milestone, and the tests can drive
 * it with a scripted fake instead of a paid provider call.
 *
 * Disk tools stay explicit; the only processes that run here are the one-line
 * shell command the user asked for and an external MCP tool they configured.
 *
 * Phase 0 discipline (owner-approved):
 *  - 60 rounds, one soft wrap-up note at 80%, hard stop keeps forceFinal and
 *    exposes a resumable state summary so a Continue button can pick up later.
 *  - Stuck detection is PROGRESS-based, not repetition-based: 8 consecutive
 *    steps with zero progress signals AND no new information earn one nudge,
 *    then forceFinal. Repeating a call is not a crime — seeing nothing new is.
 *  - Duplicate calls are NEVER refused. A result cache keyed by the serialized
 *    call returns the earlier result prefixed "[unchanged since step N]", and
 *    entries are invalidated by content hash / mutation epoch — never by refusal.
 *  - Every boundary lands in the local flight recorder, fail-open.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 60;
/** Consecutive zero-progress, zero-new-information steps before the nudge. */
export const ZERO_PROGRESS_LIMIT = 8;
/** Consecutive unparseable tool rounds before forcing a clean text answer. */
const MAX_CONSECUTIVE_PARSE_FAILURES = 3;
/** The soft wrap-up note lands at this share of the budget, once. */
const BUDGET_NOTE_SHARE = 0.8;
/** The per-round cap lives in tools.ts so the prompt prose shares it; re-exported for callers. */
export { MAX_CALLS_PER_ROUND };
const FINAL_ASK =
  'Tool budget for this answer is finished. Write the final answer now using what you have read; name any file you did not get to instead of guessing about it.';

/** A port conflict that killing cannot fix: the port is fixed in the project's own config. */
const PORT_LOOP_ERROR = /port\s*\d*\s*(?:is\s+)?already\s+in\s+use|eaddrinuse|address\s+already\s+in\s+use/i;

const PORT_LOOP_ADVICE =
  'Killing or restarting processes cannot fix this: the port is fixed in the project\'s own code/config (vite.config, server.ts, .env, package.json), so every restart re-claims it and fails the same way. Stop killing ports — read the file that binds the port, change it to a free port (or serve the app through preview_control), and verify once.';

function isPortLoopFailure(outcome: ToolOutcome): boolean {
  return PORT_LOOP_ERROR.test(`${outcome.error ?? ''}\n${outcome.content}`);
}

const softBudgetNote = (round: number, maxRounds: number): string =>
  `Step budget nearly spent (${round}/${maxRounds} rounds used) — wrap up: land the remaining change, or call finish with what you have. Do not start new explorations.`;

/**
 * Workspace-exploration intent: the asks that must not be answered from memory.
 * Deliberately narrow verbs plus codebase objects, so "why does this line
 * throw?" keeps its old single-round path.
 */
const EXPLORATION_INTENT =
  /\b(scan|explore|walkthrough|overview|explain|analys[ei]s?\w*|analyz\w*|what (is|does) (this|the) (project|codebase|repo\w*|folder|application|app))\b/i;

const EXPLORATION_NUDGE =
  'You have not inspected the workspace yet. Use the read/search tools to examine the code before answering.';

export const MUTATION_REQUIRED_NUDGE =
  'Verification blocked: You have not applied any file edits yet. Call edit_file, apply_patch, or write_file now before finishing.';

export type ToolLoopStopReason =
  | 'complete'
  | 'finish'
  | 'step_cap'
  | 'stuck'
  | 'provider_error'
  | 'aborted'
  | 'no_workspace';

/**
 * The resumable state summary a hard stop carries. The UI owner wires a
 * Continue button to this: re-run `runToolRounds` with these messages, the
 * same plan, and a fresh budget. Nothing here is UI — it is pure data.
 */
export interface ToolLoopResumeState {
  /** The full transcript as the stop left it, observations and nudges included. */
  messages: ChatTurn[];
  /** Rounds spent when the stop landed. */
  round: number;
  /** What the turn was still trying to do: first open task, else the user's ask. */
  pendingIntent: string;
  plan: TaskPlan;
  maxRounds: number;
  stopReason: ToolLoopStopReason;
}

const RESUMABLE_STOPS = new Set<ToolLoopStopReason>(['step_cap', 'stuck', 'aborted', 'provider_error']);

export interface ToolActivity {
  name: string;
  label: string;
  ok: boolean;
  error?: string;
  input?: Record<string, unknown> | string;
  output?: string;
  durationMs?: number;
  stage?: 'reading' | 'planning' | 'editing' | 'checking' | 'completed' | 'failed';
  /** The guard stopped the call before it ran; nothing failed on disk. */
  refused?: boolean;
}

export interface ToolLoopResult {
  /** The reply the user reads: the last round with any tool fence removed. */
  text: string;
  rounds: number;
  activity: ToolActivity[];
  /** True when the loop still wanted another round but the cap or the abort cut it off. */
  capped: boolean;
  error: string | null;
  /** The task plan as the turn left it; empty when the model never planned. */
  plan: TaskPlan;
  /** Set when the turn ended with the finish tool instead of with prose. */
  finish?: { summary: string; blocked: string | null };
  /** Latest captured command failure, so the chat card can show it. */
  failureProof?: FailureReceipt | null;
  /** Successful workspace-mutating calls across the turn (write_file, edit_file, apply_patch, delete_file, run_command, external MCP). */
  changedFiles: number;
  /** Exact normalized paths mutated on disk by write tools during the loop. */
  changedPaths?: string[];
  /** Exact normalized paths created on disk by write tools during the loop. */
  createdPaths?: string[];
  /** Structured telemetry of tools invoked during the loop. */
  toolEvents?: ToolExecutionEvent[];
  /** Why the loop stopped; always set by this implementation. */
  stopReason?: ToolLoopStopReason;
  /** Present on hard stops (cap, stuck, abort): the data a Continue button resumes from. */
  resume?: ToolLoopResumeState;
}

export interface ToolLoopInput {
  messages: ChatTurn[];
  systemInstruction?: string;
  workspaceId: string | null;
  /** Streams one model turn. `round` is 0 for the first call. */
  stream: (messages: ChatTurn[], round: number) => Promise<{ text: string; error: string | null }>;
  maxRounds?: number;
  aborted: () => boolean;
  onRound?: (round: number, text: string) => void;
  /**
   * Lands the round's proposed edit fences on disk BEFORE its tool calls run,
   * so run_command and problems observe the change the model just made. The
   * host owns dedupe against its final apply pass; the loop only awaits it.
   */
  applyRoundPatches?: (text: string, round: number) => Promise<void>;
  onStatus?: (status: string) => void;
  /** Lets a headless run keep a plan across milestones. */
  initialPlan?: TaskPlan;
  onPlan?: (plan: TaskPlan) => void;
  /** User-configured MCP tools; discovered once per turn, not once per round. */
  external?: McpToolHandle;
  /** When present, effectful calls are refused unless the mode allows them. */
  policy?: RunPolicy;
  /** Linked cancellation: checked before each stream/dispatch and after awaits. */
  signal?: AbortSignal;
  /** Records every provider attempt the loop dispatches, with honest usage. */
  onAttempt?: (record: AttemptRecord) => void;
  /** Model-scaled character budget for mid-loop observation compaction. */
  loopContextBudgetChars?: number;
  /** When set, confines write-effect tools to declared paths plus brand-new in-workspace files. */
  expectedFiles?: string[];
  /** Probes whether an unlisted path already exists on disk for write confinement. */
  existsOnDisk?: (path: string) => Promise<boolean>;
  /** Pending requirements carried into the pinned working-memory scratchpad. */
  initialRequirements?: string[];
  /** When true, intercepts zero-write completion or finish once with MUTATION_REQUIRED_NUDGE. */
  requireFileMutation?: boolean;
}

/* ------------------------------------------------------------------ *
 * Progress tracking + result cache helpers.
 * ------------------------------------------------------------------ */

/** FNV-1a: a fast, stable, dependency-free content fingerprint. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The workspace paths a call names, so a mutation can invalidate precisely. */
function pathsOf(call: ToolCall): string[] {
  const paths: string[] = [];
  const single = normalizePath(call.args.path);
  if (single) paths.push(single);
  if (Array.isArray(call.args.paths)) {
    for (const entry of call.args.paths) {
      const path = normalizePath(entry);
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** All paths a write-effect call targets, including apply_patch hunks/patches. */
function writePathsOf(call: ToolCall): string[] {
  const paths = pathsOf(call);
  for (const field of ['patches', 'hunks'] as const) {
    const raw = call.args[field];
    if (Array.isArray(raw)) {
      for (const hunk of raw) {
        const path = normalizePath((hunk as Record<string, unknown> | null)?.path);
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
  }
  return paths;
}

/** The diagnostic count a `problems` outcome reports, when it reports one. */
function parseProblemsCount(content: string): number | null {
  if (/^No compiler problems reported\./.test(content)) return 0;
  const match = content.match(/^(\d+) problem\(s\)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** The real exit code of a run_command outcome: the receipt first, then the wire text. */
function parseExitCode(outcome: ToolOutcome): number | null {
  if (typeof outcome.proof?.exitCode === 'number') return outcome.proof.exitCode;
  const match = outcome.content.match(/^exit (-?\d+)$/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

interface ObservedCall {
  call: ToolCall;
  outcome: ToolOutcome;
  /** A cache hit carries no new information by definition. */
  cached: boolean;
}

interface ProgressReport {
  signals: string[];
  newInfo: boolean;
  zeroProgress: number;
}

/**
 * PROGRESS-based stuck detection. Per step it computes real signals from the
 * outcomes — a new file read, a file content-hash change, a diagnostics count
 * decrease, a command exit-code change, a mutation landing, a todo item done —
 * plus whether ANY executed result said something new (a first-seen call key,
 * or a result/error that differs from the last one for that key). Cache hits
 * and identical errors are not information. 8 consecutive steps with neither
 * is a stuck loop; repetition alone never is.
 */
function createProgressTracker() {
  const readPaths = new Set<string>();
  const fileHashes = new Map<string, string>();
  const resultSignatures = new Map<string, string>();
  const commandExits = new Map<string, number>();
  const doneTasks = new Set<string>();
  let lastDiagnostics: number | null = null;
  let zeroProgress = 0;
  const tried: string[] = [];

  const observe = (entries: ObservedCall[], plan: TaskPlan): ProgressReport => {
    const signals: string[] = [];
    let newInfo = false;
    for (const { call, outcome, cached } of entries) {
      const label = summarizeCall(call);
      tried.push(label);
      if (tried.length > 10) tried.shift();
      if (cached) continue;
      const key = serializeCallKey(call);
      const signature = hashText(`${outcome.ok ? 'ok' : 'err'}|${outcome.ok ? outcome.content : outcome.error ?? ''}`);
      if (resultSignatures.get(key) !== signature) newInfo = true;
      resultSignatures.set(key, signature);
      if (!outcome.ok || isControlTool(call.name)) continue;
      const path = normalizePath(call.args.path);
      if (call.name === 'read_file' && path) {
        const hash = hashText(outcome.content);
        if (!readPaths.has(path)) signals.push(`new file read: ${path}`);
        else if (fileHashes.get(path) !== hash) signals.push(`file content changed: ${path}`);
        readPaths.add(path);
        fileHashes.set(path, hash);
      } else if (call.name === 'problems') {
        const count = parseProblemsCount(outcome.content);
        if (count !== null) {
          if (lastDiagnostics !== null && count < lastDiagnostics) signals.push(`diagnostics ${lastDiagnostics} -> ${count}`);
          lastDiagnostics = count;
        }
      } else if (call.name === 'run_command') {
        const exit = parseExitCode(outcome);
        const command = typeof call.args.command === 'string' ? call.args.command : '';
        if (exit !== null) {
          const previous = commandExits.get(command);
          if (previous !== undefined && previous !== exit) signals.push(`command exit ${previous} -> ${exit}`);
          commandExits.set(command, exit);
        }
      } else if (classifyToolEffect(call.name) === 'write' && path) {
        signals.push(`mutation landed: ${path}`);
      }
    }
    for (const item of plan) {
      if (item.status === 'done' && !doneTasks.has(item.id)) {
        doneTasks.add(item.id);
        signals.push(`task done: ${item.subject}`);
      }
    }
    if (signals.length === 0 && !newInfo) zeroProgress += 1;
    else zeroProgress = 0;
    return { signals, newInfo, zeroProgress };
  };

  const triedSummary = (): string => {
    const recent = tried.slice(-6);
    return recent.length > 0 ? recent.join('; ') : 'no tool calls';
  };

  return { observe, triedSummary, get zeroProgress() { return zeroProgress; } };
}

const stuckAsk = (tried: string, steps: number): string =>
  `You are looping: the last ${steps} steps made no progress and returned nothing new (tried: ${tried}). `
  + 'Stop calling tools and write the final answer now with what you have already read. '
  + 'Say plainly which files you did not get to instead of guessing about them, and propose the next concrete step rather than another search.';

function toolSignatureHintsForText(text: string): string {
  const matched = TOOL_DEFINITIONS.filter((tool) => new RegExp(`\\b${tool.name}\\b`).test(text)).slice(0, 4);
  if (matched.length === 0) return '';
  return matched.map((tool) => `- ${tool.name}(${tool.parameters})`).join('\n');
}

/* ------------------------------------------------------------------ *
 * Control tools + activity shaping (unchanged semantics).
 * ------------------------------------------------------------------ */

function controlOutcome(call: ToolCall, plan: TaskPlan, guardUsed: boolean, turn: AgentTurnState | null): { outcome: ToolOutcome; plan: TaskPlan; finish?: { summary: string; blocked: string | null }; stop: boolean } {
  if (call.name === FINISH_TOOL_NAME) {
    const details = parseFinishDetails(call.args);
    if (!details) {
      return { outcome: { ok: false, content: '', error: 'finish needs {"summary":"the answer for the user"}.' }, plan, stop: false };
    }
    const warning = completionGuard(plan, true);
    if (warning && !guardUsed) {
      return { outcome: { ok: false, content: '', error: warning }, plan, stop: false };
    }
    // The honesty fields resolve from what really happened: a docs-only turn is
    // never "verified", a mutating turn is verified only by a check that ran
    // after the last change, and the file list is the turn's real changed set.
    const docsOnly = turn ? isDocsOnlyTurn(turn) : false;
    const mutated = turn ? hasMutations(turn) : false;
    const satisfying = turn ? satisfyingVerification(turn) : null;
    const verified = docsOnly ? false : (details.verified ?? (mutated ? (satisfying?.ok ?? false) : true));
    const filesChanged = turn ? changedPathList(turn) : (details.filesChanged ?? []);
    const summary = renderFinishSummary(details, { verified, filesChanged, docsOnly });
    return { outcome: { ok: true, content: 'Turn finished.' }, plan, finish: { summary, blocked: details.blocked }, stop: true };
  }
  const result = applyTaskUpdates(plan, call.args.tasks ?? call.args);
  if (result.error && result.plan === plan) {
    return { outcome: { ok: false, content: '', error: result.error }, plan, stop: false };
  }
  return {
    outcome: { ok: true, content: `Plan now:\n${renderTaskPlan(result.plan) || '(empty)'}` },
    plan: result.plan,
    stop: false
  };
}

function toActivity(call: ToolCall, outcome: ToolOutcome, durationMs?: number): ToolActivity {
  let stage: ToolActivity['stage'] = 'reading';
  if (!outcome.ok) {
    stage = 'failed';
  } else if (call.name === 'update_tasks') {
    stage = 'planning';
  } else if (classifyToolEffect(call.name) === 'write') {
    stage = 'editing';
  } else if (call.name === 'problems' || call.name === 'git_state' || call.name === 'run_command') {
    stage = 'checking';
  } else if (call.name === 'finish') {
    stage = 'completed';
  }

  return {
    name: call.name,
    label: summarizeCall(call),
    ok: outcome.ok,
    error: outcome.error,
    input: call.args,
    output: outcome.content ? (outcome.content.length > 2000 ? `${outcome.content.slice(0, 2000)}... [truncated]` : outcome.content) : undefined,
    durationMs,
    stage,
    refused: outcome.refused
  };
}

/* ------------------------------------------------------------------ *
 * The loop.
 * ------------------------------------------------------------------ */

interface CachedResult {
  outcome: ToolOutcome;
  /** The round (1-based) that produced the cached result. */
  step: number;
  /** The mutation epoch the result was produced at; a bump invalidates it. */
  epoch: number;
  paths: string[];
  effect: ToolEffect;
  /** Content fingerprint for read_file results, so hash changes invalidate. */
  contentHash?: string;
}

export async function runToolRounds(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const softThreshold = Math.max(1, Math.ceil(maxRounds * BUDGET_NOTE_SHARE));
  let messages = [...input.messages];
  const activity: ToolActivity[] = [];
  const policy = input.policy;
  const isAborted = (): boolean => input.aborted() || input.signal?.aborted === true;

  // The user's ask as issued, not the running transcript: observations and
  // nudges also arrive as `user` turns, so the intent is read once up front.
  const latestUserAsk = [...input.messages].reverse().find((turn) => turn.role === 'user')?.content ?? '';

  // One tracked turn per workspace: the read-set, the changed-set and the
  // verification records the read-before-write and forced-verify gates read.
  // It pushes NO messages — the transcript the model sees is unchanged.
  const turn = input.workspaceId
    ? beginTurn(input.workspaceId, latestUserAsk, {
      scaffold: detectScaffoldIntent(latestUserAsk),
      addPage: detectAddPageIntent(latestUserAsk)
    })
    : null;

  // One flight-recorder run per turn. Every boundary below lands here; the
  // recorder is fail-open, so logging can never break or block the loop.
  const runId = flightRecorder.startRun({
    kind: 'tool-loop',
    workspaceId: input.workspaceId,
    label: latestUserAsk.slice(0, 160)
  });
  flightRecorder.record('context_assembled', {
    messages: input.messages.length,
    chars: input.messages.reduce((total, turn) => total + turn.content.length, 0),
    maxRounds,
    policyMode: policy?.mode ?? null
  }, runId);

  // Result cache: a repeat of a succeeded call returns the earlier result,
  // prefixed "[unchanged since step N]" — NEVER a refusal. Failed or refused
  // calls are never cached, so they stay retryable. Invalidation is real:
  // a mutation touching a path drops that path's entries (content hashes
  // decide where they are known), and the mutation epoch drops the rest.
  let epoch = 0;
  const cache = new Map<string, CachedResult>();
  const pathHashes = new Map<string, string>();
  const invalidatePath = (path: string): void => {
    for (const [key, entry] of cache) {
      if (!entry.paths.includes(path)) continue;
      // Hash-based where a fingerprint exists: an entry whose content still
      // matches the path's known hash is genuinely unchanged and may stay.
      if (entry.contentHash && pathHashes.get(path) === entry.contentHash) continue;
      cache.delete(key);
    }
  };

  let attemptSeq = 0;
  let plan: TaskPlan = input.initialPlan ? [...input.initialPlan] : [];
  const external = input.external;
  // One listing per turn: rounds then reuse the same routes instead of re-querying
  // every server, and a dead server costs the turn nothing.
  if (external) await external.discover();
  const offeredExternal = (name: string): boolean => Boolean(external?.has(name));
  const externalNames = external ? external.describe().map((tool) => tool.name) : [];
  const tracker = createProgressTracker();
  const failureTracker = createFailureRepeatTracker();
  let text = '';
  let round = 0;
  let capped = false;
  let guardUsed = false;
  let stuckNudged = false;
  let budgetNoteUsed = false;
  let wrapNudgeUsed = false;
  let consecutiveParseFailures = 0;
  let changedFilesTotal = 0;
  const changedPathsSet = new Set<string>();
  const createdPathsSet = new Set<string>();
  const workingMemory: WorkingMemoryState = {
    inspectedRanges: [],
    completedEdits: [],
    pendingRequirements: input.initialRequirements ? [...input.initialRequirements] : [],
    latestDiagnostics: []
  };
  let finished: { summary: string; blocked: string | null } | null = null;
  let failureProof: FailureReceipt | null = null;

  // Every return path goes through stamp, so the turn's mutation total, the
  // stop reason, the resumable summary and the recorder's stop event are
  // attached even on early exits and forceFinal.
  const stamp = (result: Omit<ToolLoopResult, 'changedFiles' | 'changedPaths' | 'createdPaths' | 'stopReason' | 'resume'> & { stopReason: ToolLoopStopReason }): ToolLoopResult => {
    if (input.workspaceId) endTurn(input.workspaceId);
    const pendingIntent = (plan.find((item) => item.status !== 'done' && item.status !== 'blocked')?.subject ?? latestUserAsk).slice(0, 300);
    const resume: ToolLoopResumeState | undefined = RESUMABLE_STOPS.has(result.stopReason)
      ? {
        messages: messages.map((turn) => ({ ...turn })),
        round: result.rounds,
        pendingIntent,
        plan: plan.map((item) => ({ ...item })),
        maxRounds,
        stopReason: result.stopReason
      }
      : undefined;
    flightRecorder.stopRun(result.stopReason, {
      rounds: result.rounds,
      capped: result.capped,
      changedFiles: changedFilesTotal,
      error: result.error,
      resumable: Boolean(resume)
    }, runId);
    return {
      ...result,
      changedFiles: changedFilesTotal,
      changedPaths: [...changedPathsSet],
      createdPaths: [...createdPathsSet],
      toolEvents: activity.map((entry) => ({
        name: entry.name,
        ok: entry.ok,
        ...(entry.refused ? { refused: true } : {}),
        summary: entry.label
      })),
      ...(resume ? { resume } : {}),
      ...(failureProof ? { failureProof } : {})
    };
  };

  const wantsExploration = EXPLORATION_INTENT.test(latestUserAsk);
  let nudgeUsed = false;
  let mutationNudgeUsed = false;
  const hasPendingPathFence = (rawText: string): boolean => /```[^\n]*\bpath=/.test(rawText);
  const hasTurnWrites = (): boolean => changedFilesTotal > 0 || changedPathsSet.size > 0;
  const mayNudgeMutation = (): boolean =>
    input.requireFileMutation === true && !mutationNudgeUsed && !hasTurnWrites() && round < maxRounds;
  const inspectedWorkspace = () => activity.some((entry) => !isControlTool(entry.name));
  /** One nudge per turn, and only while a round is left to spend on it. */
  const mayNudgeExploration = () => !nudgeUsed && wantsExploration && !inspectedWorkspace() && round < maxRounds;

  /** Every provider attempt is timed and recorded, even when usage is unknown. */
  const streamWithAttempt = async (turns: ChatTurn[], roundIndex: number): Promise<{ text: string; error: string | null }> => {
    const startedAt = Date.now();
    const attemptId = `tool-round-${roundIndex}-${attemptSeq++}`;
    let state: AttemptState = 'pending';
    try {
      const result = await input.stream(turns, roundIndex);
      state = result.error ? 'failed' : isAborted() ? 'cancelled' : 'completed';
      return result;
    } catch (error) {
      state = 'failed';
      throw error;
    } finally {
      input.onAttempt?.({
        taskId: input.workspaceId ?? 'tool-loop',
        attemptId,
        role: 'tool-round',
        provider: 'unknown',
        requestedModel: 'unknown',
        state,
        usageSource: 'unknown',
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        durationMs: Date.now() - startedAt,
        startedAt
      });
    }
  };

  /** The cap (or a stuck loop) is reached: one more stream, with instructions to answer now. */
  const forceFinal = async (currentRound: number, ask: string, reason: 'step_cap' | 'stuck'): Promise<ToolLoopResult> => {
    capped = true;
    if (isAborted()) return stamp({ text, rounds: currentRound, activity, capped, error: null, plan, stopReason: 'aborted' });
    messages.push({ role: 'user', content: ask });
    const final = await streamWithAttempt(messages, currentRound);
    if (isAborted()) return stamp({ text: stripToolBlocks(final.text), rounds: currentRound + 1, activity, capped, error: null, plan, stopReason: 'aborted' });
    const stripped = stripToolBlocks(final.text);
    if (stripped.trim() || final.error) {
      return stamp({ text: stripped, rounds: currentRound + 1, activity, capped, error: final.error, plan, stopReason: reason });
    }
    // The model answered the order with another tool block: it still owes an
    // answer, and an empty reply is worse than the round it costs to avoid it.
    messages.push({ role: 'assistant', content: final.text });
    messages.push({ role: 'user', content: FINAL_ASK });
    if (isAborted()) return stamp({ text: '', rounds: currentRound + 1, activity, capped, error: null, plan, stopReason: 'aborted' });
    const again = await streamWithAttempt(messages, currentRound + 1);
    return stamp({
      text: stripToolBlocks(again.text),
      rounds: currentRound + 2,
      activity,
      capped,
      error: again.error,
      plan,
      stopReason: reason
    });
  };

  /** One stuck check, shared by the executed and the nothing-ran paths. */
  const stuckStop = async (): Promise<ToolLoopResult | null> => {
    if (tracker.zeroProgress < ZERO_PROGRESS_LIMIT) return null;
    const ask = stuckAsk(tracker.triedSummary(), tracker.zeroProgress);
    flightRecorder.record('stuck_nudge', { zeroProgress: tracker.zeroProgress, tried: tracker.triedSummary(), nudged: !stuckNudged }, runId);
    if (!stuckNudged && round < maxRounds) {
      stuckNudged = true;
      messages.push({ role: 'user', content: ask });
      return null;
    }
    return await forceFinal(round, ask, 'stuck');
  };

  /**
   * The gates a finish must pass before the turn may end. Each is code-enforced,
   * not prompt advice: a new-project ask that dumped one file, a page added into
   * an existing file, an unverified preview, or a change nothing checked after it
   * all refuse the finish with the exact next step. The stuck detector is the
   * escape hatch if the model keeps refusing to satisfy a gate.
   */
  const finishGate = async (): Promise<ToolOutcome | null> => {
    if (mayNudgeMutation() && !hasPendingPathFence(text)) {
      mutationNudgeUsed = true;
      return { ok: false, content: '', error: MUTATION_REQUIRED_NUDGE, refused: true };
    }
    if (!turn) return null;
    if (turn.scaffoldIntent && !turn.scaffoldNudged && turn.created.size < 2) {
      turn.scaffoldNudged = true;
      return { ok: false, content: '', error: scaffoldNudge(turn.created.size), refused: true };
    }
    if (turn.addPageIntent && !turn.addPageNudged && turn.created.size === 0 && turn.changed.size > 0) {
      turn.addPageNudged = true;
      return { ok: false, content: '', error: addPageNudge(), refused: true };
    }
    if (turn.scaffoldIntent && !turn.previewVerified && !turn.previewNudged
      && [...turn.changed].some((path) => /\.(?:html?|tsx|jsx|css|scss|vue|svelte)$/i.test(path))) {
      const desktop = getDesktopBridge();
      if (desktop && typeof desktop.assertPreview === 'function') {
        try {
          const verdict = await desktop.assertPreview(turn.workspaceId);
          if (verdict.ok) turn.previewVerified = true;
          else {
            turn.previewNudged = true;
            return { ok: false, content: '', error: previewNudge(verdict.detail ?? `${verdict.errorCount} preview error(s)`), refused: true };
          }
        } catch {
          /* preview unavailable in this build — never block a finish on it */
        }
      }
    }
    if (needsVerification(turn)) {
      return { ok: false, content: '', error: verificationDemand(turn), refused: true };
    }
    return null;
  };

  while (true) {
    if (isAborted()) return stamp({ text, rounds: round, activity, capped: false, error: null, plan, stopReason: 'aborted' });
    // Context compaction: once the transcript passes ~70% of the budget, older
    // tool observations are summarized to what was found/decided, keeping the
    // most recent few intact. Below the trigger the array is returned unchanged.
    const compacted = compactToolObservations(messages, input.loopContextBudgetChars);
    if (compacted.compacted > 0) {
      messages = compacted.messages;
      flightRecorder.record('context_assembled', { compacted: compacted.compacted, chars: messages.reduce((total, entry) => total + entry.content.length, 0) }, runId);
    }
    const hasMemoryFacts =
      workingMemory.inspectedRanges.length > 0 ||
      workingMemory.completedEdits.length > 0 ||
      workingMemory.pendingRequirements.length > 0 ||
      workingMemory.latestDiagnostics.length > 0;
    if ((compacted.compacted > 0 || round >= 4) && hasMemoryFacts) {
      messages = upsertWorkingMemory(messages, workingMemory);
    }
    // ONE soft note at 80% of the budget, before the next stream sees it.
    if (!budgetNoteUsed && round >= softThreshold && round < maxRounds) {
      budgetNoteUsed = true;
      messages.push({ role: 'system', content: softBudgetNote(round, maxRounds) });
      flightRecorder.record('budget_note', { round, maxRounds }, runId);
    }
    // A earlier wrap-up nudge at round 40 on long budgets: land and verify, stop
    // exploring. Distinct text from the 80% note so the two never collide.
    if (!wrapNudgeUsed && round >= 40 && round < maxRounds) {
      wrapNudgeUsed = true;
      messages.push({ role: 'system', content: `Round ${round} of ${maxRounds}: start landing the final changes and verify them; do not open new explorations.` });
    }
    const streamed = await streamWithAttempt(messages, round);
    if (isAborted()) return stamp({ text: streamed.text, rounds: round, activity, capped: false, error: null, plan, stopReason: 'aborted' });
    round += 1;
    text = streamed.text;
    input.onRound?.(round - 1, streamed.text);
    if (streamed.error) {
      flightRecorder.record('provider_error', { message: streamed.error, round }, runId);
      return stamp({ text, rounds: round, activity, capped: false, error: streamed.error, plan, stopReason: 'provider_error' });
    }

    const blocks = parseToolBlocks(streamed.text);
    if (blocks.length === 0) {
      if (mayNudgeExploration()) {
        nudgeUsed = true;
        if (streamed.text.trim()) messages.push({ role: 'assistant', content: streamed.text });
        messages.push({ role: 'user', content: EXPLORATION_NUDGE });
        continue;
      }
      if (mayNudgeMutation() && !hasPendingPathFence(streamed.text)) {
        mutationNudgeUsed = true;
        if (streamed.text.trim()) messages.push({ role: 'assistant', content: streamed.text });
        messages.push({ role: 'user', content: MUTATION_REQUIRED_NUDGE });
        continue;
      }
      // Never end the turn mid-plan: if tasks are still pending/doing, nudge to continue
      // instead of returning complete. The model may have written prose and forgotten to
      // call finish or update_tasks.
      if (round < maxRounds && plan.length > 0) {
        const pending = plan.find((item) => item.status !== 'done' && item.status !== 'blocked');
        if (pending) {
          if (streamed.text.trim()) messages.push({ role: 'assistant', content: streamed.text });
          messages.push({ role: 'user', content: `You still have unfinished tasks in your plan (e.g. "${pending.subject}"). Continue with your tools, or call finish when everything is done.` });
          continue;
        }
      }
      return stamp({ text, rounds: round, activity, capped: false, error: null, plan, stopReason: 'complete' });
    }

    // The turn's safety net, taken BEFORE any write lands (reply-edit fences
    // included): pre-images of exactly the paths about to change, merged into
    // one checkpoint. Fail-open — a bridge without loadFiles skips it entirely.
    if (turn) {
      const writePaths = new Set<string>();
      for (const block of blocks) {
        for (const call of block.calls) {
          if (classifyToolEffect(call.name) === 'write') {
            for (const path of writePathsOf(call)) writePaths.add(path);
          }
        }
      }
      for (const match of streamed.text.matchAll(/```path=([^\n]+)/g)) {
        const path = normalizePath(match[1].trim());
        if (path) writePaths.add(path);
      }
      if (writePaths.size > 0) {
        const desktop = getDesktopBridge();
        if (desktop) await ensureTurnCheckpoint(turn, desktop, [...writePaths]);
      }
    }

    // The round's edits reach disk before its calls run: a run_command or
    // problems call must see the file the model just wrote, not the old one.
    if (input.applyRoundPatches) {
      await input.applyRoundPatches(streamed.text, round - 1);
      if (isAborted()) return stamp({ text: stripToolBlocks(streamed.text), rounds: round, activity, capped: false, error: null, plan, stopReason: 'aborted' });
    }

    const fresh: ToolCall[] = [];
    const freshKeys: string[] = [];
    const cachedHits: Array<{ call: ToolCall; entry: CachedResult }> = [];
    // Calls the run policy refuses: recorded so the user sees a real denial in
    // the trace and the model is told why, instead of a silent no-op.
    const denied: Array<{ call: ToolCall; effect: ToolEffect }> = [];
    const problems: string[] = blocks.filter((block) => block.error).map((block) => block.error as string);
    for (const block of blocks) {
      for (const call of block.calls) {
        if (!isKnownTool(call.name) && !offeredExternal(call.name)) {
          problems.push(`"${call.name}" is not a tool. Available: ${availableToolNames(externalNames)}.`);
          continue;
        }
        if (policy) {
          const effect = classifyToolEffect(call.name);
          if (!allowsEffect(policy.mode, effect)) {
            denied.push({ call, effect });
            problems.push(
              `${summarizeCall(call)} was refused: ${policy.mode} mode does not allow ${effect} actions. Switch to Agent mode to allow it.`
            );
            continue;
          }
        }
        const key = serializeCallKey(call);
        // A call that failed the same way three times is blocked for the turn:
        // repeating it cannot change the result, so the model is told to switch
        // approach instead of spending another round on it.
        if (failureTracker.isBlocked(key)) {
          const message = failureBlockMessage(summarizeCall(call));
          problems.push(message);
          activity.push({ name: call.name, label: summarizeCall(call), ok: false, error: message, input: call.args, stage: 'failed', refused: true });
          flightRecorder.record('tool_result', { tool: call.name, status: 'refused', refused: true, error_code: 'BLOCKED', error: message }, runId);
          continue;
        }
        // Duplicates are served from the cache, never refused. Control tools
        // (plan/finish) are stateful and always re-run; they are never cached.
        const entry = cache.get(key);
        if (entry && entry.epoch === epoch && !isControlTool(call.name)) {
          cachedHits.push({ call, entry });
          flightRecorder.record('cache_hit', { tool: call.name, label: summarizeCall(call), step: entry.step }, runId);
          continue;
        }
        if (freshKeys.includes(key)) {
          problems.push(`${summarizeCall(call)} is asked twice in this block: one run is enough.`);
          continue;
        }
        fresh.push(call);
        freshKeys.push(key);
      }
    }
    // The cap is applied after dedupe, so a cached or refused duplicate cannot
    // steal a slot from a call that actually needs to run.
    const usable = fresh.slice(0, MAX_CALLS_PER_ROUND);
    const cut = fresh.slice(MAX_CALLS_PER_ROUND);
    if (cut.length > 0) {
      // Deliberately not cached: a call that never ran must stay runnable next
      // round instead of being served a stale result.
      problems.push(
        `${cut.slice(0, 3).map(summarizeCall).join(', ')}${cut.length > 3 ? `, +${cut.length - 3} more` : ''} did not run this round — a round holds at most ${MAX_CALLS_PER_ROUND} calls. Ask for ${cut.length > 1 ? 'them' : 'it'} again in the next round.`
      );
    }

    // A policy refusal is a real outcome, not a malformed call: it is recorded
    // in the trace even when nothing else in the round could run.
    for (const entry of denied) {
      activity.push({
        name: entry.call.name,
        label: summarizeCall(entry.call),
        ok: false,
        error: `${policy?.mode ?? 'ask'} mode does not allow ${entry.effect} actions.`,
        input: entry.call.args,
        stage: 'failed',
        refused: true
      });
      flightRecorder.record('tool_result', {
        tool: entry.call.name, status: 'refused', refused: true, error_code: 'POLICY',
        error: `${policy?.mode ?? 'ask'} mode does not allow ${entry.effect} actions.`
      }, runId);
      if (entry.call.name === 'run_command') {
        flightRecorder.record('command_decision', { decision: 'deny', source: 'run-policy', tier: entry.effect }, runId);
      }
    }

    if (usable.length === 0 && cachedHits.length === 0) {
      // The model keeps asking for calls that were malformed or policy-denied:
      // that is the loop the progress detector exists to catch, so it counts as
      // a step even though nothing executed.
      tracker.observe(denied.map((entry) => ({
        call: entry.call,
        outcome: { ok: false, content: '', error: `${policy?.mode ?? 'ask'} mode does not allow ${entry.effect} actions.`, refused: true },
        cached: false
      })), plan);
      messages.push({ role: 'assistant', content: streamed.text });
      const hasParseFailure = blocks.some((block) => Boolean(block.error)) || denied.length === 0;
      consecutiveParseFailures = hasParseFailure ? consecutiveParseFailures + 1 : 0;
      if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
        flightRecorder.record('stuck_nudge', { consecutiveParseFailures, reason: 'repeated_malformed_tools' }, runId);
        return await forceFinal(
          round,
          'Repeated tool call blocks could not be parsed cleanly. Stop calling tools and write the final answer now from what you have already observed.',
          'stuck'
        );
      }
      const stuck = await stuckStop();
      if (stuck) return stuck;
      if (round >= maxRounds) return await forceFinal(round, FINAL_ASK, 'step_cap');
      const hints = toolSignatureHintsForText(streamed.text);
      const hintBlock = hints ? `\n\nExpected parameter signatures:\n${hints}` : '';
      messages.push({
        role: 'user',
        content: `No tool call could run: ${problems.join(' ') || 'the block was empty.'}${hintBlock}\nEither emit a valid \`\`\`shadrox:tools block with double-quoted JSON keys/values or answer now.`
      });
      continue;
    }
    consecutiveParseFailures = 0;

    const runnable: number[] = [];
    const outcomes: ToolOutcome[] = usable.map(() => ({ ok: false, content: '' }));
    const confinementExistence = new Map<string, boolean>();
    const declaredExpected = new Set((input.expectedFiles ?? []).map((p) => normalizePath(p) ?? p));
    // Control calls run in order; a finish first passes the async gates (scaffold,
    // add-page, preview, forced-verify) before the plan guard and structured render.
    for (let index = 0; index < usable.length; index += 1) {
      const call = usable[index];
      if (!isControlTool(call.name)) {
        if (input.expectedFiles !== undefined && classifyToolEffect(call.name) === 'write') {
          const targetPaths = writePathsOf(call);
          if (targetPaths.length > 0) {
            if (input.expectedFiles.length > 0) {
              for (const target of targetPaths) {
                if (declaredExpected.has(target) || confinementExistence.has(target)) continue;
                if (!isInsideWorkspaceRoot(target)) continue;
                if (input.existsOnDisk) {
                  confinementExistence.set(target, await input.existsOnDisk(target));
                } else {
                  const desktop = getDesktopBridge();
                  if (desktop && input.workspaceId) {
                    try {
                      await desktop.readFile(input.workspaceId, target);
                      confinementExistence.set(target, true);
                    } catch {
                      confinementExistence.set(target, false);
                    }
                  }
                }
              }
            }
            const confined = confinePatches(
              targetPaths.map((p) => ({ path: p })),
              input.expectedFiles,
              { fileExists: (p) => confinementExistence.get(p) ?? true }
            );
            if (confined.refused.length > 0) {
              outcomes[index] = {
                ok: false,
                content: '',
                error: confined.refused.join(' '),
                refused: true
              };
              continue;
            }
          }
        }
        runnable.push(index);
        continue;
      }
      if (call.name === FINISH_TOOL_NAME) {
        const gate = await finishGate();
        if (gate) {
          outcomes[index] = gate;
          continue;
        }
      }
      const handled = controlOutcome(call, plan, guardUsed, turn);
      guardUsed = guardUsed || !handled.outcome.ok;
      plan = handled.plan;
      if (handled.finish) finished = handled.finish;
      outcomes[index] = handled.outcome;
    }
    input.onPlan?.(plan);

    let batchDurationMs: number | undefined;
    if (runnable.length > 0) {
      const batch = runnable.map((index) => usable[index]);
      const isExternal = batch.map((call) => offeredExternal(call.name));
      if (isExternal.some((externalCall) => !externalCall) && !input.workspaceId) {
        return stamp({
          text: stripToolBlocks(streamed.text),
          rounds: round,
          activity,
          capped: false,
          error: 'The assistant asked to read files, but no folder workspace is open, so no tool can run.',
          plan,
          stopReason: 'no_workspace'
        });
      }
      if (input.onStatus && batch.length > 0) {
        const primary = batch[0];
        const statusMsg = primary.name === 'read_file'
          ? `Reading ${(primary.args as Record<string, unknown>).path || 'file'}...`
          : primary.name === 'search_text'
            ? `Searching for "${(primary.args as Record<string, unknown>).query || ''}"...`
            : primary.name === 'problems'
              ? 'Checking compiler problems...'
              : `Running ${summarizeCall(primary)}...`;
        input.onStatus(statusMsg);
      }
      for (const call of batch) {
        flightRecorder.record('tool_call_started', { tool: call.name, label: summarizeCall(call) }, runId);
        if (call.name === 'run_command') {
          flightRecorder.record('command_requested', { command: call.args.command }, runId);
        }
      }
      const t0 = Date.now();
      // One batch: an MCP call and a file read in the same round run together, and
      // an MCP call does not need an open folder.
      const batchOutcomes = await Promise.all(
        batch.map((call, position) =>
          isExternal[position] && external
            ? external.call(call)
            : runTool(input.workspaceId as string, call)
        )
      );
      batchDurationMs = Math.max(1, Date.now() - t0);
      runnable.forEach((index, cursor) => {
        outcomes[index] = batchOutcomes[cursor];
      });
    }

    usable.forEach((call, index) => activity.push(toActivity(call, outcomes[index], batchDurationMs)));
    for (const outcome of outcomes) {
      if (outcome?.proof) failureProof = outcome.proof;
    }

    // Feed the cache and the recorder now that the outcomes are known. Every
    // successful non-control call is cached at the current epoch; a successful
    // workspace mutation bumps the epoch FIRST — so earlier observations become
    // re-runnable against the changed workspace — and invalidates the paths it
    // touched by content hash where one is known. Failed or refused calls are
    // never cached, so they stay retryable. Nothing here refuses a duplicate.
    let roundChangedFiles = 0;
    const unchangedRereads = new Map<number, string>();
    usable.forEach((call, index) => {
      const outcome = outcomes[index];
      const errorCode = toolErrorCode(outcome);
      flightRecorder.record('tool_result', {
        tool: call.name,
        status: outcome.ok ? 'ok' : outcome.refused ? 'refused' : 'error',
        refused: outcome.refused === true,
        ms: batchDurationMs ?? null,
        error_code: errorCode ?? null,
        error: outcome.ok ? undefined : outcome.error
      }, runId);
      // Same-call-same-error tracking: the second identical failure nudges, the
      // third blocks. Guard refusals never count; a successful disk write resets.
      if (!isControlTool(call.name)) {
        const verdict = failureTracker.note({
          key: serializeCallKey(call), ok: outcome.ok, refused: outcome.refused,
          error: outcome.error, content: outcome.content
        });
        if (verdict === 'nudge' || verdict === 'block') {
          const base = verdict === 'nudge' ? failureNudge(summarizeCall(call)) : failureBlockMessage(summarizeCall(call));
          problems.push(isPortLoopFailure(outcome) ? `${base} ${PORT_LOOP_ADVICE}` : base);
        }
      }
      // Verification records land even when the check FAILED — a failed check
      // still ran, and the finish gate demands that something ran after the last
      // change (the verified flag reflects whether it passed).
      if (turn && !outcome.refused && !isControlTool(call.name)) {
        if (call.name === 'verify') {
          noteVerification(turn, {
            kind: 'verify', ok: outcome.ok, paths: [],
            detail: outcome.verifyReport ? `${outcome.verifyReport.commandsRun.length} command(s), ${outcome.verifyReport.errors.length} error(s)` : 'verify'
          });
        } else if (call.name === 'problems' && outcome.ok) {
          const count = parseProblemsCount(outcome.content);
          if (count !== null) {
            const checkPaths = call.args.changed_only === true ? [...turn.changed] : pathsOf(call);
            noteVerification(turn, { kind: 'problems', ok: count === 0, paths: checkPaths, detail: 'problems' });
          }
        } else if (call.name === 'run_command') {
          const exit = parseExitCode(outcome);
          const command = typeof call.args.command === 'string' ? call.args.command : '';
          if (exit !== null && isVerifyCommand(command)) {
            noteVerification(turn, { kind: 'command', ok: exit === 0, paths: [], detail: command });
          }
        }
      }
      if (!outcome.ok || isControlTool(call.name)) {
        if (!outcome.ok && !outcome.refused && (classifyToolEffect(call.name) === 'write' || call.name === 'verify' || call.name === 'run_command')) {
          const line = (outcome.error ?? outcome.content).split('\n')[0]?.trim();
          if (line) workingMemory.latestDiagnostics = [...workingMemory.latestDiagnostics.slice(-9), `${call.name}: ${line}`];
        }
        if (call.name === 'run_command' && outcome.refused && /not approved|blocked|blacklist|not allowed/i.test(outcome.error ?? '')) {
          flightRecorder.record('command_decision', {
            decision: 'deny',
            source: /not approved/i.test(outcome.error ?? '') ? 'native-approval' : 'command-policy',
            tier: 'execute'
          }, runId);
        }
        if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'apply_patch') && /^Not written —/.test(outcome.error ?? '')) {
          flightRecorder.record('verify_result', { ok: false, stage: 'pre-apply', path: normalizePath(call.args.path) }, runId);
        }
        return;
      }
      const effect = classifyToolEffect(call.name);
      const paths = effect === 'write' ? writePathsOf(call) : pathsOf(call);
      // terminal_answer only submits prose to a waiting prompt; verify runs the
      // project's checks but is a check, not a mutation; preview_control status is
      // read-only inspection — counting it would stale the very verify finishGate
      // just accepted.
      const mutating = call.name !== 'terminal_answer'
        && call.name !== 'verify'
        && !(call.name === 'preview_control' && call.args.action === 'status')
        && (effect === 'write' || effect === 'execute' || effect === 'external');
      if (mutating) {
        epoch += 1;
        if (effect === 'write') {
          // Only a real disk write earns the fresh slate: earlier failure runs
          // described a stale state, so a fix must unblock them. A successful
          // kill or restart (execute) changes nothing the failed calls read —
          // resetting there would erase the same-error counter every round and
          // a kill/restart loop that keeps failing identically would never block.
          failureTracker.reset();
        }
        const effectiveChanged = outcome.changedPaths && outcome.changedPaths.length > 0 ? outcome.changedPaths : paths;
        const effectiveCreated = outcome.createdPaths ?? [];
        if (effect === 'write') {
          for (const p of effectiveChanged) {
            const norm = normalizePath(p) ?? p;
            changedPathsSet.add(norm);
            workingMemory.completedEdits.push({ path: norm, op: call.name });
          }
          for (const p of effectiveCreated) {
            const norm = normalizePath(p) ?? p;
            createdPathsSet.add(norm);
            changedPathsSet.add(norm);
          }
          if (/Diagnostics after edit/.test(outcome.content)) {
            const diagLines = outcome.content.split('\n').slice(1).filter((l) => l.trim()).slice(0, 4);
            workingMemory.latestDiagnostics = diagLines;
          } else if (/No compiler problems in this file/.test(outcome.content)) {
            workingMemory.latestDiagnostics = [];
          }
        }
        if (turn) {
          if (effect === 'write' && effectiveChanged.length > 0) {
            noteWrite(turn, effectiveChanged, effectiveCreated);
          } else {
            noteUnknownWrite(turn);
          }
        }
        // delete_file counts its verified removal; run_command and MCP successes
        // cannot count files honestly, so each counts 1 as a conservative
        // progress unit — not a literal file count.
        roundChangedFiles += call.name === 'delete_file' ? (outcome.changedFiles ?? 1) : 1;
        if (call.name === 'write_file' && typeof call.args.content === 'string' && paths.length > 0) {
          // The new content is known: fingerprint it so hash-based invalidation
          // can tell a genuinely unchanged entry from a stale one.
          pathHashes.set(paths[0], hashText(call.args.content));
        } else {
          for (const path of effectiveChanged) pathHashes.delete(normalizePath(path) ?? path);
        }
        for (const path of effectiveChanged) invalidatePath(normalizePath(path) ?? path);
        if (effect === 'write') {
          flightRecorder.record('edit_applied', {
            files: effectiveChanged,
            match: outcome.content.split(' ')[0] ?? 'changed',
            chars: typeof call.args.content === 'string' ? call.args.content.length : undefined
          }, runId);
        }
      }
      if (call.name === 'verify') {
        if (outcome.verifyReport && outcome.verifyReport.errors.length > 0) {
          workingMemory.latestDiagnostics = outcome.verifyReport.errors.slice(0, 6).map((e) => `${e.file}:${e.line} ${e.msg}`);
        } else {
          workingMemory.latestDiagnostics = [];
        }
      }
      if (call.name === 'run_command') {
        flightRecorder.record('command_decision', { decision: 'allow', source: 'auto', tier: 'execute' }, runId);
        flightRecorder.record('command_finished', {
          exit: parseExitCode(outcome),
          ms: batchDurationMs ?? null,
          timedOut: /timed?\s?out|timeout/i.test(outcome.content)
        }, runId);
      }
      if (call.name === 'problems') {
        const count = parseProblemsCount(outcome.content);
        flightRecorder.record('verify_result', { ok: true, count }, runId);
        if (count === 0) {
          workingMemory.latestDiagnostics = [];
        } else if (count !== null && count > 0) {
          workingMemory.latestDiagnostics = outcome.content.split('\n').slice(1, 8).filter((l) => l.trim());
        }
      }
      let contentHash: string | undefined;
      if (call.name === 'read_file' && paths.length > 0) {
        contentHash = hashText(outcome.content);
        const previous = pathHashes.get(paths[0]);
        // A fresh re-read whose bytes match the last read adds no information;
        // the observation says so instead of pretending the file was re-examined.
        if (previous !== undefined && previous === contentHash) unchangedRereads.set(index, paths[0]);
        pathHashes.set(paths[0], contentHash);
        // A fresh read that disagrees with the last known fingerprint proves the
        // path moved (an external edit, a landed patch): drop its stale entries.
        if (previous !== undefined && previous !== contentHash) invalidatePath(paths[0]);
        if (turn) noteRead(turn, paths[0], contentHash);
        const rangeMatch = outcome.content.match(/lines\s+(\d+)-(\d+)\s+of\s+(\d+)/);
        workingMemory.inspectedRanges.push(
          rangeMatch
            ? {
                path: paths[0],
                startLine: Number.parseInt(rangeMatch[1], 10),
                endLine: Number.parseInt(rangeMatch[2], 10),
                totalLines: Number.parseInt(rangeMatch[3], 10)
              }
            : { path: paths[0] }
        );
      }
      cache.set(serializeCallKey(call), { outcome, step: round, epoch, paths, effect, contentHash });
    });
    changedFilesTotal += roundChangedFiles;

    const observed: ObservedCall[] = [
      ...usable.map((call, index) => ({ call, outcome: outcomes[index], cached: false })),
      ...cachedHits.map(({ call, entry }) => ({ call, outcome: entry.outcome, cached: true }))
    ];
    tracker.observe(observed, plan);
    if (isAborted()) return stamp({ text: stripToolBlocks(streamed.text), rounds: round, activity, capped: false, error: null, plan, stopReason: 'aborted' });

    messages.push({ role: 'assistant', content: streamed.text });
    const observation = serializeResults([
      ...usable.map((call, index) => {
        const { proof: _proof, ...rest } = outcomes[index];
        const rereadPath = unchangedRereads.get(index);
        return {
          name: call.name,
          ...rest,
          content: rereadPath ? `[re-read: ${rereadPath} is unchanged since the last read this turn]\n${rest.content}` : rest.content
        };
      }),
      // A cached duplicate is answered with its earlier result, honestly labelled.
      ...cachedHits.map(({ call, entry }) => ({
        name: call.name,
        ok: true,
        content: `[unchanged since step ${entry.step}]\n${entry.outcome.content}`
      }))
    ]);
    // A call that was refused or cut still needs saying when the round ran
    // something: dropping the note is how a model keeps re-asking blind.
    messages.push({ role: 'user', content: problems.length > 0 ? `${observation}\n\nAlso: ${problems.join(' ')}` : observation });

    if (finished) {
      if (mayNudgeExploration()) {
        // A finish without a single read is the same lazy turn as a prose
        // answer: the summary is withheld and one nudge replaces it.
        nudgeUsed = true;
        finished = null;
        messages.push({ role: 'user', content: EXPLORATION_NUDGE });
        continue;
      }
      const prose = stripToolBlocks(streamed.text).trim();
      return stamp({
        text: prose || (finished as { summary: string }).summary,
        rounds: round,
        activity,
        capped: false,
        error: null,
        plan,
        finish: finished as { summary: string; blocked: string | null },
        stopReason: 'finish'
      });
    }

    const stuck = await stuckStop();
    if (stuck) return stuck;

    if (round >= maxRounds) return await forceFinal(round, FINAL_ASK, 'step_cap');
  }
}