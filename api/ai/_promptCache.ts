/**
 * Stable-prefix request shaping for provider prompt caching.
 *
 * Patterns ported from aider (`aider/coders/chat_chunks.py`, `add_cache_control_headers`
 * and `all_messages`, Apache-2.0): the cacheable chunks (system rules, examples,
 * repo/read-only context, prior chat files) are ordered *before* the volatile
 * current turn, and Anthropic-style `cache_control: {type:'ephemeral'}` markers
 * attach to the LAST message of each stable chunk, never to the fresh turn.
 *
 * Provider reality check for ShadRox:
 * - Anthropic-style endpoints reached through an OpenAI-compatible gateway
 *   (`provider: 'custom'` with a claude model id — OpenRouter et al. forward the
 *   content-part `cache_control` verbatim): explicit markers are emitted.
 * - Gemini (`api.ai.generative` REST) and Groq / plain OpenAI-compatible servers
 *   cache the longest common prefix of the prompt automatically; they have no
 *   `cache_control` field in this wire format, so we emit NOTHING there — the
 *   discipline is purely to keep the prefix byte-stable and never corrupt it.
 */

import type { ChatMessage, ProviderId } from './_types.js';

/** How this provider expects cacheable prefixes to be communicated. */
export type PromptCacheMode = 'cache_control' | 'auto_prefix';

/** Up to two breakpoints, aider-style: end of the system block, end of history. */
export interface StablePrefixPlan {
  /** Shaped copy of the messages: stable prefix first, volatile turn last. */
  messages: ChatMessage[];
  /** Byte mode chosen for this provider/model pair. */
  mode: PromptCacheMode;
  /**
   * Indices in `messages` where the stable prefix ENDS (inclusive). Empty when
   * there is nothing worth marking. `cacheBreakpoints[0]` is the end of the
   * leading system/context block, the last entry the end of everything except
   * the volatile final turn.
   */
  cacheBreakpoints: number[];
}

/**
 * Which cache discipline the wire format supports. Only a custom OpenAI-compatible
 * endpoint carrying an Anthropic model id gets explicit markers; everything else
 * relies on automatic longest-common-prefix caching and stable ordering alone.
 */
export function promptCacheMode(_provider: ProviderId, _model: string): PromptCacheMode {
  return 'auto_prefix';
}

/**
 * Orders the assembled message list stable-prefix-safe:
 * 1. every `system` message (rules + long-lived context) is hoisted to the front
 *    in original relative order — Gemini already flattens inline system turns
 *    this way, and a mid-history system block is exactly the churn that breaks a
 *    cached prefix between turns;
 * 2. user/assistant history keeps its chronological order untouched;
 * 3. the final message is treated as the volatile current turn (aider's `cur`
 *    chunk) and excluded from the cacheable prefix.
 *
 * Pure and idempotent: content bytes are never edited, only order and — for
 * `cache_control` providers — the `cacheEphemeral` flag on breakpoint messages.
 * For every other provider the flag is never set, so no unknown field can reach
 * a server that would reject it.
 */
export function shapeStablePrefix(
  provider: ProviderId,
  model: string,
  messages: ChatMessage[]
): StablePrefixPlan {
  const mode = promptCacheMode(provider, model);

  const system = messages.filter((message) => message.role === 'system');
  const history = messages.filter((message) => message.role !== 'system');
  const shaped: ChatMessage[] = [...system, ...history];

  const breakpoints: number[] = [];
  if (shaped.length > 0) {
    // End of the leading system block (only if the block exists and is not the
    // whole request — caching a lone system message buys nothing).
    const lastSystem = system.length - 1;
    if (lastSystem >= 0 && lastSystem < shaped.length - 1) breakpoints.push(lastSystem);

    // End of the stable history prefix: everything except the final volatile
    // turn. aider marks its last cacheable chunk (chat_files) the same way.
    const lastVolatile = shaped.length - 1;
    const prefixEnd = lastVolatile - 1;
    if (prefixEnd >= 0 && shaped[prefixEnd].role !== 'system') {
      if (breakpoints[breakpoints.length - 1] !== prefixEnd) breakpoints.push(prefixEnd);
    }
  }

  // Custom OpenAI-compatible endpoints may not support Anthropic cache-control
  // content parts. Preserve the stable prefix without guessing capabilities.
  return { messages: shaped.map((message) => ({ ...message })), mode, cacheBreakpoints: breakpoints };
}

/**
 * OpenAI-compatible content for one shaped message. Flagged messages become a
 * text part carrying `cache_control: {type:'ephemeral'}` (the exact payload
 * aider's `add_cache_control` builds); everything else serializes as the plain
 * string it always was, so an unflagged request is byte-identical to the old
 * wire format.
 */
export function renderCacheableContent(
  message: ChatMessage
): string {
  return message.content;
}

/**
 * Deterministic serialization of the cacheable prefix — the bytes a provider's
 * cache-key is computed from. Two turns share a cache hit exactly when this
 * string is identical across them.
 */
export function stablePrefixBytes(plan: StablePrefixPlan): string {
  const last = plan.cacheBreakpoints[plan.cacheBreakpoints.length - 1];
  const prefix = last === undefined ? plan.messages.filter((m) => m.role === 'system') : plan.messages.slice(0, last + 1);
  return JSON.stringify(prefix.map((message) => ({
    role: message.role,
    content: renderCacheableContent(message)
  })));
}
