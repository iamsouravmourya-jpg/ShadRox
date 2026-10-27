const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, Math.round(seconds * 1_000));
  return Math.min(800, 250 * (attempt + 1) + Math.round(Math.random() * 100));
}

/**
 * Fetch wrapper for upstream model providers. Retries only before the response
 * body is consumed, so a stream that already started is never replayed.
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  attempts = 2
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal });
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (!retryable || attempt === attempts - 1) return response;

      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelayMs(response, attempt), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      await wait(retryDelayMs(null, attempt), signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Upstream provider request failed.');
}
