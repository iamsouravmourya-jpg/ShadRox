import { createSseDecoder } from '../../src/lib/sse.js';
import { estimateTokens, readErrorPayload, sanitizeErrorMessage } from '../_http.js';
import { resolveCustomEndpoint } from './_endpoint.js';
import { UpstreamError, mergeOpenAiUsage, usageFields, type StreamRequest, type StreamResult, type StreamSink, type TokenUsage } from './_types.js';
import { OpenAiToolCallCollector, rejectsNativeTools } from './_toolCalls.js';
import { fetchUpstream } from './_upstream.js';

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

function buildMessages(request: StreamRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.systemInstruction) messages.push({ role: 'system', content: request.systemInstruction });
  request.messages.forEach((message) => messages.push({ role: message.role, content: message.content }));
  return messages;
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

  const body = (withTemperature: boolean, withTools: boolean) =>
    JSON.stringify({
      model,
      messages: buildMessages(request),
      ...(withTemperature ? { temperature } : {}),
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

  const send = (withTemperature: boolean, attempts: number, withTools: boolean) =>
    fetchUpstream(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: body(withTemperature, withTools)
      },
      signal,
      attempts
    );

  let withTools = Boolean(request.toolDefinitions?.length);
  let response = await send(true, 1, withTools);
  let payload = response.ok ? '' : await readErrorPayload(response);

  if (!response.ok && withTools && rejectsNativeTools(payload)) {
    withTools = false;
    response = await send(true, 1, withTools);
    payload = response.ok ? '' : await readErrorPayload(response);
  }

  // `temperature` is optional in the OpenAI spec and some inference servers
  // reject it outright (local quant builds especially). One retry without it
  // costs nothing and turns a hard failure into a working chat.
  if (!response.ok && /temperature/i.test(payload)) {
    response = await send(false, 1, withTools);
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

  return { tokens: usage.total || estimateTokens(fullText), ...usageFields(usage), finishReason };
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
