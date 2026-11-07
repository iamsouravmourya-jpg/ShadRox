/**
 * Stable-prefix request shaping and cache-marker emission for provider prompt caching.
 *
 * Chunk-ordering patterns are ported from aider (`aider/coders/chat_chunks.py`,
 * `add_cache_control_headers` and `all_messages`, Apache-2.0): the cacheable chunks
 * (system rules, examples, repo/read-only context, prior chat files) are ordered
 * *before* the volatile current turn, and Anthropic-style `cache_control:
 * {type:'ephemeral'}` markers attach to the LAST message of each stable chunk,
 * never to the fresh turn.
 *
 * What this module decides, per provider family, and what actually goes on the wire:
 *
 * - `cache_control` — `provider: 'custom'` carrying an Anthropic/Claude model id.
 *   OpenAI-compatible gateways in front of Anthropic (Anthropic's own
 *   `/v1beta/openai` shim, OpenRouter, Vertex's OpenAI-compatible endpoint)
 *   forward the OpenAI *content-part* form verbatim, so a flagged message is
 *   serialized as `content: [{type:'text', text, cache_control:{type:'ephemeral'}}]`
 *   on the breakpoint messages only. That is the only family in ShadRox's set with a
 *   cache field in the wire format, so it is the only family that gets an explicit
 *   marker. `_compatible.ts` also resends the request unmarked when such an endpoint
 *   rejects the content-part form, so an unknown gateway can never fail because of
 *   this module.
 * - `system_instruction_prefix` — Gemini (`api.ai.generative` REST). The
 *   `generateContent` wire format has no per-message cache field, and creating an
 *   explicit `cachedContents` resource is deliberately NOT done here: it needs a
 *   second billed round-trip per new prefix (`POST /v1beta/cachedContents`, min
 *   1024/4096 tokens, TTL renewals) and its own invalidation ladder, and a stale
 *   `cachedContent` id fails the turn the user is paying for. What Gemini does
 *   count automatically is the leading prompt prefix — and the part of the request
 *   it holds outside the turn list is `systemInstruction`. So the marker for this
 *   family is *placement*: every stable block (the caller's system instruction plus
 *   all inline system turns) is hoisted into the top-level `systemInstruction`, the
 *   turn list stays append-only, and `usageMetadata.cachedContentTokenCount` then
 *   reports the hit. See `_gemini.ts`.
 * - `auto_prefix` — Groq and every non-Anthropic OpenAI-compatible server. Both
 *   cache the longest common prompt prefix implicitly and expose no cache field in
 *   this format, so NOTHING is added to the body; the discipline is byte-stable
 *   ordering (system + repo-map/contract blocks first, volatile turn last) and
 *   never re-ordering the prefix between turns.
 *
 * `prompt_cache_key` is documented by OpenAI only, so it is emitted for the
 * OpenAI host on the custom path and never for Groq/Gemini/local servers.
 */

import { estimateTokens } from '../_http.js';
import type { ChatMessage, NativeToolDefinition, ProviderId } from './_types.js';

/** How this provider expects cacheable prefixes to be communicated. */
export type PromptCacheMode = 'cache_control' | 'system_instruction_prefix' | 'auto_prefix';

/** Anthropic-style cache breakpoint attached to an OpenAI-compatible content part. */
export interface CacheContentPart {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
}

/** Serialized form of one shaped message: plain string, or a marked content part. */
export type RenderedContent = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;

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
  /** Number of messages that carry an emitted marker (`cache_control` mode only). */
  markers: number;
  /** Raw characters inside the byte-stable prefix. */
  prefixChars: number;
  /** Estimated tokens inside the byte-stable prefix — what a hit stops re-billing. */
  prefixTokens: number;
  /** FNV-1a hex digest of the stable-prefix bytes; changes exactly when a hit becomes impossible. */
  prefixHash: string;
  /**
   * FNV-1a hex digest of the *leading stable block* (system/context only), which
   * survives the history growing. Used as the value of a provider cache-routing
   * field, where a per-turn-changing key would defeat the routing.
   */
  conversationHash: string;
  /** Characters of the separate top-level system instruction, when one is sent. */
  systemChars?: number;
  /** Serialized characters of the tool schemas, when they are sent. */
  toolSchemaChars?: number;
}

