import {
  readJsonBody,
  sanitizeErrorMessage,
  sendError,
  sendIfRejected,
  sendSseHeaders,
  sseEnd,
  sseSend,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import {
  BODY_LIMITS,
  FIELD_LIMITS,
  RequestRejectedError,
  chatMessages,
  clampedNumber,
  enumValue,
  nestedString,
  optionalKey,
  optionalString
} from '../_validate.js';
import { ADAPTERS, parseProviderId, resolveKeyAccess } from './_access.js';
import { budgetRequest } from './_budget.js';
import { promptCacheReport, shapeStablePrefix, type PromptCacheReport } from './_promptCache.js';
import { resolveCustomEndpoint, runsOnTheUsersMachine } from './_endpoint.js';
import {
  checkAdmission,
  checkSharedKeySpend,
  clientIp,
  fitChunk,
  outputCeiling,
  rateLimitedMessage
} from './_spendGuard.js';
import type { ChatMessage, ChatRequestBody, NativeToolDefinition, ProviderId } from './_types.js';
import type { MeteredStreamResult } from './_upstream.js';
import { nativeToolDefinitions as parseNativeToolDefinitions } from './_toolCalls.js';

const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Google Gemini',
  groq: 'Groq',
  custom: 'your custom endpoint'
};

// Serialized request overhead outside the message array: JSON keys, role
// wrappers and SSE framing, plus a per-message allowance. Conservative on
// purpose — the budget must fit the FINAL serialized request, not just history.
const REQUEST_FRAMING_CHARS = 2_048;
const PER_MESSAGE_FRAMING_CHARS = 64;

export const config = { maxDuration: 60 };

function errorMessage(error: unknown, provider: ProviderId): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Generation stopped.';
    if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
      return `Could not reach ${PROVIDER_LABEL[provider]}. Check your internet connection and try again.`;
    }
    // Never forward a raw provider/transport message verbatim: it can quote the
    // request URL and carry key-shaped tokens back into the renderer and logs.
    return sanitizeErrorMessage(error.message, 'AI generation failed.');
  }
  return 'AI generation failed.';
}

