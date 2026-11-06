import { buildModelList, type ModelInfo, type ProviderId } from './providers';
import { createSseDecoder } from './sse';
import {
  aiderRetryMessage,
  DEFAULT_RETRY_SETTINGS,
  planRetry,
  REAL_RETRY_DEPS,
  type RetryClockDeps,
  type RetrySettings
} from './ai/backoff';
import {
  classifyFailure,
  EXCEPTION_INFO,
  parseRetryAfterSeconds,
  type ExInfo
} from './ai/retryPolicy';
import type { RefineMode } from './types';

export interface ValidateKeyResult {
  latencyMs: number;
  models: ModelInfo[];
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** How much reasoning the upstream model should spend before answering. */
export type ThinkingLevel = 'low' | 'high';

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface RefineModeMeta {
  id: RefineMode;
  label: string;
  /** Compact label for the segmented control. */
  short: string;
  hint: string;
  thinking: ThinkingLevel;
  /** `plan` is the only mode that must never emit file blocks. */
  writesFiles: boolean;
}

export const REFINE_MODES: RefineModeMeta[] = [
  {
    id: 'code',
    label: 'Code (Direct File Edits)',
    short: 'Code',
    hint: 'Direct code implementation — fast, concise, writes and patches files.',
    thinking: 'low',
    writesFiles: true
  },
  {
    id: 'plan',
    label: 'Plan (Read-only Architecture)',
    short: 'Plan',
    hint: 'System architecture and review only. AI will not modify files.',
    thinking: 'high',
    writesFiles: false
  },
  {
    id: 'complex',
    label: 'Complex (Deep Reasoning)',
    short: 'Complex',
    hint: 'Deep reasoning and multi-file architecture for complex logic.',
    thinking: 'high',
    writesFiles: true
  }
];

export function getRefineMode(mode: RefineMode): RefineModeMeta {
  return REFINE_MODES.find((entry) => entry.id === mode) || REFINE_MODES[0];
}

export interface StreamChatOptions {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  /** Only for provider `custom`: the OpenAI-compatible endpoint to call. */
  baseUrl?: string;
  messages: ChatTurn[];
  systemInstruction?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  /** Partial reply text from an interrupted stream, for resume-with-dedupe. */
  resumePrefix?: string;
  /** Optional provider-native function definitions; absent on ordinary chat requests. */
  toolDefinitions?: ChatToolDefinition[];
  /**
   * Retry/backoff overrides for this turn (aider's discipline, see
   * ./ai/backoff.ts). `now`/`sleep`/`rng`/`setTimer`/`clearTimer` are the test
   * seam — production never passes them.
   */
  retry?: Partial<RetrySettings> & Partial<RetryClockDeps>;
}

export interface StreamDoneInfo {
  /** What the provider reported as the all-in total; the number shown in the UI. */
  tokens: number;
  /** Absent when the provider reported no split, which is not the same as zero. */
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache tokens reported by the provider, already included in inputTokens. */
  cachedInputTokens?: number;
  provider: ProviderId;
  model: string;
  tier: string;
  finishReason?: string | null;
  /** Milliseconds until the first delta/reasoning chunk arrived. */
  firstTokenMs?: number | null;
  durationMs?: number | null;
}

/**
 * The retry notification hook — the port of aider's
 * `io.tool_warning(err_msg)` + `print(f"Retrying in {retry_delay:.1f} seconds...")`
 * from base_coder.py `send_messages`. Surfacing it is the host's call: App.tsx
 * owns the notice channel (`announce()`), so these are optional callbacks —
 * wiring `onRetry`/`onWarning` to `announce` in App is a one-line seam for the
 * UI owner, not a requirement for the retries to work.
 */
export interface StreamRetryNotice {
  /** The attempt that just failed (1-based). */
  attempt: number;
  maxAttempts: number;
  /** How long we will wait before the next attempt, after jitter/Retry-After. */
  delayMs: number;
  /** Aider's ExInfo class name, e.g. 'RateLimitError'. */
  reason: string;
  /** Human text equivalent to what aider printed. */
  message: string;
}

export interface StreamChatHandlers {
  onDelta: (text: string) => void;
  /** Model reasoning/thinking stream, when the provider exposes it. */
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: NativeToolCall[]) => void;
  onDone?: (info: StreamDoneInfo) => void;
  onError: (message: string) => void;
  /** Emitted before each backoff sleep — "Retrying in X seconds..." (aider). */
  onRetry?: (notice: StreamRetryNotice) => void;
  /**
   * Aider's tool_warning channel. Today: a mid-stream break that keeps the
   * partial reply — the turn is *not* destroyed, the user is warned instead.
   */
  onWarning?: (message: string) => void;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** Validates a BYOK key and returns every chat model that key can actually use. */
export async function validateProviderKey(
  provider: ProviderId,
  apiKey: string,
  baseUrl?: string
): Promise<ValidateKeyResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch('/api/byok/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ provider, apiKey, baseUrl: baseUrl || undefined })
    });
  } catch (error) {
    throw new Error(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'Request timed out after 20 seconds. Please check your network and try again.'
        : 'Could not connect to API server. Ensure the server is running.'
    );
  } finally {
    window.clearTimeout(timeout);
  }

  const data = await readJson(response);

  if (!response.ok || !data?.ok) {
    if (response.ok && !data?.error) {
      throw new Error(
        `Unexpected server response (HTTP ${response.status}) from /api/byok/validate.`
      );
    }
    throw new Error(data?.error || `Failed to validate key (HTTP ${response.status}).`);
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

  if (models.length === 0 && provider !== 'custom') {
    throw new Error('Key is valid, but no compatible chat models were returned.');
  }

  return { latencyMs: data.latencyMs ?? 0, models };
}

