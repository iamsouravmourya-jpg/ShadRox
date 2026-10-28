import { createSseDecoder } from '../../src/lib/sse.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { UpstreamError, type StreamRequest, type StreamResult, type StreamSink, type ThinkingLevel } from './_types.js';
import { fetchUpstream } from './_upstream.js';

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
    ? `Groq model \`${model}\` only allows ${parts.join(' and ')} on your key, which is too small for this request — even after shrinking it. Pick a model with a higher limit (for example \`llama-3.3-70b-versatile\` or \`gpt-oss-120b\`), or start a new chat so the history stops growing.`
    : `Groq rejected the request for \`${model}\` — its rate limit on your key is too small for this prompt. Try a model with a higher limit, or start a new chat.`;
}

function buildMessages(request: StreamRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.systemInstruction) messages.push({ role: 'system', content: request.systemInstruction });
  request.messages.forEach((message) => messages.push({ role: message.role, content: message.content }));
  return messages;
}

function reasoningText(delta: Record<string, unknown>): string {
  for (const field of ['reasoning_content', 'reasoning']) {
    const value = delta[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * Keeps the newest turns under a character budget, because Groq's smaller free
 * models cap prompt + completion per minute far below a full chat history. The
 * system prompt survives (capped) so instructions are not silently dropped.
 */
function clampMessages<T extends { role: string; content: string }>(
  messages: T[],
  charBudget: number
): T[] {
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const body: T[] = [];
  let used = system ? Math.min(system.content.length, Math.floor(charBudget * 0.25)) : 0;

  for (let index = messages.length - 1; index >= (system ? 1 : 0); index -= 1) {
    const message = messages[index];
    const room = charBudget - used;
    if (room <= 0) break;
    if (message.content.length <= room) {
      body.unshift(message);
      used += message.content.length;
    } else {
      // Keep the tail of the message: the actual question is at the end.
      body.unshift({ ...message, content: message.content.slice(message.content.length - room) });
      used = charBudget;
      break;
    }
  }

  return system ? [{ ...system, content: system.content.slice(0, used) }, ...body] : body;
}

export async function streamGroq(request: StreamRequest, sink: StreamSink): Promise<StreamResult> {
  const { apiKey, model, temperature, thinking, signal } = request;
  const payloadMessages = buildMessages(request);

  const send = (
    messages: Array<{ role: string; content: string }>,
    reasoningEffort?: ThinkingLevel,
    maxOutputTokens?: number,
    attempts = 1
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
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {})
        })
      },
      signal,
      attempts
    );

  let messages = payloadMessages;
  let effort = thinking;
  let maxOutputTokens: number | undefined;

  // One attempt on the limit-aware calls: repeating an oversized request can
  // only burn the same quota, so the retry below changes the request instead.
  let response = await send(messages, effort, maxOutputTokens);
  let payload = response.ok ? '' : await readErrorPayload(response);

  if (!response.ok && effort && /reasoning/i.test(payload)) {
    // Only some Groq models accept `reasoning_effort`; retry plainly otherwise.
    effort = undefined;
    response = await send(messages, effort, maxOutputTokens);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok && isRequestTooLarge(payload)) {
    // Free-tier Groq keys carry per-minute limits far below what a normal chat
    // request needs, and Groq bills the *declared* output ceiling against the
    // limit up front. Shrink both sides of the request, then try once.
    const limits = groqLimits(payload);
    maxOutputTokens = limits.outputTokensPerMinute
      ? Math.max(256, limits.outputTokensPerMinute - 64)
      : undefined;
    if (limits.tokensPerMinute) {
      const output = maxOutputTokens ?? Math.min(1024, Math.floor(limits.tokensPerMinute / 2));
      const roomTokens = Math.max(512, limits.tokensPerMinute - output);
      messages = clampMessages(messages, roomTokens * 4);
    }
    response = await send(messages, effort, maxOutputTokens);
    payload = response.ok ? '' : await readErrorPayload(response);
  } else if (!response.ok) {
    // Ordinary transient failure: `fetchUpstream` owns the backoff for these.
    response = await send(messages, effort, maxOutputTokens, 2);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok) {
    throw new UpstreamError(
      isRequestTooLarge(payload) ? limitHint(model, groqLimits(payload)) : sanitizeErrorMessage(payload, 'Groq request failed.'),
      response.status
    );
  }

  let fullText = '';
  let totalTokens = 0;
  let finishReason: string | null = null;

  const decoder = createSseDecoder(({ data }) => {
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
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) {
        fullText += delta.content;
        sink.delta(delta.content);
      }
      const reasoning = reasoningText(delta);
      if (reasoning) sink.reasoning(reasoning);
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (typeof parsed?.usage?.total_tokens === 'number') totalTokens = parsed.usage.total_tokens;
  });

  try {
    const reader = response.body?.getReader();
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

  if (!fullText.trim()) {
    throw new Error(
      finishReason === 'length'
        ? 'Model hit its output limit before writing an answer. Try a higher limit or a shorter prompt.'
        : 'Model returned an empty response.'
    );
  }

  return { tokens: totalTokens || estimateTokens(fullText), finishReason };
}
