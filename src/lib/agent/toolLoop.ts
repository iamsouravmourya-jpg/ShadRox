import type { ChatTurn } from '../ai';
import { availableToolNames, classifyToolEffect, isControlTool, isKnownTool, runTool, summarizeCall, type ToolCall, type ToolOutcome } from './tools';
import type { McpToolHandle } from './mcpTools';
import { parseToolBlocks, serializeCallKey, serializeResults, stripToolBlocks } from './toolProtocol';
import { applyTaskUpdates, completionGuard, renderTaskPlan, type TaskPlan } from './taskPlan';
import { detectStuck, stuckInstruction, type StuckRound } from './stuck';
import { FINISH_TOOL_NAME, parseFinishArguments } from './finishTool';
import { allowsEffect, type RunPolicy, type ToolEffect } from './runPolicy';
import type { AttemptRecord, AttemptState } from '../taskUsage';
import type { FailureReceipt } from '../repairProof';

/**
 * Runs the tool rounds of one assistant turn.
 *
 * The caller supplies `stream`, so this stays a pure control loop: the same code
 * drives a chat turn and a headless autonomous milestone, and the tests can drive
 * it with a scripted fake instead of a paid provider call.
 *
 * Disk tools stay explicit; the only processes that run here are the one-line
 * shell command the user asked for and an external MCP tool they configured.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 5;
export const MAX_CALLS_PER_ROUND = 6;
const FINAL_ASK =
  'Tool budget for this answer is finished. Write the final answer now using what you have read; name any file you did not get to instead of guessing about it.';

/**
 * Workspace-exploration intent: the asks that must not be answered from memory.
 * Deliberately narrow verbs plus codebase objects, so "why does this line
 * throw?" keeps its old single-round path.
 */
const EXPLORATION_INTENT =
  /\b(scan|explore|walkthrough|overview|explain|analys[ei]s?\w*|analyz\w*|what (is|does) (this|the) (project|codebase|repo\w*|folder|application|app))\b/i;

const EXPLORATION_NUDGE =
  'You have not inspected the workspace yet. Use the read/search tools to examine the code before answering.';

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
}

