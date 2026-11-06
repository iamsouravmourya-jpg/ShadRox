/**
 * Token budgeting and context pruning.
 *
 * Ported from Void's weighted message trimmer
 * (reference/void-main/src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts)
 * and stripped of every VS Code dependency. Void's rules:
 *
 * - No real tokenizer: CHARS_PER_TOKEN = 4.
 * - Half the context window is reserved for the model's output.
 * - Every message gets a trim weight; the greedy loop cuts the heaviest
 *   message down to TRIM_TO_LEN chars (plus "...") until the budget fits.
 * - Assistant/tool history is trimmed first (×10), system last (×0.01),
 *   and the first + last messages are treated as nearly untouchable (×0.05).
 * - Older messages weigh more than newer ones (index ramp 2 → 1).
 *
 * The weight is now only a tie-breaker. The primary key is the single
 * documented drop order merged with Cline's context management, in
 * `./compaction/pairOrder.ts`, and the cut itself is pair-safe: a tool
 * call/result fence is folded, never sliced away.
 */

import {
  TRIM_ORDER,
  USER_ASK_MIN_CHARS,
  hasToolFence,
  pairAnchorIndices,
  pairFloorChars,
  pairGroupsFromAnchors,
  pairSafeShrink,
  trimStageOf,
  trimStageRank,
  trimStageNote,
  type TrimStage
} from './compaction/pairOrder';

export const CHARS_PER_TOKEN = 4;
export const TRIM_TO_LEN = 120;
export const MAX_TRIM_ITERATIONS = 100;
export const MIN_BUDGET_CHARS = 5_000;
export const RESERVED_OUTPUT_FLOOR_TOKENS = 4_096;
export const MAX_SYSTEM_INSTRUCTION_CHARS = 80_000;

export interface BudgetedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TrimResult {
  messages: BudgetedMessage[];
  /** Messages shortened by the trimmer. */
  trimmed: number;
  /** Characters dropped in total. */
  trimmedChars: number;
  /** Stages of the documented order this pass spent, in order. See `TRIM_ORDER`. */
  stages: TrimStage[];
}

/** Rough token count, matching Void's chars/4 heuristic. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens kept aside so the model always has room to answer.
 *
 * When the caller knows the model's hard `maxOutput` ceiling (from
 * `resolveCapabilities`), that value is used directly — it is always more
 * accurate than "half the window". The floor still applies so we never
 * reserve less than `RESERVED_OUTPUT_FLOOR_TOKENS`.
 */
export function reservedOutputTokens(contextWindow: number, maxOutput?: number): number {
  if (maxOutput !== undefined && maxOutput > 0) {
    return Math.max(maxOutput, RESERVED_OUTPUT_FLOOR_TOKENS);
  }
  return Math.max(Math.floor(contextWindow / 2), RESERVED_OUTPUT_FLOOR_TOKENS);
}

/** Maximum characters the request (messages) may occupy for a given model. */
export function messageBudgetChars(contextWindow: number, maxOutput?: number): number {
  const reserved = reservedOutputTokens(contextWindow, maxOutput);
  return Math.max((contextWindow - reserved) * CHARS_PER_TOKEN, MIN_BUDGET_CHARS);
}

const ROLE_MULTIPLIER: Record<BudgetedMessage['role'], number> = {
  system: 0.01,
  user: 1,
  assistant: 10
};

/** Older messages are cheaper to lose than recent ones. */
function indexMultiplier(index: number, count: number): number {
  if (count <= 1) return 1;
  return 2 - index / (count - 1);
}

