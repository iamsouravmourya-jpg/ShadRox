/**
 * Environment scrubbing — strips credential-shaped variables before an
 * approval-gated command is handed to the shell.
 *
 * Pattern sources (adapted, not copied verbatim):
 *  - OpenHands secret-detection heuristics (Apache-2.0)
 *  - ShadRox api/_http.ts REDACT_PATTERNS (proprietary, same codebase)
 *
 * Rules applied in order:
 *  1. Exact ShadRox-internal prefixes (SHADROX_).
 *  2. Provider key names for every supported provider.
 *  3. Shape-based suffix match: any var whose name ends with a credential
 *     keyword is stripped regardless of provider prefix.
 *  4. Shape-based value match: even if the name looks innocent, a value that
 *     looks like a known token format is stripped.
 */

/** Name-based patterns — matched against the env variable KEY (uppercased). */
const SENSITIVE_NAME_RE = new RegExp(
  [
    // ShadRox internals
    '^SHADROX_',
    // Explicit provider key names
    'GEMINI.*(?:API_KEY|KEY|SECRET|TOKEN)',
    'GROQ.*(?:API_KEY|KEY|SECRET|TOKEN)',
    'SUPABASE.*(?:API_KEY|KEY|SECRET|TOKEN|ANON)',
    'OPENAI.*(?:API_KEY|KEY|SECRET)',
    'ANTHROPIC.*(?:API_KEY|KEY|SECRET)',
    'GOOGLE.*(?:API_KEY|KEY|SECRET|TOKEN)',
    'AWS.*(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS|SESSION_TOKEN)',
    'GITHUB.*(?:TOKEN|PAT|SECRET)',
    'GH_TOKEN',
    // Generic credential suffixes — catches CUSTOM_API_KEY, MY_SECRET, etc.
    '(?:^|_)(?:API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|' +
      'SESSION_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|' +
      'CLIENT_SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$',
  ].join('|'),
  'i',
);

/** Value-based patterns — strip even innocuously named vars with cred-shaped values. */
const SENSITIVE_VALUE_RE = /^(?:ghp_|gho_|ghs_|ghu_|github_pat_)[0-9A-Za-z_]{16,}$|^(?:AKIA|ASIA)[0-9A-Z]{16}$|^AIza[0-9A-Za-z_-]{20,}$|^gsk_[0-9A-Za-z_-]{20,}$|^sk-[0-9A-Za-z_-]{20,}$/;

const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bAQ\.[0-9A-Za-z_-]{20,}\b/g,
  /\bgsk_[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[0-9A-Za-z._~+/-]{12,}={0,2}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi
];

const SECRET_ASSIGNMENT_RE =
  /\b((?:[A-Za-z0-9.-]*_)?(?:API[_-]?KEY|ACCESS[_-]?KEY(?:[_-]?ID)?|SECRET(?:[_-]?(?:ACCESS[_-]?)?KEY)?|(?:(?:AUTH|ACCESS|REFRESH)[_-]?)?TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?))\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]]+)/gi;

/** Removes provider-bound credentials from automatically included workspace text. */
export function scrubWorkspaceText(text: string): string {
  let scrubbed = text.replace(
    SECRET_ASSIGNMENT_RE,
    (_match, name: string, separator: string) => `${name}${separator}[REDACTED_SECRET]`
  );
  scrubbed = scrubbed.replace(/[?&](?:[A-Za-z0-9_-]*api[_-]?key|key|access[_-]?token)=([^&#\s]+)/gi, (_match, value: string) =>
    _match.replace(value, '[REDACTED_SECRET]')
  );
  for (const pattern of SECRET_TEXT_PATTERNS) scrubbed = scrubbed.replace(pattern, '[REDACTED_SECRET]');
  return scrubbed;
}

export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => {
      if (typeof value !== 'string') return false;
      if (SENSITIVE_NAME_RE.test(key)) return false;
      if (SENSITIVE_VALUE_RE.test(value.trim())) return false;
      return true;
    }),
  );
}

/** Exported for tests and any caller that needs to check a single pair. */
export function isSensitive(key: string, value: string): boolean {
  return SENSITIVE_NAME_RE.test(key) || SENSITIVE_VALUE_RE.test(value.trim());
}
