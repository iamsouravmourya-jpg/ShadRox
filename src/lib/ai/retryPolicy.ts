/**
 * Error classification for the AI request path, ported from aider's
 * `aider/exceptions.py` (the `EXCEPTIONS` table and
 * `LiteLLMExceptions.get_ex_info`), Copyright (c) Aider LLC, https://aider.chat,
 * used under the Apache License, Version 2.0:
 *
 *   https://github.com/Aider-AI/aider/blob/main/LICENSE
 *
 * Aider's human-readable `ExInfo.description` strings are carried verbatim so
 * the wording users saw in aider survives the port. The special cases aider
 * special-cases for OpenRouter and insufficient-credits responses (see
 * `LiteLLMExceptions.get_ex_info` in aider/exceptions.py) are ported 1:1
 * because ShadRox talks to exactly those API shapes (Gemini, Groq, and any
 * OpenAI-compatible endpoint via the `custom` provider). Bedrock/boto3 and
 * litellm-router-only classes are dropped as not applicable to this stack.
 *
 * ShadRox adaptations (NOT from aider, marked ADAPTATION below): the transport
 * here is `fetch`, not the litellm Python client, so failures arrive as HTTP
 * status codes and sanitised message strings rather than typed exception
 * classes. `classifyFailure` maps both back onto aider's ExInfo table.
 */

export interface ExInfo {
  name: string;
  retry: boolean;
  description: string | null;
}

/**
 * Ported 1:1 from aider/exceptions.py `EXCEPTIONS` (name, retry, description),
 * keeping only the entries that can occur for Gemini / Groq / OpenAI-compatible
 * providers. Dropped as inapplicable: `AzureOpenAIError`, `OpenAIError`,
 * `RouterRateLimitError`, `JSONSchemaValidationError` (litellm/Azure-only).
 */
const ex = (name: string, retry: boolean, description: string | null): ExInfo => ({
  name,
  retry,
  description
});

export const EXCEPTION_INFO: Record<string, ExInfo> = {
  APIConnectionError: ex('APIConnectionError', true, null),
  APIError: ex('APIError', true, null),
  APIResponseValidationError: ex('APIResponseValidationError', true, null),
  AuthenticationError: ex(
    'AuthenticationError',
    false,
    'The API provider is not able to authenticate you. Check your API key.'
  ),
  BadGatewayError: ex(
    'BadGatewayError',
    true,
    "The API provider's servers are down or overloaded."
  ),
  BadRequestError: ex('BadRequestError', false, null),
  BudgetExceededError: ex('BudgetExceededError', true, null),
  ContentPolicyViolationError: ex(
    'ContentPolicyViolationError',
    true,
    'The API provider has refused the request due to a safety policy about the content.'
  ),
  ContextWindowExceededError: ex('ContextWindowExceededError', false, null),
  ImageFetchError: ex(
    'ImageFetchError',
    false,
    'The API provider was unable to fetch one or more images.'
  ),
  InternalServerError: ex(
    'InternalServerError',
    true,
    "The API provider's servers are down or overloaded."
  ),
  InvalidRequestError: ex('InvalidRequestError', true, null),
  NotFoundError: ex('NotFoundError', false, null),
  PermissionDeniedError: ex(
    'PermissionDeniedError',
    false,
    'Permission was denied. Check your API key and/or credentials.'
  ),
  RateLimitError: ex(
    'RateLimitError',
    true,
    'The API provider has rate limited you. Try again later or check your quotas.'
  ),
  ServiceUnavailableError: ex(
    'ServiceUnavailableError',
    true,
    "The API provider's servers are down or overloaded."
  ),
  UnprocessableEntityError: ex('UnprocessableEntityError', true, null),
  UnsupportedParamsError: ex('UnsupportedParamsError', true, null),
  Timeout: ex(
    'Timeout',
    true,
    'The API provider timed out without returning a response. They may be down or overloaded.'
  )
};

/** Aider's default for an unrecognised exception: `ExInfo(None, None, None)`. */
export const UNKNOWN_EXINFO: ExInfo = ex('UnknownError', false, null);

/**
 * ADAPTATION (ShadRox): maps HTTP status codes onto the litellm classes aider's
 * table was written for, so the same retry discipline applies over fetch.
 */
const STATUS_CLASSES: Record<number, string> = {
  400: 'BadRequestError',
  401: 'AuthenticationError',
  402: 'APIError', // insufficient credits is special-cased via the message below
  403: 'PermissionDeniedError',
  404: 'NotFoundError',
  408: 'Timeout',
  409: 'BadRequestError',
  413: 'BadRequestError',
  422: 'UnprocessableEntityError',
  429: 'RateLimitError',
  500: 'InternalServerError',
  502: 'BadGatewayError',
  503: 'ServiceUnavailableError',
  504: 'Timeout'
};

type MessageMatcher = { test: (message: string) => boolean; name: string };

/**
 * Ported from `LiteLLMExceptions.get_ex_info` (aider/exceptions.py): the two
 * provider quirks aider inspects inside generic errors, first, so they win over
 * the generic status/message buckets. The boto3 special case is dropped (no
 * Bedrock in this stack).
 */
const SPECIAL_CASES: MessageMatcher[] = [
  {
    // aider: OpenRouterException with a missing 'choices' key is really an
    // upstream outage / rate-limit wearing a connection-error mask.
    test: (m) => /openrouterexception/i.test(m) && m.includes("'choices'"),
    name: 'APIConnectionError'
  },
  {
    // aider: `insufficient credits` + `"code":402` is deterministic, never retry.
    test: (m) => /insufficient credits/i.test(m) && /(?:^|[^0-9])402(?:[^0-9]|$)/.test(m),
    name: 'InsufficientCredits'
  }
];