/**
 * Trims message history into the model's budget. Returns a new array; the input
 * is never mutated.
 *
 * Pass `maxOutput` (from `resolveCapabilities`) so the output reservation uses
 * the real per-model ceiling rather than the "half the window" heuristic.
 *
 * The victim choice is no longer a bare weight comparison. It is the single
 * documented order in `./compaction/pairOrder.ts` (Cline's drop order merged
 * with the OpenHands condenser policy), applied as the primary key with Void's
 * weighted score as the tie-breaker inside a stage:
 *
 *   tool call/result payloads → older assistant prose → older typed asks (down
 *   to `USER_ASK_MIN_CHARS`) → and only as a last resort the ask floor itself.
 *   System blocks are never shrunk here (×0.01 plus `capSystemInstruction`),
 *   the newest turn is never touched, and a message is trimmed through
 *   `pairSafeShrink`, which folds the text *around* a tool fence and keeps the
 *   fence itself — so a truncated history can never end up holding a tool
 *   result whose call was cut away.
 *
 * Whole pair groups (a tool call and the observation that answered it) are
 * trimmed in the same pass, the way Cline drops them in the same pass.
 */
export function trimMessagesToBudget(
  messages: BudgetedMessage[],
  contextWindow: number,
  maxOutput?: number,
): TrimResult {
  const budget = messageBudgetChars(contextWindow, maxOutput);
  const result = messages.map((message) => ({ ...message }));
  let total = result.reduce((sum, message) => sum + message.content.length, 0);
  let trimmed = 0;
  let trimmedChars = 0;
  let iterations = 0;
  const stages = new Set<TrimStage>();

  /** How short this message may get in this phase without breaking a tool pair. */
  const floorFor = (index: number, phase: 'staged' | 'last_resort'): number => {
    const message = result[index];
    const structural = hasToolFence(message.content)
      ? pairFloorChars(message.content, TRIM_TO_LEN)
      : TRIM_TO_LEN;
    if (phase === 'staged' && trimStageOf(message.role, message.content) === 'user_ask') {
      // Cline's typed prompts survive, as an arithmetic floor rather than
      // immunity: immunity would overflow the window on a single huge paste.
      return Math.max(structural, Math.min(USER_ASK_MIN_CHARS, message.content.length));
    }
    return structural;
  };

  /** Stage rank dominates, Void's weight breaks the tie inside a stage. */
  const victimScore = (index: number, last: number): number => {
    const message = result[index];
    return trimStageRank(trimStageOf(message.role, message.content)) * 1e9 +
      trimWeightOf(message, index, result.length, last);
  };

  // Phase 1 honours the typed-ask floor; phase 2 is the last resort that lets a
  // single absurd paste come down to the ordinary trim length.
  for (const phase of ['staged', 'last_resort'] as const) {
    if (total <= budget) break;
    const settled = result.map(() => false);

    while (total > budget && iterations < MAX_TRIM_ITERATIONS) {
      iterations += 1;
      const last = result.length - 1;
      const groups = pairGroupsFromAnchors(pairAnchorIndices(result.map((message) => message.content)));

      // The current turn starts at the newest typed ask (a user message without
      // a tool fence); everything from there on is the live exchange.
      let newestTurnStart = result.length - 1;
      for (let index = result.length - 1; index >= 0; index--) {
        const message = result[index]!;
        if (message.role === 'user' && !hasToolFence(message.content)) {
          newestTurnStart = index;
          break;
        }
      }
      const pick = (skipNewestTurn: boolean, skipHead: boolean): number[] => {
        let chosen: number[] = [];
        let bestScore = -Infinity;
        groups.forEach((members) => {
          if (skipNewestTurn && members.some((index) => index >= newestTurnStart)) return;
          if (skipHead && members.includes(0)) return;
          const eligible = members.filter((index) => {
            if (settled[index]) return false;
            const message = result[index];
            // Stage 6: rules/repo-map blocks are degraded by
            // `capSystemInstruction`, never by this loop.
            if (message.role === 'system') return false;
            return message.content.length > floorFor(index, phase);
          });
          if (eligible.length === 0) return;
          const score = Math.max(...eligible.map((index) => victimScore(index, last)));
          if (score > bestScore) {
            bestScore = score;
            chosen = eligible;
          }
        });
        return chosen;
      };

      // The newest turn is the last thing this loop may touch, and the
      // originating head goes before it. Without this ladder a fresh tool
      // observation outranks old prose purely by stage and gets folded while
      // the history it belongs to stays intact.
      //
      // Ladder: older turns → the head → the newest turn.
      let victims = pick(true, true);
      if (victims.length === 0) victims = pick(true, false);
      if (victims.length === 0) victims = pick(false, false);

      if (victims.length === 0) break;

      victims.forEach((index) => {
        const message = result[index];
        const before = message.content.length;
        const target = phase === 'staged' && trimStageOf(message.role, message.content) === 'user_ask'
          ? Math.min(USER_ASK_MIN_CHARS, before)
          : TRIM_TO_LEN;
        const next = pairSafeShrink(message.content, target);
        if (next.length >= before) {
          // Nothing left to take without breaking a pair: stop offering it.
          settled[index] = true;
          return;
        }
        stages.add(trimStageOf(message.role, message.content));
        message.content = next;
        trimmed += 1;
        trimmedChars += before - next.length;
        if (next.length <= target + 3) settled[index] = true;
      });

      total = result.reduce((sum, message) => sum + message.content.length, 0);
    }
  }

  return { messages: result, trimmed, trimmedChars, stages: orderStages(stages) };
}

