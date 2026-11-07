/**
 * One real agent turn: read, then propose, then land only what is safe to land.
 *
 * Before this module existed, a team task or a run milestone was one `streamChat`
 * call away from writing files. The system prompt told the model it has
 * `read_file` and `search_text`, but the headless path never ran a tool loop, so
 * an agent edited bytes it had not seen — and did it with `allowDestructive: true`
 * and no review card, which the chat path has never done.
 *
 * This is the fix, and it stays a plain function over injected capabilities so
 * `App.tsx` can hand it its own `runToolRounds`, `streamChat` and patch engine
 * without any of those files moving:
 *
 *   stream            one model turn (the app's real, billed one)
 *   runToolRounds     the chat tool loop, passed through as a value
 *   buildMessages     composes the system context + the instruction
 *   extractPatches    the app's reply -> file-change parser
 *   readFile          the current bytes of a target, for the apply policy
 *   writePatches      optional writer for cleared changes, normally the review path
 *
 * The contract that matters: nothing is written on a stopped turn, and nothing is
 * written that the apply policy could not defend to the user's face.
 */

import type { ToolActivity, ToolLoopInput, ToolLoopResult } from '../agent/toolLoop';
import type { TaskPlan } from '../agent/taskPlan';
import type { ChatTurn } from '../ai';
import { allowsEffect, type RequestScope, type RunPolicy } from '../agent/runPolicy';
import type { AttemptRecord } from '../taskUsage';
import { confinePatches } from '../autonomy/confinement';
import type { ApplyPolicyKind } from '../autonomy/types';
import {
  normalizePolicyPath,
  partitionPatches,
  resolvePolicy,
  reviewSummaryLine,
  type PolicyFileState,
  type PolicyPatch
} from './applyPolicy';

/** The injected tool loop. `runToolRounds` satisfies it exactly. */
export type ToolLoopRunner = (input: ToolLoopInput) => Promise<ToolLoopResult>;

/** A change the reply proposed. Shape-compatible with the app's `UnifiedPatch`. */
export type TurnPatch = PolicyPatch;

export interface AgentTurnPorts {
  /** One model turn. `round` is 0 for the first call. */
  stream: (messages: ChatTurn[], round: number) => Promise<{ text: string; error: string | null }>;
  runToolRounds: ToolLoopRunner;
  /** System context + history + this instruction, as the chat path builds it. */
  buildMessages: (instruction: string) => ChatTurn[];
  extractPatches: (text: string) => TurnPatch[];
  /** Current file contents, or null when the path does not exist yet. */
  readFile: (path: string) => Promise<string | null>;
  /**
   * Writes the patches the policy cleared, and only those. When omitted the
   * caller gets them in `autoApply` and routes them itself — which is what lets
   * `App.tsx` push them through the same atomic, verified apply a chat reply uses.
   */
  writePatches?: (patches: TurnPatch[]) => Promise<{ applied: string[]; failures: string[] }>;
  /** The native workspace the read tools run against; null disables them. */
  workspaceId: string | null;
  /** User-configured MCP tools discovered for this turn. */
  external?: ToolLoopInput['external'];
  /** Token cost settled by the caller's stream wrapper, once the turn is over. */
  measureCredits?: () => number;
}

export interface AgentTurnInput {
  /** The composed instruction: role brief, task, confinement, shared context. */
  instruction: string;
  /** Repo-relative files this unit may touch. Empty means read-and-report only. */
  expectedFiles: string[];
  ports: AgentTurnPorts;
  systemInstruction?: string;
  maxToolRounds?: number;
  /** Keeps a plan across milestones when the caller wants one. */
  initialPlan?: TaskPlan;
  applyPolicy?: ApplyPolicyKind;
  /** The Stop button's signal. Ends the in-flight request and forbids any write. */
  signal?: AbortSignal;
  /** The request's permission mode and target scope, threaded into the tool loop. */
  policy?: RunPolicy;
  /** Per-attempt usage provenance, forwarded to the tool loop when it records one. */
  onAttempt?: (record: AttemptRecord) => void;
  onActivity?: (activity: ToolActivity[]) => void;
  onRound?: (round: number, text: string) => void;
  onPlan?: (plan: TaskPlan) => void;
}

