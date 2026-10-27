import { capSystemInstruction, trimMessagesToBudget } from '../../src/lib/contextBudget.js';
import { resolveContextWindow } from '../../src/lib/modelCapabilities.js';
import type { ProviderAdapter } from './types.js';
import type { ChatMessage, ThinkingLevel } from './types.js';

export interface CompletionRequest {
  adapter: ProviderAdapter;
  model: string;
  apiKey: string;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  /** Stop reading once the reply reaches this size — cheap guard for inline use. */
  maxChars?: number;
  signal: AbortSignal;
}

export interface CompletionResult {
  text: string;
  tokens: number;
}

/**
 * Runs one non-streaming completion over the streaming adapters. Used by the
 * routes that need a whole answer at once: tab completion and commit messages.
 */
export async function completeOnce(request: CompletionRequest): Promise<CompletionResult> {
  const { adapter, model, apiKey, prompt, temperature, thinking, signal } = request;
  const maxChars = request.maxChars ?? 4_000;

  let messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  messages = trimMessagesToBudget(messages, resolveContextWindow(adapter.id, model)).messages;
  const systemInstruction = request.systemInstruction ? capSystemInstruction(request.systemInstruction) : undefined;

  // Truncate server-side: the model keeps talking but we stop listening, which
  // is the only way to bound latency for an inline suggestion.
  const inner = new AbortController();
  const abortInner = () => inner.abort();
  signal.addEventListener('abort', abortInner, { once: true });

  let text = '';
  try {
    const result = await adapter.stream(
      {
        provider: adapter.id,
        model,
        apiKey,
        messages,
        systemInstruction,
        temperature: temperature ?? 0.2,
        thinking: thinking ?? 'low',
        signal: inner.signal
      },
      {
        delta(chunk) {
          if (text.length >= maxChars) {
            inner.abort();
            return;
          }
          text += chunk;
        },
        reasoning() {
          /* reasoning is not part of a completion payload */
        }
      }
    );
    return { text: text.slice(0, maxChars), tokens: result.tokens };
  } catch (error) {
    // Hitting the cap is expected, not a failure: keep whatever arrived.
    if (error instanceof Error && error.name === 'AbortError' && text.length >= maxChars) {
      return { text: text.slice(0, maxChars), tokens: 0 };
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abortInner);
  }
}
