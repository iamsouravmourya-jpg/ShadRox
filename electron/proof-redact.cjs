'use strict';

/**
 * The proof ledger is append-only and signed, so anything written into it is
 * permanent. A command line is the one field most likely to carry a live secret
 * (`export OPENAI_API_KEY=...`, `curl -H "Authorization: Bearer ..."`), so it is
 * redacted before it is signed rather than afterwards.
 */

const MASK = '[redacted]';

/** `NAME=value` where NAME looks like a credential. */
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|COOKIE|SESSION)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

/** Flags whose next whitespace-separated word is the secret. */
const SECRET_FLAG = /(^|\s)(--?(?:password|passwd|pass|token|secret|api-key|apikey|auth|access-token|client-secret))(\s+|=)("[^"]*"|'[^']*'|\S+)/gi;

/** `Authorization: Bearer xyz`, `X-Api-Key: xyz` and friends, quoted or not. */
const AUTH_HEADER = /(authorization|x-api-key|api-key|proxy-authorization)\s*:\s*(?:bearer|basic|token)?\s*[^\s"']+/gi;

/** Credentials embedded in a URL: scheme://user:pass@host */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/** Provider-shaped keys that can appear bare, with no NAME= prefix. */
const BARE_KEY = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abpsr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{8,})\b/g;

function redactCommandForProof(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  // Order matters: strip URL userinfo and header payloads before the generic
  // NAME=value rule can chew a header into an unreadable shape.
  text = text.replace(URL_USERINFO, `$1${MASK}@`);
  text = text.replace(AUTH_HEADER, (match, header) => `${header}: ${MASK}`);
  text = text.replace(ASSIGNMENT, (_match, name) => `${name}=${MASK}`);
  text = text.replace(SECRET_FLAG, (match, lead, flag, separator) => `${lead}${flag}${separator}${MASK}`);
  text = text.replace(BARE_KEY, MASK);
  return text;
}

/** Short, human-readable identity for a command that must stay readable. */
function commandSummary(value) {
  const first = redactCommandForProof(value).trim().split(/\s+/).slice(0, 3).join(' ');
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

module.exports = { redactCommandForProof, commandSummary, MASK };
