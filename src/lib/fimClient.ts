/**
 * Client side of tab completion: LRU-cached fetch of /api/ai/fim.
 * Kept separate from the CodeMirror extension so the cache can be tested.
 */

export interface FimRequestContext {
  provider: string;
  model: string;
  apiKey?: string;
  language?: string;
}

export interface FimResult {
  text: string;
  tokens: number;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, FimResult>();
const inFlight = new Map<string, Promise<FimResult>>();

function cacheKey(context: FimRequestContext, prefix: string, suffix: string): string {
  return `${context.model}|${prefix.slice(-1200)}|${suffix.slice(0, 400)}`;
}

function remember(key: string, value: FimResult): FimResult {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

export function clearFimCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Requests a completion, reusing an identical request that is already running
 * and serving recent hits straight from memory. A dropped request resolves to
 * an empty completion instead of throwing, so the editor never shows an error.
 */
export async function requestFimCompletion(
  context: FimRequestContext,
  prefix: string,
  suffix: string,
  signal?: AbortSignal
): Promise<FimResult> {
  const key = cacheKey(context, prefix, suffix);
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const call: Promise<FimResult> = (async () => {
    try {
      const response = await fetch('/api/ai/fim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          provider: context.provider,
          model: context.model,
          apiKey: context.apiKey,
          language: context.language,
          prefix,
          suffix
        })
      });
      if (!response.ok) return remember(key, { text: '', tokens: 0 });
      const data = await response.json();
      const text = typeof data?.text === 'string' ? data.text : '';
      return remember(key, { text, tokens: typeof data?.tokens === 'number' ? data.tokens : 0 });
    } catch {
      return { text: '', tokens: 0 };
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, call);
  return call;
}
