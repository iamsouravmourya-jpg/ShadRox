import { createSseDecoder } from '../../src/lib/sse.js';
import { DEFAULT_MAX_OUTPUT, resolveBudgetCapabilities } from '../../src/lib/modelCapabilities.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { promptCacheReport, shapeStablePrefix } from './_promptCache.js';
import { UpstreamError, mergeGeminiUsage, usageFields, type ChatMessage, type StreamRequest, type StreamResult, type StreamSink, type TokenUsage, type ToolCallEntry } from './_types.js';
import { rejectsNativeTools } from './_toolCalls.js';
import { AttemptCounter, fetchUpstream, type MeteredStreamResult } from './_upstream.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Gemini's cache placement, the `system_instruction_prefix` mode of
 * `./_promptCache.ts`: the REST format has no per-message cache field and no
 * `cachedContent` marker is created here (see that file's header for why), but
 * `systemInstruction` is the one block the API keeps outside the turn list, and
 * implicit context caching bills the reused leading prefix back as
 * `usageMetadata.cachedContentTokenCount`. So the marker this family gets is:
 * every stable block — the caller's instruction and any inline system turn —
 * hoisted into `systemInstruction` in a fixed order, `contents` append-only,
 * volatile turn last.
 *
 * `shapeStablePrefix` is idempotent, so routes that already shaped their
 * messages (`chat.ts`) are unaffected and routes that did not get the same
 * guarantee.
 */
function cacheShaped(request: StreamRequest): ChatMessage[] {
  return shapeStablePrefix(request.provider, request.model, request.messages).messages;
}

function buildSystemInstruction(request: StreamRequest, shaped: readonly ChatMessage[]): string {
  const inline = shaped
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  return [request.systemInstruction, ...inline]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join('\n\n');
}

function buildContents(request: StreamRequest, shaped: readonly ChatMessage[]) {
  return shaped
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [
        { text: message.content },
        ...(message.imageData ? [{
          inlineData: {
            mimeType: message.imageData.slice(5, message.imageData.indexOf(';')),
            data: message.imageData.slice(message.imageData.indexOf(',') + 1)
          }
        }] : [])
      ]
    }));
}

export async function streamGemini(request: StreamRequest, sink: StreamSink): Promise<StreamResult> {
  const { apiKey, model, temperature, thinking, signal } = request;
  // The key travels in the documented `x-goog-api-key` header, never as a `?key=`
  // query parameter: query strings get written into proxy/CDN logs and can be
  // echoed back inside upstream error bodies.
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const shaped = cacheShaped(request);
  const contents = buildContents(request, shaped);
  const systemText = buildSystemInstruction(request, shaped);
  const attempts = new AttemptCounter();
  const droppedFeatures: string[] = [];
  const maxOutputTokens = resolveBudgetCapabilities(request.provider, model).maxOutput ?? DEFAULT_MAX_OUTPUT;
  let servedModel: string | undefined;

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
      signal,
      2,
      attempts
    );

  const baseConfig: Record<string, unknown> = { temperature, maxOutputTokens };
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
    droppedFeatures.push('tools');
    response = await send(baseConfig, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok && thinking) {
    if (!/thinking|generation_config|Unknown name/i.test(payload)) {
      throw new UpstreamError(payload, response.status);
    }
    droppedFeatures.push('thinking');
    response = await send({ temperature, maxOutputTokens }, withTools);
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
    if (typeof parsed?.modelVersion === 'string' && parsed.modelVersion.trim()) {
      servedModel = parsed.modelVersion.trim();
    }
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

  // Tool-call output is generated output too: the text-estimate fallback must
  // count it exactly like the visible prose, or a tool-only turn bills as zero.
  const toolText = toolCalls.map((call) => `${call.name}${call.arguments}`).join('');
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
