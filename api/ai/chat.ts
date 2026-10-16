import {
  estimateTokens,
  readErrorPayload,
  readJsonBody,
  sendError,
  sendSseHeaders,
  sseEnd,
  sseSend,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';

type ProviderId = 'gemini' | 'groq';

interface ChatMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatRequestBody {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  messages?: ChatMessageInput[];
  systemInstruction?: string;
  temperature?: number;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

export const config = { maxDuration: 60 };

async function* iterSseData(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
      newlineIndex = buffer.indexOf('\n');
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

async function streamGemini(options: {
  apiKey: string;
  model: string;
  messages: ChatMessageInput[];
  systemInstruction?: string;
  temperature: number;
  res: ApiResponse;
  signal: AbortSignal;
}): Promise<number> {
  const { apiKey, model, messages, systemInstruction, temperature, res, signal } = options;

  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));

  const systemText =
    systemInstruction ||
    messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      generationConfig: { temperature }
    })
  });

  if (!response.ok) {
    throw new Error(await readErrorPayload(response));
  }

  let fullText = '';
  let totalTokens = 0;

  for await (const data of iterSseData(response)) {
    if (!data || data === '[DONE]') continue;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const blockReason = parsed?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Model ne request block kar di (${blockReason}).`);
    }

    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === 'string' && part.text) {
          fullText += part.text;
          sseSend(res, { type: 'delta', text: part.text });
        }
      }
    }

    if (typeof parsed?.usageMetadata?.totalTokenCount === 'number') {
      totalTokens = parsed.usageMetadata.totalTokenCount;
    }
  }

  return totalTokens || estimateTokens(fullText);
}

async function streamGroq(options: {
  apiKey: string;
  model: string;
  messages: ChatMessageInput[];
  systemInstruction?: string;
  temperature: number;
  res: ApiResponse;
  signal: AbortSignal;
}): Promise<number> {
  const { apiKey, model, messages, systemInstruction, temperature, res, signal } = options;

  const payloadMessages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) payloadMessages.push({ role: 'system', content: systemInstruction });
  messages.forEach((message) => payloadMessages.push({ role: message.role, content: message.content }));

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    signal,
    body: JSON.stringify({
      model,
      messages: payloadMessages,
      temperature,
      stream: true
    })
  });

  if (!response.ok) {
    throw new Error(await readErrorPayload(response));
  }

  let fullText = '';
  let totalTokens = 0;

  for await (const data of iterSseData(response)) {
    if (!data || data === '[DONE]') continue;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    if (parsed?.error?.message) {
      throw new Error(parsed.error.message);
    }

    const delta = parsed?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      fullText += delta;
      sseSend(res, { type: 'delta', text: delta });
    }

    if (typeof parsed?.usage?.total_tokens === 'number') {
      totalTokens = parsed.usage.total_tokens;
    }
  }

  return totalTokens || estimateTokens(fullText);
}

/**
 * POST /api/ai/chat
 * Body: { provider, model, apiKey?, messages[], systemInstruction?, temperature? }
 * Streams normalised SSE events: {type:'delta'|'done'|'error'}.
 *
 * - apiKey present  -> BYOK passthrough, user pays, we never store the key.
 * - apiKey absent   -> falls back to the Devora key from the environment.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const body = await readJsonBody<ChatRequestBody>(req);
  const messages = (body.messages || []).filter(
    (message) => message && typeof message.content === 'string' && message.content.trim().length > 0
  );

  if (messages.length === 0) {
    sendError(res, 400, 'Kam se kam ek message chahiye.');
    return;
  }

  const byokKey = (body.apiKey || '').trim();
  const provider: ProviderId = byokKey ? (body.provider === 'groq' ? 'groq' : 'gemini') : 'gemini';
  const devoraKey = (process.env.DEVORA_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  const apiKey = byokKey || devoraKey;

  if (!apiKey) {
    sendError(res, 400, 'Koi API key nahi mili. Settings → BYOK me apni key add karo.');
    return;
  }

  if (!byokKey) {
    // TODO(phase-3): verify Supabase session + apply per-user rate limit before
    // spending the shared Devora key. See docs in README.
  }

  const fallbackModel = provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_GROQ_MODEL;
  const model = (body.model || '').trim() || fallbackModel;
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  sendSseHeaders(res);

  try {
    const tokens =
      provider === 'gemini'
        ? await streamGemini({
            apiKey,
            model,
            messages,
            systemInstruction: body.systemInstruction,
            temperature,
            res,
            signal: abort.signal
          })
        : await streamGroq({
            apiKey,
            model,
            messages,
            systemInstruction: body.systemInstruction,
            temperature,
            res,
            signal: abort.signal
          });

    sseSend(res, { type: 'done', tokens, provider, model, tier: byokKey ? 'byok' : 'devora' });
  } catch (error) {
    if (abort.signal.aborted) {
      sseEnd(res);
      return;
    }
    const message = error instanceof Error ? error.message : 'AI generation failed.';
    sseSend(res, { type: 'error', message });
  }

  sseEnd(res);
}
