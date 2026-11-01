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
  requiredString
} from '../_validate.js';
import { parseProviderId } from '../ai/_access.js';
import { resolveCustomEndpoint } from '../ai/_endpoint.js';
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
 * OpenAI-compatible `/models` listing for a user-supplied endpoint.
 *
 * Gateways differ: some return `{data: []}`, others `{models: []}`, and a few
 * (mostly local runners) do not implement the route at all. A missing listing
 * is not a failed key, so 404/405/501 come back as an empty list — Settings
 * then asks the user to type the model ids instead of refusing the endpoint.
 */
export async function listCustomModels(baseUrl: string, apiKey: string): Promise<RawModel[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return [];
  }

  const text = await response.text();
  let data: {
    data?: Array<{ id?: string; context_window?: number; supports?: { chat?: boolean } }>;
    models?: Array<{ id?: string; name?: string; context_window?: number }>;
    error?: { message?: string };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error('Endpoint ne /models par JSON nahi bheja. Model id manually daalo.');
  }

  if (!response.ok) {
    throw new Error(
      sanitizeErrorMessage(
        data?.error?.message || 'Endpoint ne is API key ko reject kar diya.',
        'Endpoint ne is API key ko reject kar diya.'
      )
    );
  }

  const rows = data?.data || data?.models || [];
  const models: RawModel[] = [];
  for (const model of rows) {
    const id = (model.id || (model as { name?: string }).name || '').trim();
    if (!id) continue;
    if ((model as { supports?: { chat?: boolean } }).supports?.chat === false) continue;
    models.push({ id, contextWindow: model.context_window });
    if (models.length === MAX_LISTED_MODELS) break;
  }
  return models;
}

/**
 * POST /api/byok/validate
 * Body: { provider, apiKey, baseUrl? }
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
  // Empty unless the provider is custom, in which case resolveCustomEndpoint
  // guarantees a vetted URL before any fetch happens.
  let endpoint = '';

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.byokValidate });
    provider = parseProviderId(body);
    key = requiredString(body, 'apiKey', FIELD_LIMITS.apiKeyChars, 'API key required hai.');
    // A custom endpoint's URL is vetted before anything is fetched from it.
    endpoint = provider === 'custom' ? resolveCustomEndpoint(body.baseUrl) : '';
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  const startedAt = Date.now();

  try {
    const models =
      provider === 'gemini'
        ? await listGeminiModels(key)
        : provider === 'groq'
          ? await listGroqModels(key)
          : await listCustomModels(endpoint, key);

    // Only Gemini and Groq promise a listing. A gateway that returns no models
    // is still a working key — the user types the model ids in Settings.
    if (models.length === 0 && provider !== 'custom') {
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
