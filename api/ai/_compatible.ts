import { createSseDecoder } from '../../src/lib/sse.js';
import { DEFAULT_MAX_OUTPUT, resolveBudgetCapabilities } from '../../src/lib/modelCapabilities.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { resolveCustomEndpoint } from './_endpoint.js';
import {
  markStableText,
  promptCacheKeyValue,
  promptCacheMode,
  promptCacheReport,
  renderCacheableContent,
  shapeStablePrefix,
  supportsPromptCacheKey,
  type RenderedContent
} from './_promptCache.js';
import { UpstreamError, mergeOpenAiUsage, usageFields, type StreamRequest, type StreamResult, type StreamSink, type TokenUsage } from './_types.js';
import { OpenAiToolCallCollector, rejectsNativeTools } from './_toolCalls.js';
import { AttemptCounter, fetchUpstream, type MeteredStreamResult } from './_upstream.js';

/**
 * OpenAI-compatible chat completions for the BYOK custom endpoint.
 *
 * This is the "one option that covers everyone" path: any server that answers
 * `POST {base}/chat/completions` with an SSE stream of
 * `choices[0].delta.content` works — OpenRouter, DeepSeek, xAI, Together,
 * Fireworks, Mistral, Cerebras, SiliconFlow, GitHub Models, credit-reselling
 * gateways, and local runners like Ollama or LM Studio.
 *
 * Deliberately leaner than the Groq adapter: no per-key token-per-minute
 * shrinking (that error format is Groq's own), no reasoning-effort retry
 * (unsupported servers reject it and the request is not worth replaying).
 * Whatever the endpoint returns is what the user's key is charged for.
 */

/**
 * The wire `messages` array. `withMarkers` is what turns the aider-style
 * breakpoints computed by `shapeStablePrefix` into real
 * `cache_control: {type:'ephemeral'}` content parts; it is only ever true for an
 * Anthropic-family model id on this endpoint (see `promptCacheMode`). With it
 * off the serialization is byte-identical to the plain string form this adapter
 * has always sent, which is also the form a gateway that rejects the parts gets
 * resent in.
 */
function buildMessages(request: StreamRequest, withMarkers: boolean): Array<{ role: string; content: RenderedContent }> {
  const shaped = shapeStablePrefix(request.provider, request.model, request.messages).messages;
  const messages: Array<{ role: string; content: RenderedContent }> = [];
  if (request.systemInstruction) {
    // The system instruction is the longest-lived block in the request, so on a
    // marked provider it gets its own breakpoint: everything before a
    // `cache_control` marker is what the provider stores, and an unmarked system
    // block would push the whole instruction into the volatile tail.
    messages.push({
      role: 'system',
      content: withMarkers ? markStableText(request.systemInstruction) : request.systemInstruction
    });
  }
  shaped.forEach((message) => messages.push({
    role: message.role,
    content: withMarkers ? renderCacheableContent(message) : message.content
  }));
  return messages;
}

/**
 * How gateways say "I do not understand that content part". Narrow on purpose:
 * anything else falls through to the normal error path, because replaying a
 * request costs the user tokens.
 */
function rejectsCacheControl(payload: string): boolean {
  return /cache_control|cache control|content part|unexpected extra|extra inputs are not permitted|invalid.*content.*type|unsupported.*content/i.test(
    payload
  );
}

