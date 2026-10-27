import { classifyTier } from '../../src/lib/providers.js';
import { sharedKeyFor } from '../_sharedKey.js';
import { streamGemini } from './_gemini.js';
import { streamGroq } from './_openai.js';
import type { ProviderAdapter, ProviderId } from './_types.js';

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: { id: 'gemini', defaultModel: 'gemini-3.8-flash', stream: streamGemini },
  groq: { id: 'groq', defaultModel: 'openai/gpt-oss-120b', stream: streamGroq }
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'gemini' || value === 'groq';
}

export interface KeyAccess {
  /** The key the request will spend. */
  apiKey: string;
  /** True when the user's own key pays for the call. */
  byok: boolean;
}

/**
 * Master switch for ShadRox's own key. The beta runs BYOK-only, so an unkeyed
 * request — including one hand-crafted in devtools — is refused before the
 * shared key is ever looked up. Re-enable with SHADROX_ALLOW_SHARED_KEY=1.
 */
export function sharedKeyPathEnabled(): boolean {
  return process.env.SHADROX_ALLOW_SHARED_KEY === '1';
}

const SHARED_KEY_OFF_ERROR =
  'ShadRox ka shared key abhi band hai — beta me sirf apni key chalti hai. Settings → BYOK me apni Gemini ya Groq key add karo.';

/**
 * Resolves which key a request may spend: the caller's BYOK key, or ShadRox's
 * shared key (opt-in only, Pro tier, never stored server-side beyond the
 * environment). Returns a user-facing error instead of a key when neither path
 * is allowed.
 */
export function resolveKeyAccess(
  provider: ProviderId,
  model: string,
  rawKey: string | undefined
): { access: KeyAccess } | { error: string } {
  const byokKey = (rawKey || '').trim();
  const sharedKey = byokKey || !sharedKeyPathEnabled() ? '' : sharedKeyFor(provider);
  const apiKey = byokKey || sharedKey;

  if (!apiKey) {
    return {
      error: sharedKeyPathEnabled()
        ? `Is provider (${provider}) ke liye ShadRox ki shared key set nahi hai. Settings → BYOK me apni key add karo.`
        : SHARED_KEY_OFF_ERROR
    };
  }

  if (!byokKey) {
    // The shared key belongs to ShadRox's paid plan, so it only serves the Pro
    // tier. The free list stays BYOK-only, which keeps the spend bounded.
    if (classifyTier(provider, model) !== 'pro') {
      return {
        error: `ShadRox ki shared key sirf Pro models par chalti hai, aur "${model}" free tier me hai. Free models ke liye Settings → BYOK me apni key add karo.`
      };
    }
    // TODO(phase-3): verify Supabase session + apply per-user rate limit before
    // spending the shared ShadRox key. See docs in README.
  }

  return { access: { apiKey, byok: Boolean(byokKey) } };
}
