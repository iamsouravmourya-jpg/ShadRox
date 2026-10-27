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
import { resolveKeyAccess } from '../ai/_access.js';
import { checkSharedKeySpend, clientIp, outputCeiling, rateLimitedMessage } from '../ai/_spendGuard.js';
import type { ProviderId } from '../ai/_types.js';

type RefineMode = 'code' | 'plan' | 'complex';

export const config = { maxDuration: 30 };

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/** The model this route actually calls, per provider — the tier gate keys off it. */
const ROUTE_MODEL: Record<ProviderId, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  groq: DEFAULT_GROQ_MODEL
};

const PROVIDERS = ['gemini', 'groq'] as const;

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
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let provider: ProviderId;
  let rawPrompt: string;
  let contextInfo: string;
  let mode: RefineMode;
  let userKey: string | undefined;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.refine });
    provider = enumValue<ProviderId>(body, 'provider', PROVIDERS, 'gemini');
    rawPrompt = requiredString(body, 'rawPrompt', FIELD_LIMITS.refinePromptChars, 'Prompt text chahiye.');
    contextInfo = optionalString(body, 'contextInfo', FIELD_LIMITS.refineContextChars);
    mode = enumValue<RefineMode>(body, 'mode', ['code', 'plan', 'complex'] as const, 'code');
    // A plain `apiKey` is only honoured for the provider the caller named, which
    // is what the client used to do.
    const keys = keyByProvider(body, PROVIDERS);
    const plainKey = optionalKey(body);
    userKey = keys[provider] || (body.provider === provider ? plainKey : undefined);
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  // BYOK policy, shared with chat/fim/commit-message: this route used to read
  // `process.env.SHADROX_GEMINI_API_KEY` as its own fallback, which let any
  // anonymous caller on the public Vercel deployment spend the operator's key
  // with no tier gate and no limit. The env fallback is gone on purpose —
  // `resolveKeyAccess` is the only path to a shared key, and it still requires
  // a Pro-tier model, which this route's fixed free-tier models never are.
  const resolved = resolveKeyAccess(provider, ROUTE_MODEL[provider], userKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }
  const { apiKey, byok } = resolved.access;

  const decision = checkSharedKeySpend('refine', clientIp(req), byok);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    sendError(res, 429, rateLimitedMessage(decision.retryAfterSeconds));
    return;
  }

  const instruction = buildInstruction(contextInfo || 'React + TypeScript workspace', mode);
  const ceiling = outputCeiling('refine', byok);

  try {
    const produced =
      provider === 'gemini'
        ? await refineWithGemini(apiKey, rawPrompt, instruction)
        : await refineWithGroq(apiKey, rawPrompt, instruction);

    // Shared-key requests get the hard output ceiling; `Infinity` (BYOK) is a no-op.
    const raw = produced.slice(0, ceiling);
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

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
