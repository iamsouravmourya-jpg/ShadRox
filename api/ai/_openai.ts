import { createSseDecoder } from '../../src/lib/sse.js';
import { DEFAULT_MAX_OUTPUT, resolveBudgetCapabilities } from '../../src/lib/modelCapabilities.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { promptCacheReport, shapeStablePrefix } from './_promptCache.js';
import { UpstreamError, mergeOpenAiUsage, usageFields, type StreamRequest, type StreamResult, type StreamSink, type ThinkingLevel, type TokenUsage } from './_types.js';
import { OpenAiToolCallCollector, rejectsNativeTools, rejectsToolCall } from './_toolCalls.js';
import { AttemptCounter, fetchUpstream, type MeteredStreamResult } from './_upstream.js';
import { parseRetryAfterSeconds } from '../../src/lib/ai/retryPolicy.js';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

/**
 * Groq rejects a request whose *declared* output ceiling is larger than the
 * key's output-tokens-per-minute limit, so a free key can fail before a single
 * token is generated: "OTPM: Limit 1000, Requested 2048" (2048 being that
 * model's default `max_completion_tokens`). The same shape of error comes from
 * the input side ("TPM: Limit 2000, Requested 6837").
 */
interface GroqLimits {
  /** Tokens the key allows per minute, counting prompt + completion. */
  tokensPerMinute: number | null;
  /** Output-only limit (OTPM). */
  outputTokensPerMinute: number | null;
}

function groqLimits(payload: string): GroqLimits {
  const pick = (key: string) => {
    const match = new RegExp(`${key}:\\s*Limit\\s*(\\d+)`).exec(payload);
    return match ? Number(match[1]) : null;
  };
  return { tokensPerMinute: pick('TPM'), outputTokensPerMinute: pick('OTPM') };
}

function isRequestTooLarge(payload: string): boolean {
  return /request too large|rate limit|tokens per minute/i.test(payload);
}

function limitHint(model: string, limits: GroqLimits): string {
  const parts: string[] = [];
  if (limits.tokensPerMinute) parts.push(`${limits.tokensPerMinute} prompt tokens/min (TPM)`);
  if (limits.outputTokensPerMinute) parts.push(`${limits.outputTokensPerMinute} output tokens/min (OTPM)`);
  return parts.length
    ? `Groq model \`${model}\` only allows ${parts.join(' and ')} on your key, which is too small for this request — even after shrinking it. Pick a different model with a higher limit from the list (availability and limits are per key), or start a new chat so the history stops growing.`
    : `Groq rejected the request for \`${model}\` — its rate limit on your key is too small for this prompt. Try a model with a higher limit, or start a new chat.`;
}

/**
 * A per-minute quota that waiting (not shrinking) fixes. Groq resets every
 * minute and limits are per model, so switching models usually works at once —
 * the message says exactly that instead of a bare "giving up".
 */
function rateLimitHint(model: string, response: Response): string {
  const wait =
    parseRetryAfterSeconds(response.headers.get('retry-after')) ??
    parseRetryAfterSeconds(response.headers.get('x-ratelimit-reset-requests')) ??
    parseRetryAfterSeconds(response.headers.get('x-ratelimit-reset-tokens'));
  const waitText = wait != null && wait > 0 ? ` The provider asked to wait ~${Math.ceil(wait)}s.` : '';
  return `Groq's per-minute rate limit for \`${model}\` is used up.${waitText} Limits are per model, so switching to a different model in Settings → Models & Keys usually continues immediately — or retry in about a minute. On a free key, a shorter chat history also spends less of the quota.`;
}

/**
 * Groq has no cache field in its chat-completions body: it caches the longest
 * common prompt prefix implicitly and bills the hit through
 * `usage.prompt_tokens_details.cached_tokens`, which `mergeOpenAiUsage` already
 * reads. What this route can control is the prefix, so the stable blocks are
 * hoisted and the volatile turn goes last (`auto_prefix` mode of
 * `./_promptCache.ts`) — no marker field, no unknown key in the body.
 */