/** Void's weight for one message — the tie-breaker inside a stage. */
function trimWeightOf(message: BudgetedMessage, index: number, count: number, last: number): number {
  const edgeMultiplier = index === 0 || index === last ? 0.05 : 1;
  return (
    message.content.length *
    ROLE_MULTIPLIER[message.role] *
    indexMultiplier(index, count) *
    edgeMultiplier
  );
}

/** Stage order as the app documents it, oldest-cheapest-first, for the notice. */
function orderStages(used: ReadonlySet<TrimStage>): TrimStage[] {
  return TRIM_ORDER.filter((stage) => used.has(stage));
}

/** Hard cap for the system instruction so a huge context dump cannot crowd out the reply. */
export function capSystemInstruction(text: string, maxChars = MAX_SYSTEM_INSTRUCTION_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n… [system context trimmed, ${text.length} chars total] …\n\n`;
  const headChars = Math.floor((maxChars - marker.length) * 0.6);
  const tailChars = maxChars - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

/* ------------------------------------------------------------------ *
 * System-instruction accounting
 *
 * `trimMessagesToBudget()` only ever counted the message array, and
 * `capSystemInstruction()` only knew a global 80k ceiling. The system
 * instruction — repo map + retrieved chunks + up to 12k chars of the active
 * file — is billed against the same window as the history, so a request the
 * client believed was in budget could still come back as an opaque provider
 * error. `api/ai/_budget.ts` fixes the server side; this mirrors the same
 * arithmetic on the client so we never send a request we already know is too
 * big, and degrades the instruction instead of failing.
 * ------------------------------------------------------------------ */

import { scrubWorkspaceText } from './envSafety';
import { markUntrustedData } from './untrustedData';

/** Share of the input budget the system instruction may occupy (server parity). */
export const SYSTEM_INSTRUCTION_RATIO = 0.6;

/** How far a file excerpt may be shrunk before it is reduced to a notice. */
export const MIN_FILE_EXCERPT_CHARS = 1_200;

export type SystemDegradation = 'none' | 'chunks' | 'file' | 'truncated';

export interface SystemFileExcerpt {
  /** Already-formatted heading line, e.g. `Active file (src/App.tsx):`. */
  label: string;
  language: string;
  content: string;
  /** The most of the file this request wants to show. */
  maxChars: number;
}

/** The system instruction as structured parts, so it can be degraded piecewise. */
export interface SystemContext {
  /** Never dropped or shrunk: role, edit protocol, repo map, diagnostics. */
  core: string[];
  /** Heading written above the retrieved chunks, e.g. `RELEVANT CONTEXT (auto-retrieved):`. */
  chunkHeader: string;
  /**
   * Retrieved chunks, best first. When the window is tight these go away from
   * the tail — the weakest, last-added matches — before anything else.
   */
  chunks: string[];
  /** File excerpts shown verbatim; shrunk before the instruction is truncated. */
  files: SystemFileExcerpt[];
}

export interface FittedSystemContext {
  text: string;
  degradation: SystemDegradation;
  droppedChunks: number;
  /** How many file excerpts had to be shortened. */
  shrunkFiles: number;
  budgetChars: number;
}

export interface ChatRequestFit {
  messages: BudgetedMessage[];
  systemInstruction: string | undefined;
  trimmed: number;
  trimmedChars: number;
  /** Which stages of the documented trim order were spent. */
  stages: TrimStage[];
  system: FittedSystemContext;
}

/**
 * The instruction ceiling for a model: 60% of the input budget, floored so tiny
 * windows still get a usable prompt, never above the global 80k cap.
 */
export function systemInstructionBudgetChars(contextWindow: number, maxOutput?: number): number {
  const inputBudget = messageBudgetChars(contextWindow, maxOutput);
  return Math.min(
    MAX_SYSTEM_INSTRUCTION_CHARS,
    Math.max(MIN_BUDGET_CHARS, Math.floor(inputBudget * SYSTEM_INSTRUCTION_RATIO))
  );
}

function renderFile(excerpt: SystemFileExcerpt, content: string, truncated: boolean): string {
  const marker = truncated
    ? `\n… [${excerpt.label} trimmed to ${content.length} of ${excerpt.content.length} chars] …`
    : '';
  return markUntrustedData(
    `${excerpt.label}\n\`\`\`${excerpt.language}\n${content}${marker}\n\`\`\``,
    `workspace file excerpt (${excerpt.label.replace(/:$/, '')})`
  );
}

