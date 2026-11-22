import dns from 'node:dns/promises';
import net from 'node:net';
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
 *   and DNS-rebinding checks have to be enforced by us instead.
 */

const MAX_URL_LENGTH = 512;

export type DnsLookupFn = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * True when this process is the desktop app's own loopback backend rather than
 * a hosted function. `startServer` sets the flag when it binds a loopback host.
 */
export function runsOnTheUsersMachine(): boolean {
  return process.env.SHADROX_LOCAL_BACKEND === '1';
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.io'
]);

/** IPv4 in the RFC1918, carrier-grade NAT, link-local, multicast, or "this host" ranges. */
export function isPrivateIPv4(address: string): boolean {
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
  if (a >= 224) return true; // multicast & reserved
  return false;
}

/**
 * Parse an IPv6 address (with or without `::` compression and optional trailing
 * dotted IPv4) into eight 16-bit integer words. Returns null if malformed.
 */
function parseIPv6Words(rawAddress: string): number[] | null {
  const stripped = rawAddress.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!stripped) return null;

  const halves = stripped.split('::');
  if (halves.length > 2) return null;

  const parseSegmentList = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(':');
    const words: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const octets = token.split('.').map((part) => Number(part));
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        words.push(Number.parseInt(token, 16));
      }
    }
    return words;
  };

  const head = parseSegmentList(halves[0]);
  if (!head) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseSegmentList(halves[1]);
  if (!tail) return null;
  const missing = 8 - (head.length + tail.length);
  if (missing < 1) return null;

  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function wordsToIPv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

export function isPrivateIPv6(address: string): boolean {
  const words = parseIPv6Words(address);
  if (!words) return true; // malformed IPv6: fail closed

  const allZero = words.every((w) => w === 0);
  if (allZero) return true; // :: unspecified

  const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
  if (isLoopback) return true; // ::1

  // IPv4-mapped IPv6 (::ffff:w.x.y.z or ::ffff:hhll:hhll)
  const isV4Mapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;
  if (isV4Mapped) {
    return isPrivateIPv4(wordsToIPv4(words[6], words[7]));
  }

  // IPv4-compatible IPv6 (::w.x.y.z)
  const isV4Compat = words.slice(0, 6).every((w) => w === 0);
  if (isV4Compat) {
    return isPrivateIPv4(wordsToIPv4(words[6], words[7]));
  }

  // 64:ff9b::/96 NAT64 well-known prefix
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) {
    return isPrivateIPv4(wordsToIPv4(words[6], words[7]));
  }

  const first = words[0];
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // 2001:db8::/32 documentation

  return false;
}

function isIpAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return net.isIP(bare) !== 0 || /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':');
}

export function isBlockedAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare.includes(':')) return isPrivateIPv6(bare);
  return isPrivateIPv4(bare);
}

function isBlockedHostname(host: string): boolean {
  return (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

/**
 * Normalizes and vets a caller-supplied base URL, including DNS-rebinding SSRF
 * verification in hosted deployments (`!runsOnTheUsersMachine()`). Returns the
 * URL with no trailing slash, ready for `/chat/completions` and `/models`.
 * Throws `RequestRejectedError` with a structured error code for anything unsafe.
 */
export async function resolveCustomEndpoint(
  rawBaseUrl: unknown,
  lookupFn: DnsLookupFn = (hostname, options) => dns.lookup(hostname, options)
): Promise<string> {
  const value = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : '';

  if (!value) {
    throw new RequestRejectedError(
      400,
      'A base URL is required for custom endpoints (for example https://openrouter.ai/api/v1).',
      'ENDPOINT_URL_REQUIRED'
    );
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new RequestRejectedError(
      413,
      `Base URL is too large — maximum ${MAX_URL_LENGTH} characters allowed.`,
      'ENDPOINT_URL_TOO_LARGE'
    );
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new RequestRejectedError(
      400,
      'Could not parse the base URL. Enter a full URL such as https://api.example.com/v1.',
      'ENDPOINT_URL_INVALID'
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RequestRejectedError(
      400,
      'Base URL must use http:// or https://.',
      'ENDPOINT_INVALID_PROTOCOL'
    );
  }
  if (url.username || url.password) {
    throw new RequestRejectedError(
      400,
      'Do not include credentials in the base URL — enter the API key in its own field.',
      'ENDPOINT_CREDENTIALS_FORBIDDEN'
    );
  }
  if (url.search || url.hash) {
    throw new RequestRejectedError(
      400,
      'Base URL cannot contain a query string or fragment. Provide only the origin and base path.',
      'ENDPOINT_QUERY_OR_HASH_FORBIDDEN'
    );
  }
  if (!url.hostname) {
    throw new RequestRejectedError(400, 'Base URL hostname is missing.', 'ENDPOINT_HOST_MISSING');
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
    throw new RequestRejectedError(
      400,
      'The hosted deployment only allows https:// custom endpoints. Use the desktop app for local http:// runners such as Ollama or LM Studio.',
      'ENDPOINT_HTTPS_REQUIRED'
    );
  }
  if (isBlockedHostname(host)) {
    throw new RequestRejectedError(
      400,
      'This hostname is not allowed on the hosted deployment.',
      'ENDPOINT_HOST_BLOCKED'
    );
  }
  if (isIpAddress(host)) {
    if (isBlockedAddress(host)) {
      throw new RequestRejectedError(
        400,
        'Private, link-local, and loopback IP addresses are not allowed on the hosted deployment. Use the desktop app for local models.',
        'ENDPOINT_SSRF_BLOCKED'
      );
    }
    return stripTrailingSlash(url.toString());
  }

  // DNS-rebinding defense (SEC-02): resolve all A/AAAA records for the hostname
  // and verify every returned IP address against isBlockedAddress.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(host, { all: true });
  } catch {
    throw new RequestRejectedError(
      400,
      'Custom endpoint hostname could not be resolved.',
      'ENDPOINT_DNS_FAILED'
    );
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new RequestRejectedError(
      400,
      'Custom endpoint hostname did not resolve to any IP address.',
      'ENDPOINT_DNS_FAILED'
    );
  }

  for (const record of records) {
    if (!record?.address || isBlockedAddress(record.address)) {
      throw new RequestRejectedError(
        400,
        'This custom endpoint resolves to a private, link-local, or loopback network address and is blocked on the hosted deployment.',
        'ENDPOINT_SSRF_BLOCKED'
      );
    }
  }

  return stripTrailingSlash(url.toString());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
