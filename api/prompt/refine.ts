import {
  readJsonBody,
  readErrorPayload,
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
  keyByProvider,
  optionalKey,
  optionalString,
  requiredString
} from '../_validate.js';
import { parseProviderId, resolveKeyAccess } from '../ai/_access.js';
import { resolveCustomEndpoint } from '../ai/_endpoint.js';
import { refineWithCompatibleEndpoint } from '../ai/_compatible.js';
import type { ProviderId } from '../ai/_types.js';

type RefineMode = 'code' | 'plan' | 'complex';

export const config = { maxDuration: 30 };

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

const PROVIDERS: ProviderId[] = ['gemini', 'groq', 'custom'];

/** How the refined prompt should be shaped, per thinking mode. */
const MODE_DIRECTIVE: Record<RefineMode, string> = {
  code:
    'Mode: CODE. Shape the prompt so the model produces working code with minimal deliberation. Keep it tight and implementation-focused.',
  plan:
    'Mode: PLAN ONLY. The user wants architecture and planning, not code. Shape the prompt so the model answers with a plan: approach, file-by-file changes, data flow, trade-offs and risks. Explicitly tell it NOT to output any code block or file rewrite.',
  complex:
    'Mode: COMPLEX CODE. Shape the prompt for a hard change: include the constraints, edge cases and invariants the model must respect, and ask it to work through the design before producing code.'
};

function buildInstruction(contextInfo: string, mode: RefineMode): string {
  return `You are the ShadRox Multilingual Prompt Refinement Engine.
The developer speaks or types in any language (Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Spanish, French or English).
Run this 3 step pipeline:
1. Identify the input language and translate it into clear developer English.
2. Work out the real intent (which feature, bug, component or logic the developer wants).
3. Turn it into one structured, high-context prompt for a coding model. Workspace context: ${contextInfo}.

${MODE_DIRECTIVE[mode]}

Reply strictly as JSON with this schema:
{
  "detectedLanguage": "string",
  "translatedText": "string",
  "intent": "string",
  "refinedPrompt": "string"
}`;
}

async function refineWithGemini(apiKey: string, rawPrompt: string, instruction: string): Promise<string> {
  // `x-goog-api-key` is Google's documented alternative to the `?key=` query
  // parameter: query strings end up in proxy/CDN logs next to the model name.
  const response = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: rawPrompt }] }],
        systemInstruction: { parts: [{ text: instruction }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
      })
    }
  );

  if (!response.ok) throw new Error(await readErrorPayload(response));

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

async function refineWithGroq(apiKey: string, rawPrompt: string, instruction: string): Promise<string> {
  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: DEFAULT_GROQ_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: rawPrompt }
      ]
    })
  });

  if (!response.ok) throw new Error(await readErrorPayload(response));

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

/**
 * POST /api/prompt/refine
 * Voice/text pipeline: any language -> English -> intent -> structured prompt.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed. Use POST.', 'METHOD_NOT_ALLOWED');
    return;
  }

  let provider: ProviderId;
  let rawPrompt: string;
  let contextInfo: string;
  let mode: RefineMode;
  let model: string;
  let endpoint = '';
  let userKey: string | undefined;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.refine });
    provider = parseProviderId(body);
    rawPrompt = requiredString(body, 'rawPrompt', FIELD_LIMITS.refinePromptChars, 'Prompt text is required.', 'PROMPT_REQUIRED');
    contextInfo = optionalString(body, 'contextInfo', FIELD_LIMITS.refineContextChars);
    mode = enumValue<RefineMode>(body, 'mode', ['code', 'plan', 'complex'] as const, 'code');
    model = optionalString(body, 'model', FIELD_LIMITS.modelChars).trim();
    // A custom endpoint is the user's own URL, vetted before anything is fetched.
    endpoint = provider === 'custom' ? await resolveCustomEndpoint(body.baseUrl) : '';
    // A plain `apiKey` is only honoured for the provider the caller named, which
    // is what the client used to do.
    const keys = keyByProvider(body, PROVIDERS);
    const plainKey = optionalKey(body);
    userKey = keys[provider] || (body.provider === provider ? plainKey : undefined);
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  if (provider === 'custom' && !model) {
    sendError(
      res,
      400,
      'A model id is required for custom endpoints. Verify your endpoint in Settings → Models & Keys or add one under "Model ids".',
      'MODEL_ID_REQUIRED'
    );
    return;
  }

  // BYOK policy, shared with chat/fim/commit-message: the caller's own key is
  // the only path, and a request without one is refused here.
  const resolved = resolveKeyAccess(userKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error, 'BYOK_KEY_REQUIRED');
    return;
  }
  const { apiKey } = resolved.access;

  const instruction = buildInstruction(contextInfo || 'React + TypeScript workspace', mode);

  try {
    const produced =
      provider === 'gemini'
        ? await refineWithGemini(apiKey, rawPrompt, instruction)
        : provider === 'groq'
          ? await refineWithGroq(apiKey, rawPrompt, instruction)
          : await refineWithCompatibleEndpoint(endpoint, apiKey, model, instruction, rawPrompt);

    const cleaned = produced.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed: {
      detectedLanguage?: string;
      translatedText?: string;
      intent?: string;
      refinedPrompt?: string;
    } = {};

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {};
    }

    sendJson(res, 200, {
      detectedLanguage: parsed.detectedLanguage || 'Detected automatically',
      translatedText: parsed.translatedText || rawPrompt,
      intent: parsed.intent || 'Code change',
      refinedPrompt: parsed.refinedPrompt || parsed.translatedText || rawPrompt
    });
  } catch (error) {
    sendError(
      res,
      502,
      error instanceof Error ? sanitizeErrorMessage(error.message, 'Prompt refine failed.') : 'Prompt refine failed.'
    );
  }
}
