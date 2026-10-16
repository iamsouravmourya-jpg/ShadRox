import { readErrorPayload, readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http';

type ProviderId = 'gemini' | 'groq';

interface RefineRequestBody {
  rawPrompt?: string;
  provider?: ProviderId;
  apiKey?: string;
  apiKeyByProvider?: Partial<Record<ProviderId, string>>;
  contextInfo?: string;
}

export const config = { maxDuration: 30 };

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

function buildInstruction(contextInfo: string): string {
  return `You are the Devora Multilingual Prompt Refinement Engine.
The developer speaks or types in any language (Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Spanish, French or English).
Run this 3 step pipeline:
1. Identify the input language and translate it into clear developer English.
2. Work out the real intent (which feature, bug, component or logic the developer wants).
3. Turn it into one structured, high-context prompt for a coding model. Workspace context: ${contextInfo}.

Reply strictly as JSON with this schema:
{
  "detectedLanguage": "string",
  "translatedText": "string",
  "intent": "string",
  "refinedPrompt": "string"
}`;
}

async function refineWithGemini(apiKey: string, rawPrompt: string, instruction: string): Promise<string> {
  const response = await fetch(
    `${GEMINI_API_BASE}/models/${DEFAULT_GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  const body = await readJsonBody<RefineRequestBody>(req);
  const rawPrompt = (body.rawPrompt || '').trim();

  if (!rawPrompt) {
    sendError(res, 400, 'Prompt text chahiye.');
    return;
  }

  const geminiKey = (
    body.apiKeyByProvider?.gemini ||
    (body.provider === 'gemini' ? body.apiKey : '') ||
    process.env.DEVORA_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    ''
  ).trim();

  const groqKey = (body.apiKeyByProvider?.groq || (body.provider === 'groq' ? body.apiKey : '') || '').trim();

  if (!geminiKey && !groqKey) {
    sendError(res, 400, 'Prompt refine ke liye Gemini ya Groq key chahiye.');
    return;
  }

  const instruction = buildInstruction(body.contextInfo || 'React + TypeScript workspace');

  try {
    const raw = geminiKey
      ? await refineWithGemini(geminiKey, rawPrompt, instruction)
      : await refineWithGroq(groqKey, rawPrompt, instruction);

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
    const message = error instanceof Error ? error.message : 'Prompt refine failed.';
    sendError(res, 502, message);
  }
}
