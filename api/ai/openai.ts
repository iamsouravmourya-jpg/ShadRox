import { createSseDecoder } from '../../src/lib/sse.js';
import { estimateTokens, readErrorPayload } from '../_http.js';
import { UpstreamError, type StreamRequest, type StreamResult, type StreamSink, type ThinkingLevel } from './types.js';
import { fetchUpstream } from './upstream.js';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

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

export async function streamGroq(request: StreamRequest, sink: StreamSink): Promise<StreamResult> {
  const { apiKey, model, temperature, thinking, signal } = request;
  const payloadMessages = buildMessages(request);

  const send = (reasoningEffort?: ThinkingLevel) =>
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
          messages: payloadMessages,
          temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
        })
      },
      signal
    );

  let response = await send(thinking);

  if (!response.ok && thinking) {
    // Only some Groq models accept `reasoning_effort`; retry plainly otherwise.
    const payload = await readErrorPayload(response);
    if (!/reasoning/i.test(payload)) throw new UpstreamError(payload, response.status);
    response = await send(undefined);
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

    if (parsed?.error?.message) throw new UpstreamError(String(parsed.error.message), 502);

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
    throw new Error(error instanceof Error ? error.message : 'Groq stream failed.');
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