/**
 * Fits the system instruction into `maxChars` by degrading it in a fixed
 * priority order: weakest retrieval chunks first, then file excerpts (halved
 * down to a floor), and only as a last resort a hard truncation with a notice.
 * Never throws and never returns something over budget.
 */
export function fitSystemContext(system: SystemContext, maxChars: number): FittedSystemContext {
  const core = system.core.map(scrubWorkspaceText).filter((section) => section.trim().length > 0);
  let kept = system.chunks.map(scrubWorkspaceText);
  const files = system.files.map((excerpt) => ({
    excerpt,
    content: scrubWorkspaceText(excerpt.content).slice(0, excerpt.maxChars),
    // The excerpt as the caller asked for it, before any budget was applied.
    wanted: Math.min(scrubWorkspaceText(excerpt.content).length, excerpt.maxChars)
  }));

  const render = () => {
    const chunkSection = kept.length > 0 && system.chunkHeader
      ? [`${system.chunkHeader}\n${markUntrustedData(kept.join('\n\n'), 'auto-retrieved workspace file chunks')}`]
      : [];
    const fileSections = files.map((file) =>
      renderFile(file.excerpt, file.content, file.content.length < file.wanted)
    );
    return [...core, ...chunkSection, ...fileSections].join('\n\n');
  };

  const droppedChunks = () => system.chunks.length - kept.length;
  const shrunkFiles = () => files.filter((file) => file.content.length < file.wanted).length;

  let text = render();
  if (text.length <= maxChars) {
    return { text, degradation: 'none', droppedChunks: 0, shrunkFiles: shrunkFiles(), budgetChars: maxChars };
  }

  // 1. Drop the weakest chunks, one at a time, lowest-ranked (tail) first.
  while (kept.length > 0 && text.length > maxChars) {
    kept.pop();
    text = render();
  }
  if (text.length <= maxChars) {
    return {
      text,
      degradation: droppedChunks() > 0 ? 'chunks' : 'none',
      droppedChunks: droppedChunks(),
      shrunkFiles: shrunkFiles(),
      budgetChars: maxChars
    };
  }

  // 2. Shrink file excerpts, biggest first, halving down to the floor.
  let guard = 0;
  while (text.length > maxChars && guard < 40) {
    guard += 1;
    const shrinkable = files
      .filter((file) => file.content.length > MIN_FILE_EXCERPT_CHARS)
      .sort((a, b) => b.content.length - a.content.length);
    if (shrinkable.length === 0) break;
    shrinkable.forEach((file) => {
      file.content = file.content.slice(0, Math.max(MIN_FILE_EXCERPT_CHARS, Math.floor(file.content.length / 2)));
    });
    text = render();
  }
  if (text.length <= maxChars) {
    return {
      text,
      degradation: 'file',
      droppedChunks: droppedChunks(),
      shrunkFiles: shrunkFiles(),
      budgetChars: maxChars
    };
  }

  // 3. Last resort: hard truncation with an explicit in-prompt notice, so the
  //    model knows its context was cut rather than silently seeing less.
  const truncated = capSystemInstruction(
    `${text}\n\n[Context window limit reached — some workspace context was omitted from this message.]`,
    maxChars
  );
  return {
    text: truncated,
    degradation: 'truncated',
    droppedChunks: droppedChunks(),
    shrunkFiles: files.length,
    budgetChars: maxChars
  };
}

