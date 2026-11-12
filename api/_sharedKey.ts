/**
 * ShadRox's own provider keys, read from the environment and nowhere else.
 * Nothing in the shipped product sells access to them: `ai/_access.ts` refuses
 * an unkeyed request unless the operator sets SHADROX_ALLOW_SHARED_KEY=1, and
 * that gate is what this file exists behind — it only ever serves the operator's
 * own testing of the shared path.
 *
 * Underscore prefix keeps this file out of the Vercel route table.
 */

export type SharedKeyProvider = 'gemini' | 'groq';

const SHARED_KEY_ENV: Record<SharedKeyProvider, readonly string[]> = {
  gemini: ['SHADROX_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  groq: ['SHADROX_GROQ_API_KEY', 'GROQ_API_KEY']
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