/**
 * The parts of the FINAL wire payload that live outside the message array.
 * Pass them so the plan's counts and digests describe what the provider actually
 * receives: the separate system instruction (Gemini `systemInstruction`, the
 * leading OpenAI-style system message) and the tool schemas. `emitMarkers`
 * overrides marker emission for a fallback that had to drop `cache_control`
 * parts — the plan then honestly reports the unmarked wire dialect.
 */
export interface StablePrefixExtras {
  systemInstruction?: string;
  toolDefinitions?: NativeToolDefinition[];
  emitMarkers?: boolean;
}

/** What the app needs to be told about one turn's cache posture. */
export interface PromptCacheReport {
  mode: PromptCacheMode;
  prefixTokens: number;
  prefixChars: number;
  breakpoints: number;
  markers: number;
  /** Share (0..1) of the shaped request the stable prefix accounts for. */
  prefixShare: number;
  /** Separate system-instruction characters included in the prefix, when sent. */
  systemChars?: number;
  /** Tool-schema characters included in the prefix, when sent. */
  toolSchemaChars?: number;
}

/**
 * Model ids that mean "an Anthropic-family model behind an OpenAI-compatible
 * gateway", i.e. the one pair where a `cache_control` content part is forwarded
 * rather than rejected. Matches both bare ids (`claude-sonnet-4-5`) and gateway
 * ids (`anthropic/claude-sonnet-4.5`).
 */
const ANTHROPIC_FAMILY = /claude|anthropic|bedrock.*claude|vertex.*claude/i;

/**
 * Which cache discipline the wire format supports.
 *
 * A custom endpoint that names a Claude model is marked explicitly (with the
 * unmarked resend ladder in `_compatible.ts` as the safety net). Gemini gets its
 * placement mode. Everything else relies on automatic longest-common-prefix
 * caching and stable ordering alone — Groq has no cache field to set, and a
 * `user`/`prompt_cache_key`-style routing field is only ever emitted where the
 * provider documents it.
 */
export function promptCacheMode(provider: ProviderId, model: string): PromptCacheMode {
  if (provider === 'gemini') return 'system_instruction_prefix';
  if (provider === 'custom' && ANTHROPIC_FAMILY.test(model || '')) return 'cache_control';
  return 'auto_prefix';
}

/** True when this provider/model pair gets an explicit `cache_control` marker. */
export function emitsCacheMarkers(provider: ProviderId, model: string): boolean {
  return promptCacheMode(provider, model) === 'cache_control';
}

/**
 * Orders the assembled message list stable-prefix-safe and, where the wire
 * format has one, stamps the cache markers:
 *
 * 1. every `system` message (rules + long-lived context) is hoisted to the front
 *    in original relative order — Gemini already flattens inline system turns
 *    into `systemInstruction`, and a mid-history system block is exactly the churn
 *    that breaks a cached prefix between turns;
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
  messages: ChatMessage[],
  extras?: StablePrefixExtras
): StablePrefixPlan {
  const wireMode = promptCacheMode(provider, model);
  const wantsMarkers = wireMode === 'cache_control' && (extras?.emitMarkers ?? true);
  // A fallback that dropped the markers sends the plain dialect: report what is
  // actually on the wire, not what was originally planned.
  const mode: PromptCacheMode = wireMode === 'cache_control' && !wantsMarkers ? 'auto_prefix' : wireMode;

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

  // Only the `cache_control` family gets the flag written into the message copy,
  // so an endpoint that does not speak Anthropic content parts sees the old
  // byte-identical body.
  const marked = wantsMarkers ? new Set(breakpoints) : new Set<number>();
  const shapedMessages = shaped.map((message, index) => ({
    ...message,
    ...(marked.has(index) ? { cacheEphemeral: true } : {})
  }));

  const prefix = prefixMessages({ messages: shapedMessages, cacheBreakpoints: breakpoints });
  const systemText = extras?.systemInstruction && extras.systemInstruction.trim() ? extras.systemInstruction : '';
  const toolBytes = extras?.toolDefinitions?.length ? JSON.stringify(extras.toolDefinitions) : '';
  const hasExtras = Boolean(systemText || toolBytes);
  const prefixChars =
    systemText.length + toolBytes.length +
    prefix.reduce((sum, message) => sum + message.content.length, 0);
  const prefixTokens =
    (systemText ? estimateTokens(systemText) : 0) +
    (toolBytes ? estimateTokens(toolBytes) : 0) +
    prefix.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const leading = systemOf(shapedMessages);
  const prefixBytes = stablePrefixBytesOf(prefix);
  const leadingBytes = stablePrefixBytesOf(leading);

  return {
    messages: shapedMessages,
    mode,
    cacheBreakpoints: breakpoints,
    markers: marked.size,
    prefixChars,
    prefixTokens,
    // With extras the digests cover the separate system instruction and tool
    // schemas too: a changed schema or instruction makes a hit impossible even
    // when the message bytes are identical.
    prefixHash: fnv1aHex(hasExtras ? JSON.stringify([systemText, toolBytes, prefixBytes]) : prefixBytes),
    conversationHash: fnv1aHex(hasExtras ? JSON.stringify([systemText, toolBytes, leadingBytes]) : leadingBytes),
    ...(hasExtras
      ? { systemChars: systemText.length, toolSchemaChars: toolBytes.length }
      : {})
  };
}

function systemOf(messages: readonly ChatMessage[]): ChatMessage[] {
  let end = -1;
  messages.forEach((message, index) => {
    if (message.role === 'system') end = index;
  });
  return end < 0 ? [] : messages.slice(0, end + 1);
}

/** The messages a provider can reuse: everything up to the last breakpoint. */
function prefixMessages(plan: Pick<StablePrefixPlan, 'messages' | 'cacheBreakpoints'>): ChatMessage[] {
  const last = plan.cacheBreakpoints[plan.cacheBreakpoints.length - 1];
  return last === undefined
    ? plan.messages.filter((message) => message.role === 'system')
    : plan.messages.slice(0, last + 1);
}