type OpenAiMessage = {
  role: string;
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
};

function buildMessages(request: StreamRequest): OpenAiMessage[] {
  const shaped = shapeStablePrefix(request.provider, request.model, request.messages).messages;
  const messages: OpenAiMessage[] = [];
  if (request.systemInstruction) messages.push({ role: 'system', content: request.systemInstruction });
  shaped.forEach((message) => messages.push({
    role: message.role,
    content: message.imageData
      ? [
          { type: 'text', text: message.content },
          { type: 'image_url', image_url: { url: message.imageData } }
        ]
      : message.content
  }));
  return messages;
}

function reasoningText(delta: Record<string, unknown>): string {
  for (const field of ['reasoning_content', 'reasoning']) {
    const value = delta[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export interface ClampMessagesResult<T> {
  messages: T[];
  systemTruncated: boolean;
}

const PINNED_SECTION_MARKER_RE = /^(?:\[WORKING MEMORY[^\]]*\]|REQUIREMENT CHECKLIST\b|===\s*REQUIREMENTS\s*===)/m;

function sliceSystemPreservingAnchors(content: string, limit: number): string {
  if (content.length <= limit) return content;
  if (limit <= 0) return '';

  const markerMatch = PINNED_SECTION_MARKER_RE.exec(content);
  if (!markerMatch || markerMatch.index < limit - 64) {
    return content.slice(0, limit);
  }

  const tailSlice = content.slice(markerMatch.index);
  const maxAnchorShare = Math.floor(limit * 0.45);
  const anchorText = tailSlice.length <= maxAnchorShare ? tailSlice : tailSlice.slice(0, maxAnchorShare);
  const divider = '\n...\n';
  const headRoom = limit - anchorText.length - divider.length;
  if (headRoom <= 32) {
    return content.slice(0, limit);
  }
  return `${content.slice(0, headRoom)}${divider}${anchorText}`;
}

/**
 * Keeps the newest turns under a character budget, because Groq's smaller free
 * models cap prompt + completion per minute far below a full chat history. The
 * system prompt survives in its RESERVED share (a quarter of the budget, never
 * more than its own length) while preserving any pinned working-memory or
 * requirement-checklist anchors when the system prompt must be clipped.
 */
export function clampMessagesDetailed<T extends { role: string; content: unknown }>(
  messages: T[],
  charBudget: number
): ClampMessagesResult<T> {
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const systemLength = system && typeof system.content === 'string' ? system.content.length : 0;
  const reserved = system
    ? Math.min(systemLength, Math.floor(charBudget * 0.25))
    : 0;
  const systemTruncated = Boolean(system && typeof system.content === 'string' && system.content.length > reserved);
  const body: T[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= (system ? 1 : 0); index -= 1) {
    const message = messages[index];
    const room = charBudget - reserved - used;
    if (room <= 0) break;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (text.length <= room) {
      body.unshift(message);
      used += text.length;
    } else {
      // Keep the tail of the message: the actual question is at the end.
      body.unshift(typeof message.content === 'string'
        ? { ...message, content: message.content.slice(message.content.length - room) }
        : message);
      used = charBudget - reserved;
      break;
    }
  }

  const clampedMessages = system
    ? [{
        ...system,
        content: typeof system.content === 'string'
          ? sliceSystemPreservingAnchors(system.content, reserved)
          : system.content
      }, ...body]
    : body;

  return { messages: clampedMessages, systemTruncated };
}

export function clampMessages<T extends { role: string; content: unknown }>(
  messages: T[],
  charBudget: number
): T[] {
  return clampMessagesDetailed(messages, charBudget).messages;
}

export async function streamGroq(request: StreamRequest, sink: StreamSink): Promise<StreamResult> {
  const { apiKey, model, temperature, thinking, signal } = request;
  const payloadMessages = buildMessages(request);
  const attempts = new AttemptCounter();
  const droppedFeatures: string[] = [];
  const resolvedMaxOutput = resolveBudgetCapabilities(request.provider, model).maxOutput ?? DEFAULT_MAX_OUTPUT;
  let servedModel: string | undefined;

  const send = (
    messages: OpenAiMessage[],
    reasoningEffort?: ThinkingLevel,
    maxOutputTokens?: number,
    fetchAttempts = 1,
    withTools = true
  ) =>
    fetchUpstream(
      `${GROQ_API_BASE}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
          ...(withTools && request.toolDefinitions?.length
            ? {
                tools: request.toolDefinitions.map((tool) => ({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
                })),
                tool_choice: 'auto'
              }
            : {})
        })
      },
      signal,
      fetchAttempts,
      attempts
    );

  let messages = payloadMessages;
  let effort = thinking;
  let maxOutputTokens: number | undefined = resolvedMaxOutput;
  let withTools = Boolean(request.toolDefinitions?.length);

  // One attempt on the limit-aware calls: repeating an oversized request can
  // only burn the same quota, so the retry below changes the request instead.
  let response = await send(messages, effort, maxOutputTokens, 1, withTools);
  let payload = response.ok ? '' : await readErrorPayload(response);

  // The feature-drop ladder is a LOOP, not a one-pass chain: the provider names
  // one unsupported field per rejection, and fixing the earlier one merely
  // reveals the next (Groq reports `reasoning_effort` before `tool calling`).
  // Each rejection must therefore re-check every rung against the new payload;
  // as a straight chain the tools rung was already behind the cursor and the
  // resend kept shipping all 35 tools until the turn died.
  for (let round = 0; round < 3 && !response.ok; round += 1) {
    if (withTools && (rejectsNativeTools(payload) || rejectsToolCall(payload))) {
      // Either the server does not speak native tools, or the model hallucinated
      // a tool name and Groq 400'd the generation ("Tool call validation failed").
      // Both recover the same way: resend without native tools and let the text
      // protocol's unknown-tool repair teach the model the real names.
      withTools = false;
      droppedFeatures.push('tools');
    } else if (effort && /reasoning/i.test(payload)) {
      // Only some Groq models accept `reasoning_effort`; retry plainly otherwise.
      effort = undefined;
      droppedFeatures.push('reasoning_effort');
    } else {
      break;
    }
    response = await send(messages, effort, maxOutputTokens, 1, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok && isRequestTooLarge(payload)) {
    // Free-tier Groq keys carry per-minute limits far below what a normal chat
    // request needs, and Groq bills the *declared* output ceiling against the
    // limit up front. When the error names a token budget, shrink both sides of
    // the request and try once. A pure requests-per-minute limit has nothing to
    // shrink — the only fix is waiting out the window, so the resend carries a
    // real retry budget and fetchUpstream honours the provider's wait request.
    const limits = groqLimits(payload);
    if (limits.outputTokensPerMinute || limits.tokensPerMinute) {
      if (limits.outputTokensPerMinute) {
        const clamped = Math.min(resolvedMaxOutput, Math.max(256, limits.outputTokensPerMinute - 64));
        if (clamped < resolvedMaxOutput) droppedFeatures.push('output_cap_clamped');
        maxOutputTokens = clamped;
      }
      if (limits.tokensPerMinute) {
        const output = maxOutputTokens ?? Math.min(1024, Math.floor(limits.tokensPerMinute / 2));
        const roomTokens = Math.max(512, limits.tokensPerMinute - output);
        const clamped = clampMessagesDetailed(messages, roomTokens * 4);
        messages = clamped.messages;
        droppedFeatures.push('history_clamp');
        if (clamped.systemTruncated) droppedFeatures.push('system_context_truncated');
      }
      response = await send(messages, effort, maxOutputTokens, 1, withTools);
    } else {
      response = await send(messages, effort, maxOutputTokens, 3, withTools);
    }
    payload = response.ok ? '' : await readErrorPayload(response);
  } else if (!response.ok) {
    // Ordinary transient failure: `fetchUpstream` owns the backoff for these.
    response = await send(messages, effort, maxOutputTokens, 2, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok) {
    const message = response.status === 429
      ? rateLimitHint(model, response)
      : isRequestTooLarge(payload)
        ? limitHint(model, groqLimits(payload))
        : sanitizeErrorMessage(payload, 'Groq request failed.');
    throw new UpstreamError(message, response.status);
  }

  let fullText = '';
  let usage: TokenUsage = {};
  let finishReason: string | null = null;
  let toolCalls = new OpenAiToolCallCollector();
  // Set as soon as anything reaches the caller. Past that point a resend would
  // duplicate output, so the tools-off recovery below must not fire.
  let emitted = false;

  const makeDecoder = () =>
    createSseDecoder(({ data }) => {
      if (!data || data === '[DONE]') return;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (parsed?.error?.message) {
        throw new UpstreamError(sanitizeErrorMessage(parsed.error.message, 'Groq stream error.'), 502);
      }

      const choice = parsed?.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content) {
          fullText += delta.content;
          emitted = true;
          sink.delta(delta.content);
        }
        const reasoning = reasoningText(delta);
        if (reasoning) {
          emitted = true;
          sink.reasoning(reasoning);
        }
        toolCalls.add(delta.tool_calls);
      }
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      if (typeof parsed?.model === 'string' && parsed.model.trim()) {
        servedModel = parsed.model.trim();
      }
      usage = mergeOpenAiUsage(usage, parsed?.usage);
    });

  const consume = async (stream: Response): Promise<void> => {
    const decoder = makeDecoder();
    try {
      const reader = stream.body?.getReader();
      if (!reader) throw new Error('Groq returned an empty stream.');
      const textDecoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decoder.push(textDecoder.decode(value, { stream: true }));
      }
      decoder.flush();
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof UpstreamError) throw error;
      // Scrub again: transport-level failures can quote the request.
      throw new Error(sanitizeErrorMessage(error, 'Groq stream failed.'));
    }
  };

  try {
    await consume(response);
  } catch (error) {
    // Groq validates tool support when generation starts, not when the request
    // is parsed: the rejection arrives as an in-stream `error` event on an
    // already-200 response, so the pre-flight ladder above never saw it. The
    // recovery is the same tools-off resend, but only while no token escaped —
    // after that a resend would repeat text the user already received.
    const toolsRejected = error instanceof UpstreamError &&
      (rejectsNativeTools(error.message) || rejectsToolCall(error.message));
    if (signal.aborted || !withTools || emitted || !toolsRejected) throw error;

    withTools = false;
    droppedFeatures.push('tools');
    response = await send(messages, effort, maxOutputTokens, 1, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
    if (!response.ok) {
      const message = response.status === 429
        ? rateLimitHint(model, response)
        : isRequestTooLarge(payload)
          ? limitHint(model, groqLimits(payload))
          : sanitizeErrorMessage(payload, 'Groq request failed.');
      throw new UpstreamError(message, response.status);
    }
    fullText = '';
    usage = {};
    finishReason = null;
    toolCalls = new OpenAiToolCallCollector();
    await consume(response);
  }

  const calls = toolCalls.values();
  if (calls.length > 0) sink.toolCalls(calls);

  if (!fullText.trim() && calls.length === 0) {
    throw new Error(
      finishReason === 'length'
        ? 'Model hit its output limit before writing an answer. Try a higher limit or a shorter prompt.'
        : 'Model returned an empty response.'
    );
  }

  const toolText = calls.map((call) => `${call.name}${call.arguments}`).join('');
  const result: MeteredStreamResult = {
    tokens: usage.total || estimateTokens(fullText + toolText),
    ...usageFields(usage),
    finishReason,
    usageSource: usage.total ? 'provider' : 'estimated',
    attempts: attempts.count,
    promptCache: promptCacheReport(shapeStablePrefix(request.provider, model, request.messages, {
      systemInstruction: request.systemInstruction,
      toolDefinitions: withTools ? request.toolDefinitions : undefined
    })),
    ...(servedModel ? { servedModel } : {}),
    ...(droppedFeatures.length > 0 ? { droppedFeatures: [...droppedFeatures] } : {})
  };
  return result;
}