/**
 * Builds a stateful filter that strips an echoed partial reply from the start
 * of a resumed stream. The model is told not to repeat the prefix, but many
 * providers echo it anyway; we consume code points until the stream diverges
 * from the prefix, then pass everything through untouched.
 */
export function createPrefixStripper(prefix: string): (text: string) => string {
  const expected = Array.from(prefix);
  let cursor = 0;
  let matching = true;
  return (text: string) => {
    if (!matching) return text;
    let output = '';
    for (const char of text) {
      if (cursor < expected.length) {
        if (char === expected[cursor]) {
          cursor += 1;
          continue;
        }
        matching = false;
      }
      output += char;
    }
    return output;
  };
}

/**
 * Streams a chat completion as normalised SSE events from /api/ai/chat.
 *
 * The retry discipline around this call is ported from aider — see
 * ./ai/backoff.ts (aider/models.py `simple_send_with_retries` + base_coder.py
 * `send_messages` retry loop, Apache-2.0) and ./ai/retryPolicy.ts
 * (aider/exceptions.py classification). Retryable failures — lost connections,
 * 429, 5xx, provider timeouts — re-issue the request after exponential backoff
 * that doubles from 0.125 s (aider's numbers), capped by aider's RETRY_TIMEOUT,
 * plus jitter, a retry count, a max-elapsed deadline, and respect for
 * `Retry-After` when the provider sends one.
 *
 * IDEMPOTENCY RULE (stricter than aider on purpose): a request body is replayed
 * only while nothing of the reply has reached this client — connection lost
 * before the first token. Once the model has produced any output, a mid-stream
 * break gets aider's end-of-reply treatment instead: the partial answer stays
 * on screen, the user is warned (`onWarning`), and the turn ends via `onError`
 * so the host can mark the reply resumable. We never silently re-spend a turn
 * the model already saw.
 */
export async function streamChat(options: StreamChatOptions, handlers: StreamChatHandlers): Promise<void> {
  const overrides = options.retry ?? {};
  const settings: RetrySettings = { ...DEFAULT_RETRY_SETTINGS };
  (Object.keys(DEFAULT_RETRY_SETTINGS) as (keyof RetrySettings)[]).forEach((key) => {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) settings[key] = value;
  });
  const deps: RetryClockDeps = {
    now: overrides.now ?? REAL_RETRY_DEPS.now,
    sleep: overrides.sleep ?? REAL_RETRY_DEPS.sleep,
    rng: overrides.rng ?? REAL_RETRY_DEPS.rng,
    setTimer: overrides.setTimer ?? REAL_RETRY_DEPS.setTimer,
    clearTimer: overrides.clearTimer ?? REAL_RETRY_DEPS.clearTimer
  };

  const startedAt = deps.now();
  // aider's loop seeds `retry_delay = 0.125` and doubles it on every failure;
  // the carried value is always the un-jittered doubling.
  let previousDelayMs = settings.initialDelayMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const failure = await runStreamAttempt(options, handlers, deps, settings);
    if (!failure) return;

    const plan = planRetry({
      previousDelayMs,
      failedAttempt: attempt,
      elapsedMs: deps.now() - startedAt,
      retryAfterSeconds: failure.retryAfterSeconds,
      settings,
      rng: deps.rng
    });
    if (plan.kind === 'exhausted') {
      const description = failure.exInfo.description ? ` ${failure.exInfo.description}` : '';
      const gaveUp = attempt > 1 ? ` Giving up after ${attempt} attempts.` : '';
      handlers.onError(`${failure.message}${description}${gaveUp}`);
      return;
    }

    handlers.onRetry?.({
      attempt,
      maxAttempts: settings.maxAttempts,
      delayMs: plan.delayMs,
      reason: failure.exInfo.name,
      message: aiderRetryMessage(failure.exInfo.description, plan.delayMs, attempt, settings.maxAttempts)
    });
    previousDelayMs = plan.nextDelayMs;
    if (await sleepUnlessAborted(plan.delayMs, options.signal, deps)) return;
  }
}