/** OpenAI-compatible servers spell the reasoning stream three different ways. */
function reasoningText(delta: Record<string, unknown>): string {
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = delta[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/** `fetchUpstream` insists on a signal; a route without one needs a dead switch. */
function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

/** OpenAI-compatible chat completions always live at `{base}/chat/completions`. */
function chatUrl(request: StreamRequest): string {
  const base = resolveCustomEndpoint(request.baseUrl);
  return `${base}/chat/completions`;
}

export async function streamCustomEndpoint(
  request: StreamRequest,
  sink: StreamSink
): Promise<StreamResult> {
  const { apiKey, model, temperature, signal } = request;
  const url = chatUrl(request);
  const mode = promptCacheMode(request.provider, model);
  const plan = shapeStablePrefix(request.provider, model, request.messages);
  const attempts = new AttemptCounter();
  const droppedFeatures: string[] = [];
  const maxOutputTokens = resolveBudgetCapabilities(request.provider, model).maxOutput ?? DEFAULT_MAX_OUTPUT;
  let servedModel: string | undefined;
  // `prompt_cache_key` is documented by OpenAI's own API and by nothing else in
  // ShadRox's provider set, so a Groq/OpenRouter/local server body never grows
  // an unknown field.
  const cacheKey = supportsPromptCacheKey(url) ? promptCacheKeyValue(plan) : undefined;

  const body = (withTemperature: boolean, withTools: boolean, withMarkers: boolean) =>
    JSON.stringify({
      model,
      messages: buildMessages(request, withMarkers),
      ...(withTemperature ? { temperature } : {}),
      max_tokens: maxOutputTokens,
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(withTools && request.toolDefinitions?.length
        ? {
            tools: request.toolDefinitions.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters }
            })),
            tool_choice: 'auto'
          }
        : {})
    });

  const send = (withTemperature: boolean, fetchAttempts: number, withTools: boolean, withMarkers: boolean) =>
    fetchUpstream(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: body(withTemperature, withTools, withMarkers)
      },
      signal,
      fetchAttempts,
      attempts
    );

  let withTools = Boolean(request.toolDefinitions?.length);
  let withMarkers = mode === 'cache_control';
  let response = await send(true, 1, withTools, withMarkers);
  let payload = response.ok ? '' : await readErrorPayload(response);

  // A gateway that forwards Claude but not Anthropic's content-part extension:
  // drop the markers, keep the request. One replay of a rejected body costs
  // nothing (it never reached a model), and the ordering discipline that
  // implicit prefix caching needs survives the downgrade untouched.
  if (!response.ok && withMarkers && rejectsCacheControl(payload)) {
    withMarkers = false;
    droppedFeatures.push('cache_control');
    response = await send(true, 1, withTools, withMarkers);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok && withTools && rejectsNativeTools(payload)) {
    withTools = false;
    droppedFeatures.push('tools');
    response = await send(true, 1, withTools, withMarkers);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  // `temperature` is optional in the OpenAI spec and some inference servers
  // reject it outright (local quant builds especially). One retry without it
  // costs nothing and turns a hard failure into a working chat.
  if (!response.ok && /temperature/i.test(payload)) {
    droppedFeatures.push('temperature');
    response = await send(false, 1, withTools, withMarkers);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  if (!response.ok) {
    throw new UpstreamError(
      sanitizeErrorMessage(payload, 'Custom endpoint ne request reject kar diya.'),
      response.status
    );
  }

  let fullText = '';
  let usage: TokenUsage = {};
  let finishReason: string | null = null;
  const toolCalls = new OpenAiToolCallCollector();

  const decoder = createSseDecoder(({ data }) => {
    if (!data || data === '[DONE]') return;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed?.error?.message) {
      throw new UpstreamError(
        sanitizeErrorMessage(parsed.error.message, 'Custom endpoint stream error.'),
        502
      );
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
      toolCalls.add(delta.tool_calls);
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (typeof parsed?.model === 'string' && parsed.model.trim()) {
      servedModel = parsed.model.trim();
    }
    usage = mergeOpenAiUsage(usage, parsed?.usage);
  });

  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Custom endpoint returned an empty stream.');
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
    throw new Error(sanitizeErrorMessage(error, 'Custom endpoint stream failed.'));
  }

  const calls = toolCalls.values();
  if (calls.length > 0) sink.toolCalls(calls);

  if (!fullText.trim() && calls.length === 0) {
    throw new Error(
      finishReason === 'length'
        ? 'Model hit its output limit before writing an answer. Try a shorter prompt or a bigger model.'
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
    // The report describes the FINAL wire payload: markers and tools reflect
    // whatever the fallback ladder actually kept, never the original plan.
    promptCache: promptCacheReport(shapeStablePrefix(request.provider, model, request.messages, {
      systemInstruction: request.systemInstruction,
      toolDefinitions: withTools ? request.toolDefinitions : undefined,
      emitMarkers: withMarkers
    })),
    ...(servedModel ? { servedModel } : {}),
    ...(droppedFeatures.length > 0 ? { droppedFeatures: [...droppedFeatures] } : {})
  };
  return result;
}

/**
 * Non-streaming completion for prompt refinement, where the caller wants one
 * JSON object rather than a token stream. `response_format` is optional in the
 * OpenAI spec, so endpoints that do not know it simply ignore the field.
 */
export async function refineWithCompatibleEndpoint(
  rawBaseUrl: unknown,
  apiKey: string,
  model: string,
  instruction: string,
  userText: string,
  signal?: AbortSignal
): Promise<string> {
  const url = `${resolveCustomEndpoint(rawBaseUrl)}/chat/completions`;
  const response = await fetchUpstream(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: userText }
        ]
      })
    },
    signal || neverAborts(),
    1
  );

  if (!response.ok) {
    throw new UpstreamError(
      sanitizeErrorMessage(await readErrorPayload(response), 'Custom endpoint ne request reject kar diya.'),
      response.status
    );
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}
