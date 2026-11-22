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
  optionalKey,
  optionalString
} from '../_validate.js';
import { ADAPTERS, parseProviderId, resolveKeyAccess } from './_access.js';
import { resolveCustomEndpoint } from './_endpoint.js';
import { completeOnce } from './_completion.js';
import type { ProviderId } from './_types.js';

export const config = { maxDuration: 30 };

/** A commit message never needs more than this many characters of model output. */
const COMMIT_MAX_OUTPUT_CHARS = 600;

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
    sendError(res, 405, 'Method not allowed. Use POST.', 'METHOD_NOT_ALLOWED');
    return;
  }

  let provider: ProviderId;
  let model: string;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let status: string;
  let diff: string;
  let log: string;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.commitMessage });
    provider = parseProviderId(body);
    model = optionalString(body, 'model', FIELD_LIMITS.modelChars).trim();
    apiKey = optionalKey(body);
    if (provider === 'custom') {
      baseUrl = await resolveCustomEndpoint(body.baseUrl);
      // Unlike tab completion, this is a deliberate click: say what is missing.
      if (!model) {
        throw new RequestRejectedError(
          400,
          'A model id is required for custom endpoints — verify your endpoint in Settings → Models & Keys or add one under "Model ids".',
          'MODEL_ID_REQUIRED'
        );
      }
    } else {
      model = model || ADAPTERS[provider].defaultModel;
    }
    status = optionalString(body, 'status', FIELD_LIMITS.commitStatusChars);
    diff = optionalString(body, 'diff', FIELD_LIMITS.commitDiffChars);
    log = optionalString(body, 'log', FIELD_LIMITS.commitLogChars);
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  const adapter = ADAPTERS[provider];

  const resolved = resolveKeyAccess(apiKey);
  if ('error' in resolved) {
    sendError(res, 400, resolved.error, 'BYOK_KEY_REQUIRED');
    return;
  }
  const { apiKey: spendKey } = resolved.access;

  if (!status.trim() && !diff.trim()) {
    sendError(res, 400, 'There are no changes in the working tree to generate a commit message for.', 'NO_WORKING_TREE_CHANGES');
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
      apiKey: spendKey,
      baseUrl,
      prompt,
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.3,
      thinking: 'low',
      maxChars: COMMIT_MAX_OUTPUT_CHARS,
      signal: abort.signal
    });
    const message = result.text
      .replace(/^\s*```[a-zA-Z]*\s*/, '')
      .replace(/\s*```\s*$/, '')
      .trim()
      .slice(0, 400);
    if (!message) {
      sendError(res, 502, 'The model did not produce a commit message. Please try again.', 'EMPTY_MODEL_RESPONSE');
      return;
    }
    sendJson(res, 200, { message });
  } catch (error) {
    if (abort.signal.aborted || res.writableEnded) return;
    sendError(
      res,
      502,
      error instanceof Error ? sanitizeErrorMessage(error.message, 'Commit message generation failed.') : 'Commit message generation failed.'
    );
  }
}
