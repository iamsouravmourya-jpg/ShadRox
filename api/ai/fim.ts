import {
  readJsonBody,
  sanitizeErrorMessage,
  sendError,
  sendIfRejected,
  sendJson,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import {
  BODY_LIMITS,
  FIELD_LIMITS,
  enumValue,
  optionalKey,
  optionalString
} from '../_validate.js';
import { buildFimMessages, postprocessFimCompletion } from '../../src/lib/fim.js';
import { ADAPTERS, resolveKeyAccess } from './_access.js';
import { completeOnce } from './_completion.js';
import { checkSharedKeySpend, clientIp, outputCeiling, rateLimitedMessage } from './_spendGuard.js';
import type { ProviderId } from './_types.js';

export const config = { maxDuration: 15 };

/** How much ghost text a single completion may produce, in characters. */
const FIM_MAX_OUTPUT_CHARS = 600;

/**
 * POST /api/ai/fim
 * Body: { provider, model, apiKey?, prefix, suffix, language? }
 * Returns: { text, tokens } — the ghost text to render at the caret, or an
 * empty string when the model has nothing useful to add.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let provider: ProviderId;
  let model: string;
  let apiKey: string | undefined;
  let prefix: string;
  let suffix: string;
  let language: string;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.fim });
    provider = enumValue<ProviderId>(body, 'provider', ['gemini', 'groq'], 'gemini');
    model = optionalString(body, 'model', FIELD_LIMITS.modelChars).trim() || ADAPTERS[provider].defaultModel;
    apiKey = optionalKey(body);
    prefix = optionalString(body, 'prefix', FIELD_LIMITS.fimContextChars);
    suffix = optionalString(body, 'suffix', FIELD_LIMITS.fimContextChars);
    language = optionalString(body, 'language', FIELD_LIMITS.languageChars) || 'code';
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  if (!prefix.trim()) {
    sendJson(res, 200, { text: '', tokens: 0 });
    return;
  }

  const resolved = resolveKeyAccess(provider, model, apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }
  const { apiKey: spendKey, byok } = resolved.access;

  const decision = checkSharedKeySpend('completion', clientIp(req), byok);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    sendError(res, 429, rateLimitedMessage(decision.retryAfterSeconds));
    return;
  }

  const { systemInstruction, prompt } = buildFimMessages(prefix, suffix, language);

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const result = await completeOnce({
      adapter: ADAPTERS[provider],
      model,
      apiKey: spendKey,
      prompt,
      systemInstruction,
      temperature: 0.1,
      thinking: 'low',
      // The route cap protects latency; the shared-key ceiling protects the bill.
      maxChars: Math.min(FIM_MAX_OUTPUT_CHARS, outputCeiling('completion', byok)),
      signal: abort.signal
    });
    sendJson(res, 200, { text: postprocessFimCompletion(result.text, suffix), tokens: result.tokens });
  } catch (error) {
    if (abort.signal.aborted || res.writableEnded) return;
    // Tab completion is opportunistic: a failure silently means "no suggestion".
    sendJson(res, 200, {
      text: '',
      tokens: 0,
      warning: error instanceof Error ? sanitizeErrorMessage(error.message, 'completion failed') : 'completion failed'
    });
  }
}