/**
 * POST /api/ai/chat
 * Body: { provider, model, apiKey?, messages[], systemInstruction?, temperature? }
 * Streams normalised SSE events: {type:'delta'|'reasoning'|'done'|'error'}.
 *
 * - apiKey present  -> BYOK passthrough, user pays, we never store the key.
 * - apiKey absent   -> falls back to the ShadRox shared key from the environment, which
 *                      is restricted to Pro-tier models.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let rawMessages: ChatMessage[];
  let systemText: string;
  let resumePrefix: string;
  let temperature: number;
  let thinking: ChatRequestBody['thinking'];
  let apiKey: string | undefined;
  let provider: ProviderId;
  let baseUrl: string | undefined;
  let model: string;
  let toolDefinitions: NativeToolDefinition[] | undefined;

  try {
    const raw = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.chat });
    provider = parseProviderId(raw);
    const adapter = ADAPTERS[provider];
    model = optionalString(raw, 'model', FIELD_LIMITS.modelChars).trim() || adapter.defaultModel;
    apiKey = optionalKey(raw);
    if (provider === 'custom') {
      baseUrl = resolveCustomEndpoint(raw.baseUrl);
      if (!model) {
        throw new RequestRejectedError(
          400,
          'Custom endpoint par model id chahiye. Settings → Models & Keys me endpoint verify karo ya “Model ids” me id daalo.'
        );
      }
    }

    // Length + per-element caps happen before anything can spend a key.
    rawMessages = chatMessages(raw).filter((message) => message.content.trim().length > 0);
    systemText = optionalString(raw, 'systemInstruction', FIELD_LIMITS.systemInstructionChars);
    resumePrefix = nestedString(raw, 'resume', 'prefix', FIELD_LIMITS.resumePrefixChars);
    temperature = clampedNumber(raw, 'temperature', FIELD_LIMITS.temperature);
    const level = enumValue(raw, 'thinking', ['high', 'low', 'none'] as const, 'none' as const);
    thinking = level === 'high' || level === 'low' ? level : undefined;
    try {
      toolDefinitions = parseNativeToolDefinitions(raw.toolDefinitions);
    } catch (error) {
      throw new RequestRejectedError(400, error instanceof Error ? error.message : 'Invalid tool definitions.');
    }
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  if (rawMessages.length === 0) {
    sendError(res, 400, 'Kam se kam ek message chahiye.');
    return;
  }

  // Stream recovery: the client can resume an interrupted reply by echoing the
  // partial text it already received. We append it as a USER message because
  // Gemini rejects requests that end with a model turn.
  const messages: ChatMessage[] = rawMessages.map((message) => ({ ...message }));
  const cleanResume = resumePrefix.trim();
  if (cleanResume) {
    messages.push({
      role: 'user',
      content:
        'Continue your previous reply from where it stopped. Do not repeat the partial text below; ' +
        'start with the very next characters, completing the thought in the same style.\n\n' +
        `<partial-reply>\n${cleanResume}\n</partial-reply>`
    });
  }

  const resolved = resolveKeyAccess(provider, model, apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }
  const { apiKey: spendKey, byok } = resolved.access;
  const adapter = ADAPTERS[provider];

  // Shared-key traffic only: a best-effort, in-process per-IP brake. BYOK calls
  // cost the operator nothing, so they never pass through this gate.
  const ip = clientIp(req);
  const decision = checkSharedKeySpend('chat', ip, byok);
  if ('retryAfterSeconds' in decision) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    sendError(res, 429, rateLimitedMessage(decision.retryAfterSeconds));
    return;
  }

  // S12 admission: hosted operator-key spend needs an authoritative entitlement
  // and fails closed until one is installed. The operator's own loopback backend
  // keeps the existing exemption (same policy as the Pro-tier gate in _access),
  // and BYOK never consults admission at all.
  if (!byok && !runsOnTheUsersMachine()) {
    const admission = await checkAdmission({ scope: 'chat', provider, model, ip, byok });
    if (!admission.admitted) {
      sendError(
        res,
        403,
        admission.message ||
          'ShadRox ki shared key ke liye admission abhi available nahi hai. Settings → BYOK me apni key add karo — BYOK requests hamesha chalti hain.'
      );
      return;
    }
  }

  // Enforce the model's context budget on the message history. The client
  // trims too, but the server is the boundary that actually spends the key.
  // The system instruction AND the serialized tool schemas/framing are billed
  // against the same window, so their tokens are subtracted before the history
  // is trimmed.
  const toolSchemaChars = toolDefinitions?.length ? JSON.stringify(toolDefinitions).length : 0;
  const framingChars = toolSchemaChars + REQUEST_FRAMING_CHARS + messages.length * PER_MESSAGE_FRAMING_CHARS;
  const budget = budgetRequest(provider, model, messages, systemText || undefined, framingChars);
  if (budget.trimmed > 0) {
    console.warn(
      `[ai] trimmed ${budget.trimmed} message(s) for ${model} (${budget.trimmedChars} chars dropped)`
    );
  }
  // Prompt caching: order the request so its leading block is byte-identical
  // across turns, and stamp the cache field where the provider family has one
  // (Anthropic content parts behind a custom OpenAI-compatible gateway). For
  // Gemini and Groq the plan emits no field and only guarantees placement,
  // because their wire formats cache the common prefix implicitly. The report
  // covers the final payload shape — separate system instruction and tool
  // schemas included — and the adapter replaces it with the post-fallback
  // report whenever a downgrade changed what actually shipped.
  const cachePlan = shapeStablePrefix(provider, model, budget.messages, {
    systemInstruction: budget.systemInstruction,
    toolDefinitions
  });
  const cacheReport: PromptCacheReport = promptCacheReport(cachePlan);
  const shapedMessages = cachePlan.messages;

  const abort = new AbortController();
  console.info(
    `[ai] prompt cache ${cacheReport.mode} for ${model} (${budget.capabilitySource} window): ` +
    `${cacheReport.prefixTokens} stable-prefix token(s), ${cacheReport.markers} marker(s), ` +
    `${Math.round(cacheReport.prefixShare * 100)}% of the prompt`
  );
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  sendSseHeaders(res);

  const startedAt = performance.now();
  let firstTokenMs: number | null = null;
  let sentChars = 0;
  let capped = false;
  // Hard output ceiling, shared-key requests only.
  const ceiling = outputCeiling('chat', byok);

  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
  };

  const emit = (event: Record<string, unknown>) => {
    if (abort.signal.aborted || res.writableEnded) return;
    sseSend(res, event);
  };

  const forward = (type: 'delta' | 'reasoning', text: string) => {
    if (capped || abort.signal.aborted || res.writableEnded) return;
    const { head, capped: hitCeiling } = fitChunk(sentChars, ceiling, text);
    if (head) {
      sentChars += head.length;
      markFirstToken();
      emit({ type, text: head });
    }
    if (hitCeiling) {
      capped = true;
      // Stop listening: the model would keep talking, we just stop paying.
      abort.abort();
    }
  };

  // Closing turn for a reply that hit the ceiling: a normal `done` event, marked
  // truncated. Written with `sseSend` directly because the abort flag is already
  // set by then and `emit()` would (correctly) refuse to write.
  const finishTruncated = () => {
    if (res.writableEnded) return;
    sseSend(res, {
      type: 'done',
      tokens: 0,
      provider,
      model,
      tier: 'shadrox',
      finishReason: 'length',
      truncated: true,
      // The stream was cut before any provider usage frame arrived: nothing
      // here is provider-measured, and no served model was confirmed.
      usageSource: 'estimated',
      promptCache: cacheReport,
      firstTokenMs,
      durationMs: Math.round(performance.now() - startedAt)
    });
  };

  try {
    const result = await adapter.stream(
      {
        provider,
        model,
        apiKey: spendKey,
        baseUrl,
        messages: shapedMessages,
        systemInstruction: budget.systemInstruction,
        temperature,
        thinking,
        toolDefinitions,
        signal: abort.signal
      },
      {
        delta(text) {
          forward('delta', text);
        },
        reasoning(text) {
          forward('reasoning', text);
        },
        toolCalls(calls) {
          if (capped || abort.signal.aborted || res.writableEnded || calls.length === 0) return;
          const serialized = JSON.stringify(calls);
          const { capped: hitCeiling } = fitChunk(sentChars, ceiling, serialized);
          if (hitCeiling) {
            capped = true;
            abort.abort();
            return;
          }
          // Tool calls ship whole or not at all, so the ceiling counts the full
          // serialized length — the same sentChars ledger as deltas/reasoning.
          sentChars += serialized.length;
          markFirstToken();
          emit({ type: 'tool_calls', calls });
        }
      }
    );

    if (abort.signal.aborted || res.writableEnded) {
      if (capped) finishTruncated();
      sseEnd(res);
      return;
    }

    const meta = result as MeteredStreamResult;
    sseSend(res, {
      type: 'done',
      tokens: result.tokens,
      // Unknown parts stay omitted so the client can tell "provider did not
      // report" apart from "the model emitted nothing".
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result.cachedInputTokens !== undefined ? { cachedInputTokens: result.cachedInputTokens } : {}),
      usageSource: meta.usageSource ?? 'estimated',
      // Only a model identity the provider itself reported — never the request
      // echo — so the UI can say "requested / not confirmed" when it is absent.
      ...(meta.servedModel ? { servedModel: meta.servedModel } : {}),
      ...(meta.attempts !== undefined ? { attempts: meta.attempts } : {}),
      ...(meta.droppedFeatures?.length ? { droppedFeatures: meta.droppedFeatures } : {}),
      // What this route asked the provider to cache, so the UI can tell a real
      // 0-token hit apart from "the provider never reported a hit". The
      // adapter's post-fallback report wins when the wire payload changed.
      promptCache: meta.promptCache ?? cacheReport,
      provider,
      model,
      tier: byok ? 'byok' : 'shadrox',
      finishReason: result.finishReason,
      firstTokenMs,
      durationMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    if (capped) {
      // Reaching the ceiling is expected, not a failure: close the turn cleanly.
      finishTruncated();
    } else if (abort.signal.aborted) {
      sseEnd(res);
      return;
    } else {
      sseSend(res, { type: 'error', message: errorMessage(error, provider) });
    }
  }

  sseEnd(res);
}
