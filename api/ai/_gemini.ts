import { createSseDecoder } from '../../src/lib/sse.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { UpstreamError, mergeGeminiUsage, usageFields, type StreamRequest, type StreamResult, type StreamSink, type TokenUsage, type ToolCallEntry } from './_types.js';
import { rejectsNativeTools } from './_toolCalls.js';
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
  // The key travels in the documented `x-goog-api-key` header, never as a `?key=`
  // query parameter: query strings get written into proxy/CDN logs and can be
  // echoed back inside upstream error bodies.
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const contents = buildContents(request);
  const systemText = buildSystemInstruction(request);

  const send = (generationConfig: Record<string, unknown>, withTools: boolean) =>
    fetchUpstream(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents,
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          generationConfig,
          ...(withTools && request.toolDefinitions?.length
            ? {
                tools: [{
                  functionDeclarations: request.toolDefinitions.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                  }))
                }],
                toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
              }
            : {})
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

  let withTools = Boolean(request.toolDefinitions?.length);
  let response = await send(baseConfig, withTools);
  let payload = response.ok ? '' : await readErrorPayload(response);

  if (!response.ok && withTools && rejectsNativeTools(payload)) {
    withTools = false;
    response = await send(baseConfig, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok && thinking) {
    if (!/thinking|generation_config|Unknown name/i.test(payload)) {
      throw new UpstreamError(payload, response.status);
    }
    response = await send({ temperature }, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok) {
    throw new UpstreamError(payload, response.status);
  }

  let fullText = '';
  let usage: TokenUsage = {};
  let finishReason: string | null = null;
  const toolCalls: ToolCallEntry[] = [];

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
        const functionCall = part?.functionCall;
        if (typeof functionCall?.name === 'string' && functionCall.name) {
          const args = functionCall.args && typeof functionCall.args === 'object' && !Array.isArray(functionCall.args)
            ? JSON.stringify(functionCall.args)
            : '{}';
          toolCalls.push({
            id: `gemini_${toolCalls.length}`,
            name: functionCall.name,
            arguments: args
          });
        }
        if (typeof part?.text !== 'string' || !part.text) continue;
        if (part.thought === true) sink.reasoning(part.text);
        else {
          fullText += part.text;
          sink.delta(part.text);
        }
      }
    }

    if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
    usage = mergeGeminiUsage(usage, parsed?.usageMetadata);
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
    // Scrub again: transport-level failures can quote the request.
    throw new Error(sanitizeErrorMessage(error, 'Gemini stream failed.'));
  }

  if (toolCalls.length > 0) sink.toolCalls(toolCalls);

  if (!fullText.trim() && toolCalls.length === 0) {
    if (finishReason === 'SAFETY') throw new UpstreamError('Model ne response safety filter se block kar diya.', 400);
    throw new Error('Model returned an empty response.');
  }

  return { tokens: usage.total || estimateTokens(fullText), ...usageFields(usage), finishReason };
}
