import type { IncomingMessage, ServerResponse } from 'http';
import { RequestRejectedError } from './_validate.js';

/**
 * These handlers only use plain Node request/response APIs, so the exact same
 * file works as an Express route (local `npm run dev`) and as a Vercel
 * serverless function (production). No duplicate logic, no @vercel/node types.
 */
export interface ApiRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, unknown>;
}

export type ApiResponse = ServerResponse;

export interface BodyOptions {
  /**
   * Hard ceiling for the raw request body. `server.ts` caps Express at 20mb for
   * every route, but Vercel does not apply a per-function body cap for our
   * routes, so each handler declares its own (much smaller) limit.
   */
  maxBytes?: number;
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: ApiRequest,
  options: BodyOptions = {}
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (req.body !== undefined && req.body !== null) {
    // Express already parsed the body, so the only size signal left is the
    // declared content length. Refuse before any key is spent.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RequestRejectedError(413, bodyTooLargeMessage(maxBytes));
    }
    if (typeof req.body === 'string') {
      if (req.body.length > maxBytes) {
        throw new RequestRejectedError(413, bodyTooLargeMessage(maxBytes));
      }
      try {
        return JSON.parse(req.body) as T;
      } catch {
        return {} as T;
      }
    }
    return req.body as T;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += Buffer.byteLength(chunk as Buffer);
    if (received > maxBytes) {
      // Stop reading: an oversized body must never reach a route that spends a key.
      (req as ApiRequest & { destroy?: () => void }).destroy?.();
      throw new RequestRejectedError(413, bodyTooLargeMessage(maxBytes));
    }
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function bodyTooLargeMessage(maxBytes: number): string {
  return `Request body bahut bada hai — maximum ${Math.max(1, Math.round(maxBytes / 1024))}KB allowed hai.`;
}

/** Longest upstream/provider message we are willing to echo to the client. */
export const MAX_ERROR_MESSAGE_CHARS = 300;

/**
 * Provider and fetch errors are echoed straight back to the renderer, and an
 * upstream message can quote part of the request URL — which historically
 * carried the API key in a `?key=` query string. Anything that looks like a
 * credential, a URL or an Authorization header is redacted, then the text is
 * capped so a giant HTML error page cannot be forwarded verbatim.
 */
const REDACT_PATTERNS: RegExp[] = [
  /x-goog-api-key\s*[:=]\s*[^\s"',}]+/gi,
  /\bauthorization\s*[:=]\s*bearer\s+[^\s"',}]+/gi,
  // `key=`/`apiKey=` style query pairs, with or without a trailing delimiter.
  /\b[a-z0-9_-]*api[_-]?key\s*[:=]\s*[^\s"',}&]+/gi,
  /\bkey\s*=\s*[^\s"',}&]+/gi,
  /\bAIza[0-9A-Za-z_-]{4,}/g,
  /\bgsk_[0-9A-Za-z_-]{4,}/g,
  /\bsk-[0-9A-Za-z_-]{4,}/g,
  /\bbearer\s+[0-9A-Za-z._-]{8,}/gi,
  // Never describe the outgoing request line — it is where the key lives.
  /\bhttps?:\/\/\S+/gi
];

export function sanitizeErrorMessage(raw: unknown, fallback = 'Request failed.'): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text.trim()) return fallback;

  let scrubbed = text.replace(/\s+/g, ' ').trim();
  for (const pattern of REDACT_PATTERNS) scrubbed = scrubbed.replace(pattern, '[redacted]');
  scrubbed = scrubbed.replace(/\s+/g, ' ').trim();

  if (!scrubbed || /^(\[redacted\]\s*)+$/.test(scrubbed)) return fallback;
  return scrubbed.length > MAX_ERROR_MESSAGE_CHARS
    ? `${scrubbed.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : scrubbed;
}

/**
 * A route-level guard: sends the user-facing response for a rejection we
 * raised deliberately (413 body too large, 400 bad field) and returns true.
 * Anything else is rethrown so `server.ts` keeps its 500 behaviour.
 */
export function sendIfRejected(res: ApiResponse, error: unknown): boolean {
  if (error instanceof RequestRejectedError) {
    sendError(res, error.status, error.message);
    return true;
  }
  return false;
}

export function sendJson(res: ApiResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function sendError(res: ApiResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function sendSseHeaders(res: ApiResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const flushable = res as ApiResponse & { flushHeaders?: () => void };
  flushable.flushHeaders?.();
}

export function sseSend(res: ApiResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sseEnd(res: ApiResponse): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function readErrorPayload(response: Response): Promise<string> {
  const fallback = `Request failed with status ${response.status}`;
  try {
    const data = await response.json();
    return sanitizeErrorMessage(
      (data as { error?: { message?: string } })?.error?.message ||
        (data as { message?: string })?.message ||
        fallback,
      fallback
    );
  } catch {
    return fallback;
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
