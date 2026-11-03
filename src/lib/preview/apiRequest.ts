/**
 * Real API requests against a running local server.
 *
 * This replaces the old "Simulate" button, which returned a hardcoded
 * `{ simulated: true, status: 200 }` object. A request is now issued from the
 * renderer with `fetch`, so the status, timing and body are the server's, and a
 * server that is not running produces an honest failure instead of a made-up
 * success.
 */

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export const MAX_PATH_LENGTH = 1024;
export const MAX_BODY_LENGTH = 64_000;
export const MAX_RESPONSE_CHARS = 200_000;

export interface ApiRequestDraft {
  method: string;
  path: string;
  body?: string;
}

export interface ApiRequestResult {
  ok: boolean;
  status: number | null;
  statusText: string;
  durationMs: number;
  contentType: string | null;
  /** Raw text, capped at MAX_RESPONSE_CHARS. */
  body: string;
  truncated: boolean;
  /** Set when the body parsed as JSON, so the panel can pretty-print it. */
  json: unknown | null;
  error: string | null;
}

export type UrlResult = { ok: true; url: string } | { ok: false; reason: string };

export function isApiMethod(value: string): value is ApiMethod {
  return (API_METHODS as readonly string[]).includes(value.toUpperCase());
}

/**
 * Joins the typed path onto the running server's origin. Absolute URLs and
 * protocol-relative ones are refused: this panel tests the project's own server,
 * it is not a second browser window.
 */
export function joinApiUrl(baseUrl: string, rawPath: string): UrlResult {
  const path = rawPath.trim();
  if (!path) return { ok: false, reason: 'Enter a request path, e.g. /api/health.' };
  if (path.length > MAX_PATH_LENGTH) return { ok: false, reason: 'That path is too long.' };
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'That path contains invalid characters.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) {
    return { ok: false, reason: 'Only a path on the running server can be requested.' };
  }

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'No preview server is running.' };
  }

  const normalized = path.startsWith('/') ? path : `/${path}`;
  let target: URL;
  try {
    target = new URL(normalized, base);
  } catch {
    return { ok: false, reason: 'That path could not be parsed.' };
  }
  if (target.protocol !== base.protocol || target.host !== base.host) {
    return { ok: false, reason: `Only requests on ${base.host} are sent from here.` };
  }
  return { ok: true, url: target.toString() };
}

export function validateBody(body: string | undefined, method: string): UrlResult {
  if (method === 'GET' || method === 'DELETE') return { ok: true, url: '' };
  const text = (body ?? '').trim();
  if (!text) return { ok: true, url: '' };
  if (text.length > MAX_BODY_LENGTH) return { ok: false, reason: 'Request body is too large for the preview panel.' };
  try {
    JSON.parse(text);
    return { ok: true, url: '' };
  } catch {
    return { ok: false, reason: 'Request body is not valid JSON.' };
  }
}

/** Why the tester cannot send anything yet, phrased as a fact rather than a apology. */
export function apiDisabledReason(baseUrl: string | null): string | null {
  if (!baseUrl) return 'No local server is running, so there is nothing to request. Start the preview first.';
  return null;
}

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null; forEach?: (callback: (value: string, key: string) => void) => unknown };
  text: () => Promise<string>;
}>;

function failure(message: string, durationMs: number): ApiRequestResult {
  return {
    ok: false,
    status: null,
    statusText: '',
    durationMs,
    contentType: null,
    body: '',
    truncated: false,
    json: null,
    error: message
  };
}

function describeNetworkError(error: unknown, origin: string): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted/i.test(name) || /aborted/i.test(message)) return 'Request aborted.';
  if (name === 'TypeError' || /fetch/i.test(message)) {
    return `${origin} refused the request or did not answer it. The server may be down, the path may not exist, or it did not send a CORS header allowing this origin.`;
  }
  return message;
}

/**
 * Sends one request and reports exactly what came back. `fetchImpl`, `now` and
 * `abortSignal` are injected so the module stays pure enough to unit test and
 * the component owns cancellation.
 */
export async function sendApiRequest(
  draft: ApiRequestDraft,
  baseUrl: string,
  options: { fetchImpl?: FetchLike; now?: () => number; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ApiRequestResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return failure('This runtime has no fetch, so the request cannot be sent.', 0);

  const method = draft.method.toUpperCase();
  if (!isApiMethod(method)) return failure(`${method} is not a supported method in the preview panel.`, 0);

  const target = joinApiUrl(baseUrl, draft.path);
  if (target.ok === false) return failure(target.reason, 0);

  const bodyCheck = validateBody(draft.body, method);
  if (bodyCheck.ok === false) return failure(bodyCheck.reason, 0);

  const startedAt = (options.now ?? Date.now)();
  const hasBody = method !== 'GET' && !!draft.body?.trim();
  const init: Record<string, unknown> = {
    method,
    credentials: 'omit',
    headers: hasBody ? { 'Content-Type': 'application/json' } : {}
  };
  if (hasBody) init.body = draft.body!.trim();
  if (options.signal) init.signal = options.signal;

  let response;
  try {
    response = await fetchImpl(target.url, init);
  } catch (error) {
    return failure(describeNetworkError(error, new URL(target.url).origin), (options.now ?? Date.now)() - startedAt);
  }

  const contentType = response.headers.get('content-type');
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return failure(
      `${response.status} ${response.statusText} — the response body could not be read (${String(error)}).`,
      (options.now ?? Date.now)() - startedAt
    );
  }

  const truncated = text.length > MAX_RESPONSE_CHARS;
  const body = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;

  let json: unknown = null;
  if (body.trim()) {
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    durationMs: (options.now ?? Date.now)() - startedAt,
    contentType,
    body,
    truncated,
    json,
    error: null
  };
}

/** Pretty JSON when the server sent JSON, raw text otherwise. */
export function formatResponseBody(result: ApiRequestResult): string {
  if (result.json !== null && result.json !== undefined) {
    return JSON.stringify(result.json, null, 2);
  }
  return result.body;
}

export function describeStatus(result: ApiRequestResult): string {
  if (result.error) return result.error;
  const label = result.statusText ? `${result.status} ${result.statusText}` : String(result.status);
  return `${label} in ${result.durationMs} ms`;
}