/** A retryable pre-first-token failure; `null` means the turn was terminal. */
interface RetryableFailure {
  exInfo: ExInfo;
  message: string;
  retryAfterSeconds: number | null;
}

/** Raised internally when the stream goes byte-silent past `idleTimeoutMs`. */
class StreamIdleTimeoutError extends Error {
  constructor() {
    super('stream-idle-timeout');
    this.name = 'StreamIdleTimeoutError';
  }
}

/**
 * Aider's "keep the partial, warn the user" behaviour for a broken stream —
 * adapted to ShadRox: App's error path already preserves the partial text and
 * offers Resume (see streamSnapshot.ts), so the warning tells the user that is
 * what happened instead of losing the turn.
 */
const PARTIAL_KEPT_WARNING =
  'Connection dropped mid-reply — the partial answer is kept, press Resume to continue from it.';

async function runStreamAttempt(
  options: StreamChatOptions,
  handlers: StreamChatHandlers,
  deps: RetryClockDeps,
  settings: RetrySettings
): Promise<RetryableFailure | null> {
  const {
    provider,
    model,
    apiKey,
    baseUrl,
    messages,
    systemInstruction,
    temperature,
    thinking,
    signal,
    resumePrefix,
    toolDefinitions
  } = options;

  let response: Response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        provider,
        model,
        apiKey,
        baseUrl: provider === 'custom' ? baseUrl : undefined,
        messages,
        systemInstruction,
        temperature,
        thinking,
        resume: resumePrefix ? { prefix: resumePrefix } : undefined,
        toolDefinitions
      })
    });
  } catch (error) {
    if (signal?.aborted) return null;
    if (error instanceof TypeError) {
      // aider: litellm APIConnectionError, retryable. Safe to replay — the body
      // never produced a token, so there is nothing to duplicate.
      return {
        exInfo: EXCEPTION_INFO.APIConnectionError,
        message:
          'Could not reach the ShadRox AI service. Check your internet connection and try again.',
        retryAfterSeconds: null
      };
    }
    handlers.onError(
      error instanceof Error && error.name === 'AbortError'
        ? 'Generation stopped.'
        : error instanceof Error ? error.message : 'Network error.'
    );
    return null;
  }

  if (!response.ok) {
    const data = await readJson(response);
    const serverMessage: string | undefined =
      typeof data?.error === 'string' && data.error ? data.error : undefined;
    const exInfo = classifyFailure(response.status, serverMessage);
    const message = serverMessage || `Request failed (HTTP ${response.status}).`;
    if (exInfo.retry) {
      return {
        exInfo,
        message,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('retry-after'))
      };
    }
    handlers.onError(message);
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    handlers.onError('Stream unavailable.');
    return null;
  }

  const textDecoder = new TextDecoder();
  let streamError: string | null = null;
  let sawDone = false;
  let receivedOutput = false;
  const stripPrefix = resumePrefix ? createPrefixStripper(resumePrefix) : null;

  const decoder = createSseDecoder(({ data }) => {
    if (!data || data === '[DONE]') return;

    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (event.type === 'delta' && typeof event.text === 'string') {
      receivedOutput = true;
      handlers.onDelta(stripPrefix ? stripPrefix(event.text) : event.text);
    } else if (event.type === 'reasoning' && typeof event.text === 'string') {
      receivedOutput = true;
      handlers.onReasoning?.(event.text);
    } else if (event.type === 'tool_calls' && Array.isArray(event.calls)) {
      const calls = event.calls.filter((call: unknown): call is NativeToolCall =>
        Boolean(call && typeof call === 'object' &&
          typeof (call as NativeToolCall).id === 'string' &&
          typeof (call as NativeToolCall).name === 'string' &&
          typeof (call as NativeToolCall).arguments === 'string')
      );
      if (calls.length > 0) {
        receivedOutput = true;
        handlers.onToolCalls?.(calls);
      }
    } else if (event.type === 'done') {
      sawDone = true;
      handlers.onDone?.({
        tokens: event.tokens ?? 0,
        inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : undefined,
        outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : undefined,
        cachedInputTokens: typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : undefined,
        provider: event.provider ?? provider,
        model: event.model ?? model,
        tier: event.tier ?? 'byok',
        finishReason: event.finishReason ?? null,
        firstTokenMs: typeof event.firstTokenMs === 'number' ? event.firstTokenMs : null,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : null
      });
    } else if (event.type === 'error') {
      streamError = event.message || 'AI generation failed.';
    }
  });

  try {
    while (true) {
      const { done, value } = await readWithinIdleWindow(reader, deps, settings.idleTimeoutMs);
      if (done) break;
      decoder.push(textDecoder.decode(value, { stream: true }));
    }
    decoder.flush();
  } catch (error) {
    await cancelQuietly(reader);
    if (signal?.aborted) return null;

    if (error instanceof StreamIdleTimeoutError) {
      const message = 'The AI stream went silent before it finished.';
      if (receivedOutput) {
        // aider partial + warning: the mid-stream timeout is NOT replayed.
        handlers.onWarning?.(PARTIAL_KEPT_WARNING);
        handlers.onError(message);
        return null;
      }
      // aider: Timeout — "The API provider timed out without returning a
      // response. They may be down or overloaded." Retryable, replay-safe.
      return { exInfo: EXCEPTION_INFO.Timeout, message, retryAfterSeconds: null };
    }

    if (error instanceof Error && error.name === 'AbortError') {
      handlers.onError('Generation stopped.');
      return null;
    }

    if (receivedOutput) {
      handlers.onWarning?.(PARTIAL_KEPT_WARNING);
      handlers.onError('The AI stream was interrupted before it finished.');
      return null;
    }
    // Connection lost before the first token: nothing reached the UI, so a
    // replay duplicates no work and no output.
    return {
      exInfo: EXCEPTION_INFO.APIConnectionError,
      message: 'The AI stream was interrupted before it finished.',
      retryAfterSeconds: null
    };
  }

  if (signal?.aborted) return null;

  if (streamError) {
    const exInfo = classifyFailure(null, streamError);
    if (exInfo.retry && !receivedOutput) {
      return { exInfo, message: streamError, retryAfterSeconds: null };
    }
    if (exInfo.retry && receivedOutput) {
      handlers.onWarning?.(PARTIAL_KEPT_WARNING);
    }
    handlers.onError(streamError);
    return null;
  }

  if (!sawDone) {
    if (receivedOutput) {
      // The connection closed cleanly without a done event; finalise the UI
      // instead of leaving the reply stuck in a streaming state.
      handlers.onDone?.({ tokens: 0, provider, model, tier: 'byok', finishReason: 'stream-ended' });
    } else {
      handlers.onError('The model returned an empty response.');
    }
  }
  return null;
}

