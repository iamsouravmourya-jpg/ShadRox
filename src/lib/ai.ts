import { buildModelList, type ModelInfo, type ProviderId } from './providers';

export interface ValidateKeyResult {
  latencyMs: number;
  models: ModelInfo[];
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamChatOptions {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  messages: ChatTurn[];
  systemInstruction?: string;
  signal?: AbortSignal;
}

export interface StreamChatHandlers {
  onDelta: (text: string) => void;
  onDone?: (info: { tokens: number; provider: ProviderId; model: string; tier: string }) => void;
  onError: (message: string) => void;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** Validates a BYOK key and returns every chat model that key can actually use. */
export async function validateProviderKey(provider: ProviderId, apiKey: string): Promise<ValidateKeyResult> {
  const response = await fetch('/api/byok/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey })
  });

  const data = await readJson(response);

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Key validate nahi ho payi (HTTP ${response.status}).`);
  }

  const rawModels: Array<{ id: string; contextWindow?: number }> = data.models || [];
  const contextWindows: Record<string, number> = {};
  rawModels.forEach((model) => {
    if (model.contextWindow) contextWindows[model.id] = model.contextWindow;
  });

  const models = buildModelList(
    provider,
    rawModels.map((model) => model.id),
    contextWindows
  );

  if (models.length === 0) {
    throw new Error('Key valid hai par koi chat model available nahi mila.');
  }

  return { latencyMs: data.latencyMs ?? 0, models };
}

/** Streams a chat completion as normalised SSE events from /api/ai/chat. */
export async function streamChat(options: StreamChatOptions, handlers: StreamChatHandlers): Promise<void> {
  const { provider, model, apiKey, messages, systemInstruction, signal } = options;

  let response: Response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ provider, model, apiKey, messages, systemInstruction })
    });
  } catch (error) {
    if (signal?.aborted) return;
    handlers.onError(error instanceof Error ? error.message : 'Network error.');
    return;
  }

  if (!response.ok) {
    const data = await readJson(response);
    handlers.onError(data?.error || `Request failed (HTTP ${response.status}).`);
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    handlers.onError('Stream unavailable.');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let streamError: string | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (event.type === 'delta' && typeof event.text === 'string') {
      handlers.onDelta(event.text);
    } else if (event.type === 'done') {
      handlers.onDone?.({
        tokens: event.tokens ?? 0,
        provider: event.provider ?? provider,
        model: event.model ?? model,
        tier: event.tier ?? 'byok'
      });
    } else if (event.type === 'error') {
      streamError = event.message || 'AI generation failed.';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.trim()) handleLine(buffer.trim());

  if (streamError) handlers.onError(streamError);
}

export interface RefinedPrompt {
  detectedLanguage: string;
  translatedText: string;
  intent: string;
  refinedPrompt: string;
}

/** Language -> English -> intent -> structured prompt pipeline. */
export async function refinePrompt(options: {
  rawPrompt: string;
  geminiKey?: string;
  groqKey?: string;
  provider: ProviderId;
  contextInfo: string;
}): Promise<RefinedPrompt> {
  const response = await fetch('/api/prompt/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawPrompt: options.rawPrompt,
      provider: options.provider,
      contextInfo: options.contextInfo,
      apiKeyByProvider: { gemini: options.geminiKey, groq: options.groqKey }
    })
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Prompt refine failed.');
  }
  return data as RefinedPrompt;
}