export interface AgentTurnOutcome {
  /** The reply with tool fences removed — what the user reads. */
  reply: string;
  /** One line for the checklist; the finish tool's summary when the model used it. */
  summary: string;
  /** Cleared for writing and, when `writePatches` was given, actually written. */
  applied: string[];
  /** Held back for the user. Never written, whatever the policy's default was. */
  pendingReview: string[];
  /** Why each held-back file is held back, in the order the user will read them. */
  reviewNotes: string[];
  /** The held-back changes themselves, ready to become a reviewable patch set. */
  reviewPatches: TurnPatch[];
  /** Cleared changes the caller must write when it supplied no `writePatches`. */
  autoApply: TurnPatch[];
  /** Refused by confinement, or failed on the way to disk. Reason included. */
  patchFailures: string[];
  filesRead: string[];
  /**
   * How much of each read file the turn actually saw: `full` only when a read
   * returned the whole file untruncated. An outline, a line range or a truncated
   * excerpt is `partial` and never satisfies the full-read apply requirement.
   * Additive: callers that ignore it keep the previous `filesRead` behaviour.
   */
  readCoverage?: Record<string, ReadCoverage>;
  toolActivity: ToolActivity[];
  toolRounds: number;
  /** True when the tool budget ran out and the answer was forced. */
  capped: boolean;
  creditsSpent: number;
  /** Stop was pressed, or the model call died. The loop must not retry this. */
  aborted: boolean;
  /** True when `aborted` was the user's Stop, not a failed request. */
  stopped: boolean;
  /** Nothing was extracted and nothing was written — a stopped turn's guarantee. */
  wroteNothing: boolean;
  error: string | null;
  plan: TaskPlan;
  finish?: { summary: string; blocked: string | null };
}

const READ_TOOL_NAMES = new Set(['read_file', 'outline']);
const SUMMARY_LIMIT = 600;

/** Whether a read returned the whole file (`full`) or only an excerpt (`partial`). */
export type ReadCoverage = 'full' | 'partial';

/**
 * What one read activity actually returned. `unknown` means the port exposed no
 * range or truncation evidence, so the previous label-based behaviour is kept.
 */
type ReadObservation = 'full' | 'partial' | 'unknown';

const RANGE_HEADER = /lines\s+(\d+)-(\d+)\s+of\s+(\d+)/;

function readPathFromLabel(label: string): string {
  const path = label.includes(' · ') ? label.slice(label.indexOf(' · ') + 3) : '';
  return normalizePolicyPath(path).toLowerCase();
}

function observeReadCoverage(entry: ToolActivity): ReadObservation {
  // An outline is symbols, never the file's bytes, so it can only be partial.
  if (entry.name === 'outline') return 'partial';
  const args = entry.input && typeof entry.input === 'object' ? (entry.input as Record<string, unknown>) : null;
  // An explicit line range is a ranged read even before the output is inspected.
  if (args && (args.start_line !== undefined || args.end_line !== undefined)) return 'partial';
  const output = typeof entry.output === 'string' ? entry.output : '';
  if (!output) return 'unknown';
  // Both the tool's own clip marker and the activity's display cut mean the turn
  // did not see the whole file.
  if (output.includes('output cut at') || output.includes('[truncated]')) return 'partial';
  const range = RANGE_HEADER.exec(output);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    const total = Number(range[3]);
    return from <= 1 && to >= total ? 'full' : 'partial';
  }
  return 'full';
}

function mergeObservation(prior: ReadObservation | undefined, next: ReadObservation): ReadObservation {
  if (prior === 'full' || next === 'full') return 'full';
  if (prior === 'partial' || next === 'partial') return 'partial';
  return 'unknown';
}

function readObservations(activity: readonly ToolActivity[]): Map<string, ReadObservation> {
  const observations = new Map<string, ReadObservation>();
  for (const entry of activity) {
    if (!entry.ok || !READ_TOOL_NAMES.has(entry.name)) continue;
    const path = readPathFromLabel(entry.label);
    if (!path) continue;
    observations.set(path, mergeObservation(observations.get(path), observeReadCoverage(entry)));
  }
  return observations;
}

/**
 * The additive coverage map: `full` only for a complete, untruncated read.
 * An outline, range, truncation — or a read whose range evidence is unavailable —
 * is reported as `partial`, so a caller can see the turn did not prove a full read.
 */
