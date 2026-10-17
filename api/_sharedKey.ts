/**
 * The shared ShadRox key lives only in the environment. It belongs to ShadRox's
 * paid plan, so every caller is expected to restrict it to Pro-tier models.
 *
 * Underscore prefix keeps this file out of the Vercel route table.
 */

export type SharedKeyProvider = 'gemini' | 'groq';

const SHARED_KEY_ENV: Record<SharedKeyProvider, readonly string[]> = {
  gemini: ['SHADROX_GEMINI_API_KEY', 'DEVORA_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  groq: ['SHADROX_GROQ_API_KEY', 'DEVORA_GROQ_API_KEY', 'GROQ_API_KEY']
};

/** First non-empty shared key for this provider, or '' when none is set. */
export function sharedKeyFor(provider: SharedKeyProvider): string {
  for (const name of SHARED_KEY_ENV[provider]) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

/** Providers that currently have a shared key configured, most useful first. */
export function sharedKeyProviders(): SharedKeyProvider[] {
  return (['groq', 'gemini'] as SharedKeyProvider[]).filter((provider) => Boolean(sharedKeyFor(provider)));
}
