import { readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http';

type ProviderId = 'gemini' | 'groq';

interface RawModel {
  id: string;
  contextWindow?: number;
}

interface ValidateRequestBody {
  provider?: ProviderId;
  apiKey?: string;
}

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

async function listGeminiModels(apiKey: string): Promise<RawModel[]> {
  const models: RawModel[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3; page += 1) {
    const url = new URL(GEMINI_MODELS_URL);
    url.searchParams.set('pageSize', '200');
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url.toString());
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
      throw new Error(data?.error?.message || 'Gemini ne is API key ko reject kar diya.');
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

  return models;
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
    throw new Error(data?.error?.message || 'Groq ne is API key ko reject kar diya.');
  }

  return (data.data || [])
    .filter((model) => model.id && model.active !== false)
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
 * and never persisted.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const { provider, apiKey } = await readJsonBody<ValidateRequestBody>(req);
  const key = (apiKey || '').trim();

  if (!provider || (provider !== 'gemini' && provider !== 'groq')) {
    sendError(res, 400, 'Provider `gemini` ya `groq` hona chahiye.');
    return;
  }

  if (!key) {
    sendError(res, 400, 'API key required hai.');
    return;
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
    const message = error instanceof Error ? error.message : 'Key validation failed.';
    sendJson(res, 401, { ok: false, error: message });
  }
}
