import {
  readJsonBody,
  sendError,
  sendJson,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import { buildFimMessages, postprocessFimCompletion } from '../../src/lib/fim.js';
import { ADAPTERS, isProviderId, resolveKeyAccess } from './access.js';
import { completeOnce } from './completion.js';
import type { ProviderId } from './types.js';

export const config = { maxDuration: 15 };

interface FimBody {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  prefix?: string;
  suffix?: string;
  language?: string;
}

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

  const body = await readJsonBody<FimBody>(req);
  const prefix = typeof body.prefix === 'string' ? body.prefix : '';
  const suffix = typeof body.suffix === 'string' ? body.suffix : '';
  if (!prefix.trim()) {
    sendJson(res, 200, { text: '', tokens: 0 });
    return;
  }

  const provider: ProviderId = isProviderId(body.provider) ? body.provider : 'gemini';
  const adapter = ADAPTERS[provider];
  const model = (body.model || '').trim() || adapter.defaultModel;

  const resolved = resolveKeyAccess(provider, model, body.apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }

  const { systemInstruction, prompt } = buildFimMessages(prefix, suffix, body.language || 'code');

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const result = await completeOnce({
      adapter,
      model,
      apiKey: resolved.access.apiKey,
      prompt,
      systemInstruction,
      temperature: 0.1,
      thinking: 'low',
      maxChars: 600,
      signal: abort.signal
    });
    sendJson(res, 200, { text: postprocessFimCompletion(result.text, suffix), tokens: result.tokens });
  } catch (error) {
    if (abort.signal.aborted || res.writableEnded) return;
    // Tab completion is opportunistic: a failure silently means "no suggestion".
    sendJson(res, 200, { text: '', tokens: 0, warning: error instanceof Error ? error.message : 'completion failed' });
  }
}
