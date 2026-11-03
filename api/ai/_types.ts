export type ProviderId = 'gemini' | 'groq' | 'custom';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ThinkingLevel = 'low' | 'high';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatMessageInput {
  role?: string;
  content?: string;
}

export interface ChatRequestBody {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  /** Caller-supplied base URL for `provider: 'custom'`; ignored by the others. */
  baseUrl?: string;
  messages?: ChatMessageInput[];
  systemInstruction?: string;
  temperature?: number;
  /** 'high' asks the model to reason before answering; 'low' keeps it snappy. */
  thinking?: ThinkingLevel;
  toolDefinitions?: NativeToolDefinition[];
  /** Resumes an interrupted stream: the partial reply the model should continue from. */
  resume?: { prefix?: string };
}

export interface StreamRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Validated base URL; only set for `provider: 'custom'`. */
  baseUrl?: string;
  messages: ChatMessage[];
  systemInstruction?: string;
  temperature: number;
  thinking?: ThinkingLevel;
  toolDefinitions?: NativeToolDefinition[];
  signal: AbortSignal;
}

export interface NativeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamSink {
  delta(text: string): void;
  reasoning(text: string): void;
  toolCalls(calls: ToolCallEntry[]): void;
}

export interface StreamResult {
  tokens: number;
  /**
   * Provider-reported usage split, present only when the provider reported it.
   * `tokens` stays the authoritative billing total: it is the provider's own
   * number, never recomputed from these parts.
   */
  inputTokens?: number;
  outputTokens?: number;
  finishReason: string | null;
}

/** Accumulated usage; a field is set only when some chunk reported it. */
export interface TokenUsage {
  total?: number;
  input?: number;
  output?: number;
  /** Gemini thinking models bill reasoning tokens on the output side. */
  thoughts?: number;
}

/**
 * Groq and OpenAI-compatible gateways put the usage object on the final chunk
 * only, so every field is taken from the last chunk that actually reported it.
 */
export function mergeOpenAiUsage(usage: TokenUsage, chunk: unknown): TokenUsage {
  if (!chunk || typeof chunk !== 'object') return usage;
  const u = chunk as Record<string, unknown>;
  return {
    ...usage,
    total: typeof u.total_tokens === 'number' ? u.total_tokens : usage.total,
    input: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : usage.input,
    output: typeof u.completion_tokens === 'number' ? u.completion_tokens : usage.output
  };
}

export function mergeGeminiUsage(usage: TokenUsage, metadata: unknown): TokenUsage {
  if (!metadata || typeof metadata !== 'object') return usage;
  const m = metadata as Record<string, unknown>;
  return {
    ...usage,
    total: typeof m.totalTokenCount === 'number' ? m.totalTokenCount : usage.total,
    input: typeof m.promptTokenCount === 'number' ? m.promptTokenCount : usage.input,
    output: typeof m.candidatesTokenCount === 'number' ? m.candidatesTokenCount : usage.output,
    thoughts: typeof m.thoughtsTokenCount === 'number' ? m.thoughtsTokenCount : usage.thoughts
  };
}

/**
 * StreamResult usage fields with unknown parts omitted, so the client can tell
 * "provider did not report" apart from "the model emitted nothing".
 */
export function usageFields(usage: TokenUsage): Pick<StreamResult, 'inputTokens' | 'outputTokens'> {
  const output =
    usage.output === undefined && usage.thoughts === undefined
      ? undefined
      : (usage.output ?? 0) + (usage.thoughts ?? 0);
  return {
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {})
  };
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly defaultModel: string;
  stream(request: StreamRequest, sink: StreamSink): Promise<StreamResult>;
}

export class UpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}
