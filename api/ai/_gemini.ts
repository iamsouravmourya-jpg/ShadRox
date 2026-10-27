import { createSseDecoder } from '../../src/lib/sse.js';
import { estimateTokens, readErrorPayload } from '../_http.js';
import { UpstreamError, type StreamRequest, type StreamResult, type StreamSink } from './_types.js';
import { fetchUpstream } from './_upstream.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function buildSystemInstruction(request: StreamRequest): string {
  const inline = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  return [request.systemInstruction, ...inline]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join('\n\n');
}

function buildContents(request: StreamRequest) {
  return request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
}

export async function streamGemini(request: StreamRequest, sink: StreamSink): Promise<StreamResult> {
  const { apiKey, model, temperature, thinking, signal } = request;
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const contents = buildContents(request);
  const systemText = buildSystemInstruction(request);

  const send = (generationConfig: Record<string, unknown>) =>
    fetchUpstream(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          generationConfig
        })
      },
      signal
    );

  const baseConfig: Record<string, unknown> = { temperature };
  if (thinking) {
    // Not every Gemini model exposes a thinking budget, so a rejection of this
    // field falls back to a plain request instead of failing the whole turn.
    baseConfig.thinkingConfig = { thinkingBudget: thinking === 'high' ? 8192 : 0 };
  }

  let response = await send(baseConfig);

  if (!response.ok && thinking) {
    const payload = await readErrorPayload(response);
    if (!/thinking|generation_config|Unknown name/i.test(payload)) {
      throw new UpstreamError(payload, response.status);
    }
    response = await send({ temperature });
  }

  if (!response.ok) {
    throw new UpstreamError(await readErrorPayload(response), response.status);
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

    const blockReason = parsed?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new UpstreamError(`Model ne request block kar di (${blockReason}).`, 400);
    }

    const candidate = parsed?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text !== 'string' || !part.text) continue;
        if (part.thought === true) sink.reasoning(part.text);
        else {
          fullText += part.text;
          sink.delta(part.text);
        }
      }
    }

    if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
    if (typeof parsed?.usageMetadata?.totalTokenCount === 'number') {
      totalTokens = parsed.usageMetadata.totalTokenCount;
    }
  });

  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Gemini returned an empty stream.');
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
    throw new Error(error instanceof Error ? error.message : 'Gemini stream failed.');
  }

  if (!fullText.trim()) {
    if (finishReason === 'SAFETY') throw new UpstreamError('Model ne response safety filter se block kar diya.', 400);
    throw new Error('Model returned an empty response.');
  }

  return { tokens: totalTokens || estimateTokens(fullText), finishReason };
}
