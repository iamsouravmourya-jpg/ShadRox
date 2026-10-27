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
  RequestRejectedError,
  requiredString
} from '../_validate.js';
import type { ProviderId } from '../ai/_types.js';

interface RawModel {
  id: string;
  contextWindow?: number;
}

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

/** How many model rows a single validation call may return. */
const MAX_LISTED_MODELS = 400;

async function listGeminiModels(apiKey: string): Promise<RawModel[]> {
  const models: RawModel[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3; page += 1) {
    const url = new URL(GEMINI_MODELS_URL);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    // The key goes in the `x-goog-api-key` header (Google's documented
    // alternative), never in the query string where proxies log it.
    const response = await fetch(url.toString(), {
      headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' }
    });
    const data = (await response.json()) as {
      models?: Array<{
        name?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
      nextPageToken?: string;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(
        sanitizeErrorMessage(
          data?.error?.message || 'Gemini ne is API key ko reject kar diya.',
          'Gemini ne is API key ko reject kar diya.'
        )
      );
    }

    (data.models || []).forEach((model) => {
      const methods = model.supportedGenerationMethods || [];
      if (!methods.includes('generateContent') || !model.name) return;
      models.push({
        id: model.name.replace(/^models\//, ''),
        contextWindow: model.inputTokenLimit
      });
    });

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return models.slice(0, MAX_LISTED_MODELS);
}

async function listGroqModels(apiKey: string): Promise<RawModel[]> {
  const response = await fetch(GROQ_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  const data = (await response.json()) as {
    data?: Array<{ id?: string; context_window?: number; active?: boolean }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      sanitizeErrorMessage(
        data?.error?.message || 'Groq ne is API key ko reject kar diya.',
        'Groq ne is API key ko reject kar diya.'
      )
    );
  }

  return (data.data || [])
    .filter((model) => model.id && model.active !== false)
    .slice(0, MAX_LISTED_MODELS)
    .map((model) => ({
      id: model.id as string,
      contextWindow: model.context_window
    }));
}

/**
 * POST /api/byok/validate
 * Body: { provider: 'gemini' | 'groq', apiKey: string }
 * Returns: { ok, provider, latencyMs, models }
 *
 * The key is used in-memory for a single upstream call. It is never logged
 * and never persisted. This route only ever spends the CALLER's key, so the
 * shared-key spend guard does not apply here — an unkeyed call has nothing to
 * spend and fails with 400 before any upstream request.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let provider: ProviderId;
  let key: string;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.byokValidate });
    if (body.provider !== 'gemini' && body.provider !== 'groq') {
      throw new RequestRejectedError(400, 'Provider `gemini` ya `groq` hona chahiye.');
    }
    provider = body.provider;
    key = requiredString(body, 'apiKey', FIELD_LIMITS.apiKeyChars, 'API key required hai.');
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  const startedAt = Date.now();

  try {
    const models = provider === 'gemini' ? await listGeminiModels(key) : await listGroqModels(key);

    if (models.length === 0) {
      sendError(res, 422, 'Key valid hai par is par koi chat model available nahi mila.');
      return;
    }

    sendJson(res, 200, {
      ok: true,
      provider,
      latencyMs: Date.now() - startedAt,
      models
    });
  } catch (error) {
    const message = error instanceof Error
      ? sanitizeErrorMessage(error.message, 'Key validation failed.')
      : 'Key validation failed.';
    sendJson(res, 401, { ok: false, error: message });
  }
}