/**
 * The whole request, measured against the model's window: the instruction is
 * fitted first, then its tokens are subtracted from the window before the
 * history is trimmed. Same arithmetic as the server, run before sending.
 */
export function fitChatRequest(options: {
  contextWindow: number;
  messages: BudgetedMessage[];
  system?: SystemContext;
  /** The model's per-response ceiling, from `resolveBudgetCapabilities`. */
  maxOutput?: number;
}): ChatRequestFit {
  const systemCap = systemInstructionBudgetChars(options.contextWindow, options.maxOutput);
  const system = options.system
    ? fitSystemContext(options.system, systemCap)
    : { text: '', degradation: 'none' as SystemDegradation, droppedChunks: 0, shrunkFiles: 0, budgetChars: systemCap };

  const systemTokens = system.text ? estimateTokens(system.text) : 0;
  // Never let the instruction starve the conversation below a workable floor.
  const effectiveWindow = Math.max(1_000, options.contextWindow - systemTokens);
  const trimmed = trimMessagesToBudget(options.messages, effectiveWindow, options.maxOutput);

  return {
    messages: trimmed.messages,
    systemInstruction: system.text || undefined,
    trimmed: trimmed.trimmed,
    trimmedChars: trimmed.trimmedChars,
    stages: trimmed.stages,
    system
  };
}

/** Non-blocking one-line summary of what had to be dropped, or null. */
export function contextFitNotice(fit: ChatRequestFit, modelLabel?: string): string | null {
  const { degradation, droppedChunks, shrunkFiles } = fit.system;
  const parts: string[] = [];

  if (degradation === 'chunks' || degradation === 'file' || degradation === 'truncated') {
    if (droppedChunks > 0) parts.push(`${droppedChunks} retrieved chunk(s) dropped`);
    if (degradation === 'file' && shrunkFiles > 0) parts.push(`${shrunkFiles} file excerpt(s) shortened`);
    if (degradation === 'truncated') parts.push('workspace context truncated');
  }
  if (fit.trimmed > 0) {
    const stages = trimStageNote(fit.stages ?? []);
    parts.push(stages
      ? `${fit.trimmed} older message(s) shortened (${stages})`
      : `${fit.trimmed} older message(s) shortened`);
  }
  if (parts.length === 0) return null;

  return `Context window is full${modelLabel ? ` for ${modelLabel}` : ''}: ${parts.join(' + ')} to make room for the reply.`;
}
