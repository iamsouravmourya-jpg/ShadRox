import { RequestRejectedError } from '../_validate.js';
import { streamCustomEndpoint } from './_compatible.js';
import { streamGemini } from './_gemini.js';
import { streamGroq } from './_openai.js';
import type { ProviderAdapter, ProviderId } from './_types.js';

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: { id: 'gemini', defaultModel: 'gemini-3.8-flash', stream: streamGemini },
  groq: { id: 'groq', defaultModel: 'openai/gpt-oss-120b', stream: streamGroq },
  // A custom endpoint has no default model: the id comes from the user's
  // listing or from the ids they typed in Settings.
  custom: { id: 'custom', defaultModel: '', stream: streamCustomEndpoint }
};

export const PROVIDER_IDS: ProviderId[] = ['gemini', 'groq', 'custom'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

/**
 * Reads `provider` from a request body.
 *
 * Absent means the historical default (Gemini, which every client used before
 * the field existed). Present-but-unknown is a hard 400 instead: silently
 * falling back used to send a Groq or custom-endpoint key to the Gemini
 * endpoint, which spends a real key against the wrong provider.
 */
export function parseProviderId(raw: Record<string, unknown>): ProviderId {
  if (raw.provider === undefined || raw.provider === null || raw.provider === '') return 'gemini';
  if (!isProviderId(raw.provider)) {
    throw new RequestRejectedError(
      400,
      `Unknown provider — choose one of: ${PROVIDER_IDS.join(', ')}.`,
      'UNKNOWN_PROVIDER'
    );
  }
  return raw.provider;
}

export interface KeyAccess {
  /** The key the request will spend. */
  apiKey: string;
  /** Always true: every request spends the caller's own key. */
  byok: boolean;
}

const BYOK_REQUIRED_ERROR =
  'ShadRox is BYOK-only — requests require your own API key. Add your Gemini, Groq, or custom endpoint key in Settings → BYOK.';

/**
 * Resolves the key a request may spend: the caller's own BYOK key, and nothing
 * else. Returns a user-facing error instead of a key when none was supplied.
 */
export function resolveKeyAccess(rawKey: string | undefined): { access: KeyAccess } | { error: string } {
  const apiKey = (rawKey || '').trim();
  if (!apiKey) return { error: BYOK_REQUIRED_ERROR };
  return { access: { apiKey, byok: true } };
}
