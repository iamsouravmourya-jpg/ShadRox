import { readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http.js';
import { ADAPTERS, isProviderId, resolveKeyAccess } from './access.js';
import { completeOnce } from './completion.js';
import type { ProviderId } from './types.js';

export const config = { maxDuration: 30 };

interface CommitMessageBody {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  status?: string;
  diff?: string;
  log?: string;
}

const SYSTEM_INSTRUCTION =
  'You write git commit messages. Read the status and diff, then output one commit message: ' +
  'a subject of at most 72 characters in the imperative mood, optionally followed by a blank line ' +
  'and 1-3 short body lines explaining the why. Output only the message text: no quotes, no labels, ' +
  'no markdown fences.';

/**
 * POST /api/ai/commit-message
 * Body: { provider, model, apiKey?, status, diff, log }
 * Returns: { message }
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const body = await readJsonBody<CommitMessageBody>(req);
  const provider: ProviderId = isProviderId(body.provider) ? body.provider : 'gemini';
  const adapter = ADAPTERS[provider];
  const model = (body.model || '').trim() || adapter.defaultModel;

  const resolved = resolveKeyAccess(provider, model, body.apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }

  const status = (body.status || '').slice(0, 4_000);
  const diff = (body.diff || '').slice(0, 60_000);
  const log = (body.log || '').slice(0, 2_000);
  if (!status.trim() && !diff.trim()) {
    sendError(res, 400, 'Working tree me koi change nahi hai — message generate karne ke liye kuch nahi hai.');
    return;
  }

  const prompt =
    `<status>\n${status || '(no status)'}\n</status>\n\n` +
    `<recent-commits>\n${log || '(none)'}\n</recent-commits>\n\n` +
    `<diff>\n${diff || '(no textual diff — see status)'}\n</diff>\n\n` +
    'Commit message:';

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
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.3,
      thinking: 'low',
      maxChars: 600,
      signal: abort.signal
    });
    const message = result.text
      .replace(/^\s*```[a-zA-Z]*\s*/, '')
      .replace(/\s*```\s*$/, '')
      .trim()
      .slice(0, 400);
    if (!message) {
      sendError(res, 502, 'Model ne koi message nahi banaya. Dobara try karo.');
      return;
    }
    sendJson(res, 200, { message });
  } catch (error) {
    if (abort.signal.aborted || res.writableEnded) return;
    sendError(res, 502, error instanceof Error ? error.message : 'Commit message generation failed.');
  }
}
