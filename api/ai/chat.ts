import {
  readJsonBody,
  sendError,
  sendSseHeaders,
  sseEnd,
  sseSend,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import { capSystemInstruction, trimMessagesToBudget } from '../../src/lib/contextBudget.js';
import { resolveContextWindow } from '../../src/lib/modelCapabilities.js';
import { ADAPTERS, isProviderId, resolveKeyAccess } from './access.js';
import type { ChatMessage, ChatRequestBody, ProviderId } from './types.js';

const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Google Gemini',
  groq: 'Groq'
};

export const config = { maxDuration: 60 };

function normalizedMessages(input: ChatRequestBody['messages']): ChatMessage[] {
  return (input || [])
    .filter((message): message is { role: ChatMessage['role']; content: string } =>
      Boolean(
        message &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
      )
    )
    .map((message) => ({ role: message.role, content: message.content }));
}

function errorMessage(error: unknown, provider: ProviderId): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Generation stopped.';
    if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
      return `Could not reach ${PROVIDER_LABEL[provider]}. Check your internet connection and try again.`;
    }
    return error.message;
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

  const body = await readJsonBody<ChatRequestBody>(req);
  let messages = normalizedMessages(body.messages);

  if (messages.length === 0) {
    sendError(res, 400, 'Kam se kam ek message chahiye.');
    return;
  }

  const provider: ProviderId = isProviderId(body.provider) ? body.provider : 'gemini';
  const adapter = ADAPTERS[provider];
  const model = (body.model || '').trim() || adapter.defaultModel;

  // Enforce the model's context budget on the message history. The client
  // trims too, but the server is the boundary that actually spends the key.
  const contextWindow = resolveContextWindow(provider, model);
  const trimmed = trimMessagesToBudget(messages, contextWindow);
  messages = trimmed.messages;
  if (trimmed.trimmed > 0) {
    console.warn(
      `[ai] trimmed ${trimmed.trimmed} message(s) for ${model} (${trimmed.trimmedChars} chars dropped)`
    );
  }

  const systemInstruction = body.systemInstruction
    ? capSystemInstruction(body.systemInstruction)
    : undefined;

  // Stream recovery: the client can resume an interrupted reply by echoing the
  // partial text it already received. We append it as a USER message because
  // Gemini rejects requests that end with a model turn.
  const resumePrefix = (body.resume?.prefix || '').slice(0, 60_000).trim();
  if (resumePrefix) {
    messages.push({
      role: 'user',
      content:
        'Continue your previous reply from where it stopped. Do not repeat the partial text below; ' +
        'start with the very next characters, completing the thought in the same style.\n\n' +
        `<partial-reply>\n${resumePrefix}\n</partial-reply>`
    });
  }

  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;
  const thinking = body.thinking === 'high' || body.thinking === 'low' ? body.thinking : undefined;

  const resolved = resolveKeyAccess(provider, model, body.apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }
  const { apiKey, byok } = resolved.access;

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  sendSseHeaders(res);

  const startedAt = performance.now();
  let firstTokenMs: number | null = null;

  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
  };

  try {
    const result = await adapter.stream(
      {
        provider,
        model,
        apiKey,
        messages,
        systemInstruction,
        temperature,
        thinking,
        signal: abort.signal
      },
      {
        delta(text) {
          if (abort.signal.aborted || res.writableEnded) return;
          markFirstToken();
          sseSend(res, { type: 'delta', text });
        },
        reasoning(text) {
          if (abort.signal.aborted || res.writableEnded) return;
          markFirstToken();
          sseSend(res, { type: 'reasoning', text });
        }
      }
    );

    if (abort.signal.aborted || res.writableEnded) {
      sseEnd(res);
      return;
    }

    sseSend(res, {
      type: 'done',
      tokens: result.tokens,
      provider,
      model,
      tier: byok ? 'byok' : 'shadrox',
      finishReason: result.finishReason,
      firstTokenMs,
      durationMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    if (abort.signal.aborted) {
      sseEnd(res);
      return;
    }
    sseSend(res, { type: 'error', message: errorMessage(error, provider) });
  }

  sseEnd(res);
}