/** Aider messages carry human text for these special cases not in the table. */
const SPECIAL_DESCRIPTIONS: Record<string, string> = {
  APIConnectionError:
    'OpenRouter or the upstream API provider is down, overloaded or rate limiting your requests.',
  InsufficientCredits: 'Insufficient credits with the API provider. Please add credits.'
};

const SPECIAL_RETRY: Record<string, boolean> = {
  APIConnectionError: true,
  InsufficientCredits: false
};

/**
 * ADAPTATION (ShadRox): the server route sanitises provider errors into
 * human text (see api/ai/chat.ts `errorMessage`), so retryability for SSE
 * `error` events is re-derived from the message, mirroring aider's classes.
 * Order matters: non-retryable auth-ish text must not be swallowed by the
 * broader connection bucket ("...check your API key and try again").
 */
const MESSAGE_CLASSES: MessageMatcher[] = [
  { test: (m) => /insufficient credits|not able to authenticate|unauthoriz|invalid api key|incorrect api key|api key.*(missing|invalid|expired)|expired.*key/i.test(m), name: 'AuthenticationError' },
  { test: (m) => /permission denied|forbidden/i.test(m), name: 'PermissionDeniedError' },
  { test: (m) => /context window|too many tokens|prompt is too long|maximum context/i.test(m), name: 'ContextWindowExceededError' },
  { test: (m) => /rate.?limit|too many requests|quota/i.test(m), name: 'RateLimitError' },
  { test: (m) => /timed? ?out|timeout|went silent/i.test(m), name: 'Timeout' },
  { test: (m) => /bad gateway|\b502\b/i.test(m), name: 'BadGatewayError' },
  { test: (m) => /service unavailable|\b503\b/i.test(m), name: 'ServiceUnavailableError' },
  { test: (m) => /gateway timeout|\b504\b|internal server error|\b500\b|overloaded|servers are down/i.test(m), name: 'InternalServerError' },
  { test: (m) => /content policy|safety policy/i.test(m), name: 'ContentPolicyViolationError' },
  { test: (m) => /could not reach|could not connect|connection|network|fetch failed|econn|enotfound|dns/i.test(m), name: 'APIConnectionError' }
];

function exInfoFor(name: string, special: boolean): ExInfo {
  if (special) {
    return {
      name,
      retry: SPECIAL_RETRY[name] ?? false,
      description: SPECIAL_DESCRIPTIONS[name] ?? null
    };
  }
  return EXCEPTION_INFO[name] ?? UNKNOWN_EXINFO;
}

/**
 * Port of the classifier half of aider's `LiteLLMExceptions.get_ex_info`,
 * driven by message text instead of Python exception instances. Returns
 * UNKNOWN_EXINFO (retry = false) when nothing matches — aider's conservative
 * default: never retry what we cannot name.
 */
export function classifyMessage(message: string): ExInfo {
  for (const matcher of SPECIAL_CASES) {
    if (matcher.test(message)) {
      // The OpenRouter quirk is an APIConnectionError; the credits case has
      // its own pseudo-class name.
      return matcher.name === 'APIConnectionError'
        ? exInfoFor('APIConnectionError', true)
        : exInfoFor('InsufficientCredits', true);
    }
  }
  for (const matcher of MESSAGE_CLASSES) {
    if (matcher.test(message)) return exInfoFor(matcher.name, false);
  }
  return UNKNOWN_EXINFO;
}

/** ADAPTATION: HTTP status -> ExInfo via aider's class table. */
export function classifyStatus(status: number): ExInfo {
  const name = STATUS_CLASSES[status];
  if (name) return exInfoFor(name, false);
  if (status >= 500) return exInfoFor('InternalServerError', false);
  return UNKNOWN_EXINFO;
}

/**
 * The single entry point used by the request path: a failed response or a
 * sanitised SSE error message becomes an aider ExInfo. Special-case message
 * inspection runs first (aider order), then the HTTP status bucket, then the
 * message-text bucket. Unknown stays non-retryable.
 */
export function classifyFailure(status: number | null | undefined, message?: string): ExInfo {
  const text = message?.trim();
  if (text) {
    for (const matcher of SPECIAL_CASES) {
      if (matcher.test(text)) {
        return matcher.name === 'APIConnectionError'
          ? exInfoFor('APIConnectionError', true)
          : exInfoFor('InsufficientCredits', true);
      }
    }
    // A status code outranks prose: a 401 with the word "connection" in the
    // body must not be promoted into the retryable APIConnectionError bucket.
    if (status != null && status !== 200 && STATUS_CLASSES[status]) {
      return classifyStatus(status);
    }
    const byMessage = classifyMessage(text);
    if (byMessage !== UNKNOWN_EXINFO) return byMessage;
    if (status != null && status !== 200) return classifyStatus(status);
    return byMessage;
  }
  if (status != null && status !== 200) return classifyStatus(status);
  return UNKNOWN_EXINFO;
}

/**
 * ADAPTATION (ShadRox): respect the provider/operator's explicit rate-limit
 * header. litellm honours `Retry-After` the same way; the parse lives here
 * because over fetch we see the raw header value. Accepts delta-seconds and
 * HTTP-date forms, clamped to [0, 3600]; returns null when absent/unparseable.
 */
export function parseRetryAfterSeconds(
  headerValue: string | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), 3600);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(Math.round((at - nowMs) / 1000), 0), 3600);
}
