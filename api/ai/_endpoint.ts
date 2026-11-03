import { RequestRejectedError } from '../_validate.js';

/**
 * Address rules for the BYOK "custom endpoint" provider, where the caller
 * supplies the base URL of an OpenAI-compatible server.
 *
 * Two deployments run this code and they need opposite policies:
 *
 * - The desktop app starts this server itself, bound to 127.0.0.1, so it is
 *   the user's own machine making a request to a server the user chose. Local
 *   model runners (Ollama, LM Studio, llama.cpp) are the point of the feature,
 *   and they live on private addresses by definition.
 * - The hosted deployment would otherwise be an open proxy: any client could
 *   make Vercel fetch an arbitrary URL, including cloud metadata services and
 *   whatever lives inside the provider's private network. There the allow-list
 *   has to be enforced by us instead.
 */

const MAX_URL_LENGTH = 512;

/**
 * True when this process is the desktop app's own loopback backend rather than
 * a hosted function. `startServer` sets the flag when it binds a loopback host.
 */
export function runsOnTheUsersMachine(): boolean {
  return process.env.SHADROX_LOCAL_BACKEND === '1';
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.io'
]);

/** IPv4 in the RFC1918, carrier-grade NAT, link-local, or "this host" ranges. */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // malformed: treat as blocked
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1') return true;
  if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true;
  // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 verdict.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isIpAddress(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

function isBlockedAddress(host: string): boolean {
  if (host.includes(':')) return isPrivateIPv6(host.replace(/^\[|\]$/g, ''));
  return isPrivateIPv4(host);
}

/**
 * Normalizes and vets a caller-supplied base URL. Returns the URL with no
 * trailing slash, ready for `/chat/completions` and `/models` to be appended.
 * Throws `RequestRejectedError` for anything unusable, with a message that
 * names the rule that failed so the user can fix the input.
 */
export function resolveCustomEndpoint(rawBaseUrl: unknown): string {
  const value = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : '';

  if (!value) {
    throw new RequestRejectedError(400, 'Custom endpoint ke liye base URL chahiye (for example https://openrouter.ai/api/v1).');
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new RequestRejectedError(413, `Base URL bahut bada hai — maximum ${MAX_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new RequestRejectedError(400, 'Base URL parse nahi ho paya. Poora URL daalo, jaise https://api.example.com/v1.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RequestRejectedError(400, 'Base URL http:// ya https:// hona chahiye.');
  }
  if (url.username || url.password) {
    throw new RequestRejectedError(400, 'Base URL me credentials daalne hain — API key alag field me bharo.');
  }
  if (url.search || url.hash) {
    throw new RequestRejectedError(400, 'Base URL me query string ya fragment nahi chalta. Sirf origin (aur path) chahiye.');
  }
  if (!url.hostname) {
    throw new RequestRejectedError(400, 'Base URL ka host missing hai.');
  }

  const host = url.hostname.toLowerCase();

  // Inside the desktop app — and inside `npm run dev`, which is the same code
  // run locally — this process is the user's own, listening on loopback, so
  // "private address" describes their machine, not our infrastructure.
  // Anything reachable by name is fair game there. `startServer` sets this flag
  // when it binds a loopback host; the Vercel functions never do, so the
  // deployment that is an open proxy by construction keeps the strict policy.
  if (runsOnTheUsersMachine()) {
    return stripTrailingSlash(url.toString());
  }

  if (url.protocol !== 'https:') {
    throw new RequestRejectedError(400, 'Hosted version sirf https:// endpoints par chalta hai. Local http endpoints (Ollama, LM Studio) desktop app me chalte hain.');
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new RequestRejectedError(400, 'Yeh host allowed nahi hai (internal hostname).');
  }
  if (isIpAddress(host) && isBlockedAddress(host)) {
    throw new RequestRejectedError(400, 'Yeh host allowed nahi hai (private ya loopback address). Desktop app me local models chala sakte ho.');
  }

  return stripTrailingSlash(url.toString());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