function controlOutcome(call: ToolCall, plan: TaskPlan, guardUsed: boolean): { outcome: ToolOutcome; plan: TaskPlan; finish?: { summary: string; blocked: string | null }; stop: boolean } {
  if (call.name === FINISH_TOOL_NAME) {
    const args = parseFinishArguments(call.args);
    if (!args) {
      return { outcome: { ok: false, content: '', error: 'finish needs {"summary":"the answer for the user"}.' }, plan, stop: false };
    }
    const warning = completionGuard(plan, true);
    if (warning && !guardUsed) {
      return { outcome: { ok: false, content: '', error: warning }, plan, stop: false };
    }
    return { outcome: { ok: true, content: 'Turn finished.' }, plan, finish: args, stop: true };
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

export async function runToolRounds(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const messages = [...input.messages];
  const activity: ToolActivity[] = [];
  const policy = input.policy;
  const isAborted = (): boolean => input.aborted() || input.signal?.aborted === true;
  // Outcome/version-aware dedup: a key is only a duplicate while it last
  // succeeded at the current mutation epoch. A failed or refused call is never
  // recorded, so it can retry; a successful mutation bumps the epoch so reads and
  // tests can rerun against the changed workspace.
  let epoch = 0;
  const lastSuccessEpoch = new Map<string, number>();
  let attemptSeq = 0;
  let plan: TaskPlan = input.initialPlan ? [...input.initialPlan] : [];
  const external = input.external;
  // One listing per turn: rounds then reuse the same routes instead of re-querying
  // every server, and a dead server costs the turn nothing.
  if (external) await external.discover();
  const offeredExternal = (name: string): boolean => Boolean(external?.has(name));
  const externalNames = external ? external.describe().map((tool) => tool.name) : [];
  const history: StuckRound[] = [];
  let text = '';
  let round = 0;
  let capped = false;
  let guardUsed = false;
  let stuckNudged = false;
  let finished: { summary: string; blocked: string | null } | null = null;
  let failureProof: FailureReceipt | null = null;
  const stamp = (result: ToolLoopResult): ToolLoopResult => (failureProof ? { ...result, failureProof } : result);

  // The user's ask as issued, not the running transcript: observations and
  // nudges also arrive as `user` turns, so the intent is read once up front.
  const latestUserAsk = [...input.messages].reverse().find((turn) => turn.role === 'user')?.content ?? '';
  const wantsExploration = EXPLORATION_INTENT.test(latestUserAsk);
  let nudgeUsed = false;
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

  /** The cap is reached: one more stream, with instructions to answer now. */
  const forceFinal = async (currentRound: number, ask: string): Promise<ToolLoopResult> => {
    capped = true;
    if (isAborted()) return stamp({ text, rounds: currentRound, activity, capped, error: null, plan });
    messages.push({ role: 'user', content: ask });
    const final = await streamWithAttempt(messages, currentRound);
    if (isAborted()) return stamp({ text: stripToolBlocks(final.text), rounds: currentRound + 1, activity, capped, error: null, plan });
    const stripped = stripToolBlocks(final.text);
    if (stripped.trim() || final.error) {
      return stamp({ text: stripped, rounds: currentRound + 1, activity, capped, error: final.error, plan });
    }
    // The model answered the order with another tool block: it still owes an
    // answer, and an empty reply is worse than the round it costs to avoid it.
    messages.push({ role: 'assistant', content: final.text });
    messages.push({ role: 'user', content: FINAL_ASK });
    if (isAborted()) return stamp({ text: '', rounds: currentRound + 1, activity, capped, error: null, plan });
    const again = await streamWithAttempt(messages, currentRound + 1);
    return stamp({
      text: stripToolBlocks(again.text),
      rounds: currentRound + 2,
      activity,
      capped,
      error: again.error,
      plan
    });
  };

  while (true) {
    if (isAborted()) return stamp({ text, rounds: round, activity, capped: false, error: null, plan });
    const streamed = await streamWithAttempt(messages, round);
    if (isAborted()) return stamp({ text: streamed.text, rounds: round, activity, capped: false, error: null, plan });
    round += 1;
    text = streamed.text;
    input.onRound?.(round - 1, streamed.text);
    if (streamed.error) return stamp({ text, rounds: round, activity, capped: false, error: streamed.error, plan });

    const blocks = parseToolBlocks(streamed.text);
    if (blocks.length === 0) {
      if (mayNudgeExploration()) {
        nudgeUsed = true;
        if (streamed.text.trim()) messages.push({ role: 'assistant', content: streamed.text });
        messages.push({ role: 'user', content: EXPLORATION_NUDGE });
        continue;
      }
      return stamp({ text, rounds: round, activity, capped: false, error: null, plan });
    }

    const fresh: ToolCall[] = [];
    const freshKeys: string[] = [];
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
        const succeededAt = lastSuccessEpoch.get(key);
        if (succeededAt !== undefined && succeededAt === epoch) {
          problems.push(`${summarizeCall(call)} already succeeded this turn and nothing has changed since — its result is in the history above. Ask for something different.`);
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
    // The cap is applied after dedupe, so a refused duplicate cannot steal a slot.
    const usable = fresh.slice(0, MAX_CALLS_PER_ROUND);
    const cut = fresh.slice(MAX_CALLS_PER_ROUND);
    if (cut.length > 0) {
      // Deliberately not recorded as succeeded: a call that never ran must stay
      // runnable next round instead of being refused as a duplicate.
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
    }

    if (usable.length === 0) {
      // The model keeps asking for calls that were already run or were malformed:
      // that is the loop the stuck detector exists to catch, so it counts as a
      // round even though nothing executed.
      history.push({ calls: blocks.flatMap((block) => block.calls).map(serializeCallKey), changedFiles: 0 });
      const stuck = detectStuck(history);
      if (stuck) {
        const ask = stuckInstruction(stuck);
        if (!stuckNudged && round < maxRounds) {
          stuckNudged = true;
          messages.push({ role: 'assistant', content: streamed.text });
          messages.push({ role: 'user', content: ask });
          continue;
        }
        return await forceFinal(round, ask);
      }
      if (round >= maxRounds) return await forceFinal(round, FINAL_ASK);
      messages.push({ role: 'assistant', content: streamed.text });
      messages.push({
        role: 'user',
        content: `No tool call could run: ${problems.join(' ') || 'the block was empty.'}\nEither emit a valid \`\`\`shadrox:tools block or answer now.`
      });
      continue;
    }

    const runnable: number[] = [];
    const outcomes: ToolOutcome[] = usable.map((call, index) => {
      if (!isControlTool(call.name)) {
        runnable.push(index);
        return { ok: false, content: '' };
      }
      const handled = controlOutcome(call, plan, guardUsed);
      guardUsed = guardUsed || !handled.outcome.ok;
      plan = handled.plan;
      if (handled.finish) finished = handled.finish;
      return handled.outcome;
    });
    input.onPlan?.(plan);

    let batchDurationMs: number | undefined;
    if (runnable.length > 0) {
      const batch = runnable.map((index) => usable[index]);
      const isExternal = batch.map((call) => offeredExternal(call.name));
      if (isExternal.some((externalCall) => !externalCall) && !input.workspaceId) {
        return {
          text: stripToolBlocks(streamed.text),
          rounds: round,
          activity,
          capped: false,
          error: 'The assistant asked to read files, but no folder workspace is open, so no tool can run.',
          plan
        };
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
    history.push({ calls: usable.map((call) => serializeCallKey(call)), changedFiles: 0 });
    if (input.aborted()) return stamp({ text: stripToolBlocks(streamed.text), rounds: round, activity, capped: false, error: null, plan });

    messages.push({ role: 'assistant', content: streamed.text });
    const observation = serializeResults(usable.map((call, index) => {
      const { proof: _proof, ...rest } = outcomes[index];
      return { name: call.name, ...rest };
    }));
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
        finish: finished as { summary: string; blocked: string | null }
      });
    }

    const stuck = detectStuck(history);
    if (stuck) {
      const ask = stuckInstruction(stuck);
      if (!stuckNudged && round < maxRounds) {
        stuckNudged = true;
        messages.push({ role: 'user', content: ask });
        continue;
      }
      return await forceFinal(round, ask);
    }

    if (round >= maxRounds) return await forceFinal(round, FINAL_ASK);
  }
}