/**
 * OpenAI-compatible content for one shaped message. Flagged messages become a
 * text part carrying `cache_control: {type:'ephemeral'}` (the exact payload
 * aider's `add_cache_control` builds); everything else serializes as the plain
 * string it always was, so an unflagged request is byte-identical to the old
 * wire format.
 */
export function renderCacheableContent(message: ChatMessage): RenderedContent {
  if (!message.cacheEphemeral) return message.content;
  return markStableText(message.content);
}

/** A `cache_control` text part for a stable block that is not a shaped message — the system instruction. */
export function markStableText(text: string): CacheContentPart[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/**
 * Deterministic serialization of the cacheable prefix — the bytes a provider's
 * cache-key is computed from. Two turns share a cache hit exactly when this
 * string is identical across them.
 */
export function stablePrefixBytes(plan: StablePrefixPlan): string {
  return stablePrefixBytesOf(prefixMessages(plan));
}

function stablePrefixBytesOf(messages: readonly ChatMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    role: message.role,
    content: renderCacheableContent(message)
  })));
}

/**
 * Non-cryptographic, dependency-free, runtime-agnostic digest (FNV-1a, two
 * 32-bit lanes so the value is stable across platforms and long inputs). It is
 * only ever used to name a cache prefix, never as a security token.
 */
export function fnv1aHex(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ (code & 0xff), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ((code >>> 8) ^ code), 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Provider cache-routing field value: OpenAI's `prompt_cache_key` must be
 * ASCII `[A-Za-z0-9_-]`, up to 512 chars, and *stable across the turns of one
 * conversation* — hence the leading-block digest rather than the per-turn
 * prefix digest.
 */
export function promptCacheKeyValue(plan: StablePrefixPlan): string {
  return `shadrox_${plan.conversationHash}`;
}

/** True for the one host that documents `prompt_cache_key`. */
export function supportsPromptCacheKey(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/** What this turn asked the provider for, in the shape the SSE payload wants. */
export function promptCacheReport(plan: StablePrefixPlan): PromptCacheReport {
  const systemChars = plan.systemChars ?? 0;
  const toolSchemaChars = plan.toolSchemaChars ?? 0;
  const allChars =
    systemChars + toolSchemaChars +
    plan.messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    mode: plan.mode,
    prefixTokens: plan.prefixTokens,
    prefixChars: plan.prefixChars,
    breakpoints: plan.cacheBreakpoints.length,
    markers: plan.markers,
    prefixShare: allChars > 0 ? Number((plan.prefixChars / allChars).toFixed(4)) : 0,
    ...(systemChars > 0 ? { systemChars } : {}),
    ...(toolSchemaChars > 0 ? { toolSchemaChars } : {})
  };
}
