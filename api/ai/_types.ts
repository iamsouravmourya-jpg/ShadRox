export type ProviderId = 'gemini' | 'groq';

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
  messages?: ChatMessageInput[];
  systemInstruction?: string;
  temperature?: number;
  /** 'high' asks the model to reason before answering; 'low' keeps it snappy. */
  thinking?: ThinkingLevel;
  /** Resumes an interrupted stream: the partial reply the model should continue from. */
  resume?: { prefix?: string };
}

export interface StreamRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  systemInstruction?: string;
  temperature: number;
  thinking?: ThinkingLevel;
  signal: AbortSignal;
}

export interface StreamSink {
  delta(text: string): void;
  reasoning(text: string): void;
}

export interface StreamResult {
  tokens: number;
  finishReason: string | null;
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
