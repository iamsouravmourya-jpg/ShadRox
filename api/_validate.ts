/**
 * Boundary validation for every api/** route.
 *
 * The rule this file exists to enforce: a request that can spend an API key
 * must declare, up front, the largest body / array / string / number it will
 * accept. Scattered `if (x.length > n)` checks drift and get forgotten, so the
 * limits live here as single-sourced constants and the routes read their input
 * through the helpers below.
 *
 * Status codes: oversized input (raw bytes, array length, per-element length)
 * is 413; malformed or out-of-range input is 400.
 */

/** Raised for input we reject on purpose; `_http.sendIfRejected` turns it into a response. */
export class RequestRejectedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestRejectedError';
    this.status = status;
  }
}

/** Raw JSON body caps, per route. Deliberately far below Express' global 20mb cap. */
export const BODY_LIMITS = {
  chat: 1_600_000,
  fim: 240_000,
  commitMessage: 240_000,
  refine: 64_000,
  byokValidate: 16_000,
  githubSmall: 16_000,
  githubPush: 3_000_000
} as const;

/** Per-field caps. Sized for real editor payloads, not for a denial-of-service. */
export const FIELD_LIMITS = {
  chatMessages: 120,
  chatMessageChars: 60_000,
  /** Pre-budget cap; the per-model budget in `ai/_budget.ts` trims this further. */
  systemInstructionChars: 200_000,
  resumePrefixChars: 60_000,
  modelChars: 120,
  /** A provider key is <100 chars; anything longer is not a key. */
  apiKeyChars: 512,
  temperature: { min: 0, max: 2, fallback: 0.7 },
  fimContextChars: 20_000,
  languageChars: 40,
  commitStatusChars: 4_000,
  commitDiffChars: 60_000,
  commitLogChars: 2_000,
  refinePromptChars: 8_000,
  refineContextChars: 4_000,
  repoNameChars: 100,
  repoDescriptionChars: 500,
  pushFiles: 60,
  pushFileNameChars: 300,
  pushFileContentChars: 100_000,
  pushCommitMessageChars: 500
} as const;

type Raw = Record<string, unknown>;

/** Optional string field, trimmed, with a hard per-element cap. */
export function optionalString(raw: Raw, key: string, maxChars: number): string {
  const value = raw[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new RequestRejectedError(400, `\`${key}\` string hona chahiye.`);
  }
  if (value.length > maxChars) {
    throw new RequestRejectedError(
      413,
      `\`${key}\` bahut bada hai — maximum ${maxChars} characters allowed hai.`
    );
  }
  return value;
}

export function requiredString(raw: Raw, key: string, maxChars: number, message: string): string {
  const value = optionalString(raw, key, maxChars).trim();
  if (!value) throw new RequestRejectedError(400, message);
  return value;
}

/** Optional key field: trimmed, capped, and `undefined` when absent. */
export function optionalKey(raw: Raw, key = 'apiKey'): string | undefined {
  const value = optionalString(raw, key, FIELD_LIMITS.apiKeyChars).trim();
  return value || undefined;
}

/** Number field clamped into [min, max]; a non-number falls back to the default. */
export function clampedNumber(
  raw: Raw,
  key: string,
  range: { min: number; max: number; fallback: number }
): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.fallback;
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

/** Enum field: unknown values collapse to the default instead of reaching upstream. */
export function enumValue<T extends string>(raw: Raw, key: string, values: readonly T[], fallback: T): T {
  const value = raw[key];
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export interface ChatMessageInputShape {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const CHAT_ROLES = ['user', 'assistant', 'system'] as const;

/**
 * Chat history is the one array a caller fully controls, so both its length and
 * every element are capped here: unbounded history must not smuggle text into a
 * request that spends the shared key.
 */
export function chatMessages(raw: Raw, key = 'messages'): ChatMessageInputShape[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RequestRejectedError(400, `\`${key}\` array hona chahiye.`);
  }
  if (value.length > FIELD_LIMITS.chatMessages) {
    throw new RequestRejectedError(
      413,
      `History me maximum ${FIELD_LIMITS.chatMessages} messages bhej sakte ho.`
    );
  }

  return value
    .filter((entry): entry is { role?: unknown; content?: unknown } =>
      Boolean(entry && typeof entry === 'object')
    )
    .map((entry) => {
      const role = entry.role;
      const content = entry.content;
      if (typeof content !== 'string') return null;
      if (content.length > FIELD_LIMITS.chatMessageChars) {
        throw new RequestRejectedError(
          413,
          `Ek message bahut bada hai — maximum ${FIELD_LIMITS.chatMessageChars} characters.`
        );
      }
      if (!CHAT_ROLES.includes(role as (typeof CHAT_ROLES)[number])) return null;
      return { role: role as ChatMessageInputShape['role'], content };
    })
    .filter((entry): entry is ChatMessageInputShape => entry !== null);
}

export interface PushFile {
  name: string;
  content: string;
}

/** Bounded `{ name, content }` file list for the GitHub push route. */
export function pushFiles(raw: Raw, key = 'files'): PushFile[] {
  const value = raw[key];
  if (!Array.isArray(value)) {
    throw new RequestRejectedError(400, `\`${key}\` array hona chahiye.`);
  }
  if (value.length > FIELD_LIMITS.pushFiles) {
    throw new RequestRejectedError(
      413,
      `Ek push me maximum ${FIELD_LIMITS.pushFiles} files bhej sakte ho.`
    );
  }

  return value.map((entry) => {
    const file = entry as { name?: unknown; content?: unknown };
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!name || name.length > FIELD_LIMITS.pushFileNameChars) {
      throw new RequestRejectedError(400, 'File ka naam required hai (max 300 characters).');
    }
    // The name is interpolated into the GitHub contents path, so absolute and
    // parent-traversing names are refused rather than sanitised.
    if (name.startsWith('/') || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new RequestRejectedError(400, `File ka naam \`${name.slice(0, 40)}\` valid path nahi hai.`);
    }
    if (content.length > FIELD_LIMITS.pushFileContentChars) {
      throw new RequestRejectedError(
        413,
        `File \`${name.slice(0, 60)}\` bahut badi hai — maximum ${FIELD_LIMITS.pushFileContentChars} characters.`
      );
    }
    return { name, content };
  });
}

/** Per-provider key map, validated element by element. */
export function keyByProvider(raw: Raw, providers: readonly string[]): Record<string, string> {
  const value = raw.apiKeyByProvider;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const provider of providers) {
    const entry = (value as Record<string, unknown>)[provider];
    // `{ gemini: undefined }` is what `JSON.stringify` sends for a provider the
    // user has no key for, so a missing entry is simply "no key".
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string') {
      throw new RequestRejectedError(400, `\`apiKeyByProvider.${provider}\` string hona chahiye.`);
    }
    if (entry.length > FIELD_LIMITS.apiKeyChars) {
      throw new RequestRejectedError(413, `API key bahut badi hai (max ${FIELD_LIMITS.apiKeyChars}).`);
    }
    const trimmed = entry.trim();
    if (trimmed) out[provider] = trimmed;
  }
  return out;
}

/** Nested object read with a depth guard, e.g. `{ resume: { prefix } }`. */
export function nestedString(raw: Raw, key: string, innerKey: string, maxChars: number): string {
  const value = raw[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return optionalString(value as Raw, innerKey, maxChars);
}