export function readCoverageFromActivity(activity: readonly ToolActivity[]): Record<string, ReadCoverage> {
  const coverage: Record<string, ReadCoverage> = {};
  for (const [path, observation] of readObservations(activity)) {
    coverage[path] = observation === 'full' ? 'full' : 'partial';
  }
  return coverage;
}

/**
 * Which files this turn actually opened. Taken from the tool activity rather than
 * from the message history: the activity is what ran, and a file the model only
 * pasted into its prompt was never read.
 */
export function filesReadFromActivity(activity: readonly ToolActivity[]): string[] {
  const paths = new Set<string>();
  for (const entry of activity) {
    if (!entry.ok || !READ_TOOL_NAMES.has(entry.name)) continue;
    // Compared case-insensitively: the tool echoed whatever case the model typed,
    // while the patch and the disk can name the same file differently.
    const normalized = readPathFromLabel(entry.label);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

function trimmedSummary(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const value = line.trim();
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT)}…`;
}

/**
 * The request scope tightens milestone confinement: a file the planner declared
 * but the request did not target is refused, never written. With no scope the
 * milestone's own expectedFiles stand unchanged.
 */
function scopedExpectedFiles(expectedFiles: string[], scope?: RequestScope): string[] {
  const allowedPaths = scope?.allowedPaths;
  if (!allowedPaths || allowedPaths.length === 0) return expectedFiles;
  const inScope = new Set(allowedPaths.map((path) => normalizePolicyPath(path).toLowerCase()));
  return expectedFiles.filter((path) => inScope.has(normalizePolicyPath(path).toLowerCase()));
}

function stoppedOutcome(reason: string, input: AgentTurnInput): AgentTurnOutcome {
  return {
    reply: reason,
    summary: reason,
    applied: [],
    pendingReview: [],
    reviewNotes: [],
    reviewPatches: [],
    autoApply: [],
    patchFailures: [],
    filesRead: [],
    readCoverage: {},
    toolActivity: [],
    toolRounds: 0,
    capped: false,
    creditsSpent: input.ports.measureCredits?.() ?? 0,
    aborted: true,
    stopped: true,
    wroteNothing: true,
    error: null,
    plan: input.initialPlan ? [...input.initialPlan] : []
  };
}

/**
 * Runs one turn. Returns the changes split by what may be written now and what
 * must wait for the user, plus the tool activity that justifies the split.
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
  const aborted = () => input.signal?.aborted === true;
  // A Stop pressed before the turn even started must not open a billable request.
  if (aborted()) return stoppedOutcome('Stopped before this turn started.', input);

  const messages = input.ports.buildMessages(input.instruction);
  const loop = await input.ports.runToolRounds({
    messages,
    systemInstruction: input.systemInstruction,
    workspaceId: input.ports.workspaceId,
    stream: input.ports.stream,
    maxRounds: input.maxToolRounds,
    aborted,
    external: input.ports.external,
    initialPlan: input.initialPlan,
    onRound: input.onRound,
    onPlan: input.onPlan,
    policy: input.policy,
    signal: input.signal,
    onAttempt: input.onAttempt
  });

  const filesRead = filesReadFromActivity(loop.activity);
  const observations = readObservations(loop.activity);
  const base = {
    reply: loop.text,
    filesRead,
    readCoverage: readCoverageFromActivity(loop.activity),
    toolActivity: loop.activity,
    toolRounds: loop.rounds,
    capped: loop.capped,
    creditsSpent: input.ports.measureCredits?.() ?? 0,
    plan: loop.plan,
    finish: loop.finish
  };

  const emitActivity = (): void => {
    if (loop.activity.length > 0) input.onActivity?.(loop.activity);
  };
  emitActivity();

  // The user asked for this to end. A half-read file is not a reason to write it:
  // the workspace is left exactly as this turn found it. Reused after every await
  // so a Stop that lands mid-read or just before a write still forbids the write.
  const stopMidTurn = (): AgentTurnOutcome => ({
    ...base,
    summary: `Stopped mid-turn after ${loop.activity.length} tool call(s).`,
    applied: [],
    pendingReview: [],
    reviewNotes: [],
    reviewPatches: [],
    autoApply: [],
    patchFailures: [],
    aborted: true,
    stopped: true,
    wroteNothing: true,
    error: null
  });

  if (aborted()) return stopMidTurn();

  if (loop.error) {
    return {
      ...base,
      summary: trimmedSummary(loop.error),
      applied: [],
      pendingReview: [],
      reviewNotes: [],
      reviewPatches: [],
      autoApply: [],
      patchFailures: [],
      // A request that died because the user stopped it is a stop, not a clean
      // failure: never claim aborted:false once the signal has fired.
      aborted: aborted(),
      stopped: aborted(),
      wroteNothing: true,
      error: loop.error
    };
  }

  const patches = input.ports.extractPatches(loop.text);
  const { allowed, refused } = confinePatches(patches, scopedExpectedFiles(input.expectedFiles, input.policy?.scope));

  // An investigation task declared no files, so every change it emitted is out of
  // scope by definition and is reported as such instead of being quietly dropped.
  if (allowed.length === 0) {
    return {
      ...base,
      summary: loop.finish?.summary ?? trimmedSummary(loop.text),
      applied: [],
      pendingReview: [],
      reviewNotes: [],
      reviewPatches: [],
      autoApply: [],
      patchFailures: refused,
      aborted: aborted(),
      stopped: aborted(),
      // Nothing was cleared, so the workspace is exactly as this turn found it.
      wroteNothing: true,
      error: null
    };
  }

  const states = new Map<string, PolicyFileState>();
  for (const patch of allowed) {
    const current = await input.ports.readFile(patch.path);
    // A Stop that landed during the read forbids proceeding to any write.
    if (aborted()) return stopMidTurn();
    const normalized = normalizePolicyPath(patch.path).toLowerCase();
    states.set(patch.path, {
      exists: current !== null,
      // Both sides are normalised: the tool label and the patch path can differ
      // in slashes or a leading `./` while naming the same file. A partial read
      // (outline, range, truncation) never satisfies the full-read requirement;
      // when no range evidence exists the previous label-based behaviour stands.
      read: observations.get(normalized) === 'partial' ? false : filesRead.includes(normalized),
      content: current ?? undefined
    });
  }

  // Ask/Plan modes forbid writes: every cleared change is held for review rather
  // than written, and the writer port is never called. Agent mode keeps the
  // caller's apply policy.
  const writeAllowed = !input.policy || allowsEffect(input.policy.mode, 'write');
  const policy = writeAllowed ? resolvePolicy(input.applyPolicy) : 'review';
  const partition = partitionPatches(policy, allowed, (patch) => states.get(patch.path) ?? { exists: false, read: false });
  const pendingReview = partition.review.map((decision) => decision.patch.path);

  let applied: string[] = [];
  // Confinement refusals and write failures are the model's problem to repair.
  // Held-back files are not: they are the user's to accept, so they travel as
  // `pendingReview` and are never fed back into a repair brief as a refusal.
  let failures = [...refused];
  if (partition.auto.length > 0 && input.ports.writePatches) {
    // Last checkpoint before bytes reach disk: a stopped turn writes nothing.
    if (aborted()) return stopMidTurn();
    const written = await input.ports.writePatches(partition.auto);
    applied = written.applied;
    failures = [...failures, ...written.failures];
  }

  return {
    ...base,
    summary: loop.finish?.summary ?? trimmedSummary(loop.text),
    applied,
    pendingReview,
    reviewNotes: partition.reviewNotes,
    reviewPatches: partition.review.map((decision) => decision.patch),
    autoApply: input.ports.writePatches ? [] : partition.auto,
    patchFailures: failures,
    // The write await is the last place a Stop can land; report it honestly
    // rather than claiming a clean finish after the signal fired.
    aborted: aborted(),
    stopped: aborted(),
    wroteNothing: applied.length === 0 && pendingReview.length === 0,
    error: null
  };
}

/**
 * The one line an orchestration card shows when a turn ended with changes the
 * user still has to accept. It is the difference between "the run did nothing"
 * and "three files are waiting on you".
 */
export function turnReviewLine(outcome: AgentTurnOutcome): string {
  return reviewSummaryLine(outcome.pendingReview, outcome.reviewNotes);
}