/**
 * ADAPTATION (ShadRox): the "mid-stream hang" the retry loop needs to see.
 * A provider that stops sending bytes never throws on its own, so each read is
 * raced against an idle window. On expiry the attempt dies as a `Timeout`
 * (aider's class), which the loop replays before the first token and warns-
 * about-keeps after it.
 */
async function readWithinIdleWindow(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deps: RetryClockDeps,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleTimeoutMs <= 0) return reader.read();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const timer = deps.setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new StreamIdleTimeoutError());
    }, idleTimeoutMs);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        deps.clearTimer(timer);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        deps.clearTimer(timer);
        reject(error);
      }
    );
  });
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    /* the stream is already dead */
  }
  try {
    reader.releaseLock();
  } catch {
    /* nothing to release */
  }
}

/** Backoff sleep that cuts short the moment the user stops the generation. */
async function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
  deps: RetryClockDeps
): Promise<boolean> {
  if (signal?.aborted) return true;
  if (!signal) {
    await deps.sleep(ms);
    return false;
  }
  let listener: (() => void) | null = null;
  const aborted = new Promise<'aborted'>((resolve) => {
    listener = () => resolve('aborted');
    signal.addEventListener('abort', listener, { once: true });
  });
  const winner = await Promise.race([deps.sleep(ms).then(() => 'slept' as const), aborted]);
  if (listener) signal.removeEventListener('abort', listener);
  return winner === 'aborted';
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
  customKey?: string;
  baseUrl?: string;
  /** Needed when `provider` is custom — this route has no model of its own there. */
  model?: string;
  provider: ProviderId;
  contextInfo: string;
  mode?: RefineMode;
}): Promise<RefinedPrompt> {
  const activeKey =
    options.provider === 'gemini'
      ? options.geminiKey
      : options.provider === 'groq'
        ? options.groqKey
        : options.customKey;
  const body: Record<string, unknown> = {
    rawPrompt: options.rawPrompt,
    provider: options.provider,
    contextInfo: options.contextInfo,
    mode: options.mode,
    model: options.model,
    baseUrl: options.provider === 'custom' ? options.baseUrl : undefined
  };
  if (activeKey) {
    body.apiKeyByProvider = { [options.provider]: activeKey };
  }

  const response = await fetch('/api/prompt/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Prompt refine failed.');
  }
  return data as RefinedPrompt;
}
