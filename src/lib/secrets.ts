/**
 * The shapes a credential takes, and how to erase them from text.
 *
 * Anything a run echoes — a journal line, an external tool's result, an error
 * copied into chat — is written down somewhere it can be read later, sometimes
 * by a model the user did not configure. The keys are the user's own, and they
 * never belong in those copies, so every one of them passes through here before
 * it is stored or shown.
 *
 * This is a pattern list, not a secret scanner: it catches the formats providers
 * actually publish (a prefixed key, a bearer token, `name: value` where `name` is
 * a credential word) and leaves ordinary prose alone, because a redactor that
 * shreds real log lines gets switched off.
 */

/**
 * Provider key shapes. The prefixes are public and the tails are not, so a match
 * on the pair is confident enough to replace without a human deciding.
 */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bgsk_[A-Za-z0-9_-]{10,}/g,
  /\bxai-[A-Za-z0-9_-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  // A JWT is three base64 segments; the payload is readable text, which is worse.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g
];

/**
 * `api_key: "…"`, `token=…` — the name makes the value a credential.
 *
 * The value has to be long enough to be one: `token: 5` in a retry log is a
 * number, and a redactor that masks numbers trains the user to distrust the log.
 * `(?!\[redacted])` keeps a second pass over already-cleaned text from reading
 * its own marker as a secret, which would make `containsSecret` never settle.
 */
const ASSIGNED_SECRET =
  /\b(api[_ -]?key|apikey|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|passwd|secret|token)(["']?\s*[:=]\s*)(["']?)(?!\[redacted])([^\s"',;}\]]{8,})/gi;

/** `Authorization: Bearer …` */
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{10,})/gi;

const MARKER = '[redacted]';

/** Replaces anything that reads like a credential with a marker. */
export function redactSecrets(text: string): string {
  let redacted = text.replace(BEARER, (_all, scheme: string) => `${scheme}${MARKER}`);
  for (const shape of KEY_SHAPES) redacted = redacted.replace(shape, MARKER);
  return redacted.replace(ASSIGNED_SECRET, (_all, name: string, separator: string) => `${name}${separator}${MARKER}`);
}

/** True when a string still holds something shaped like a credential. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
