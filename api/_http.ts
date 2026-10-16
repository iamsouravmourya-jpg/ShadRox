import type { IncomingMessage, ServerResponse } from 'http';

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

export async function readJsonBody<T = Record<string, unknown>>(req: ApiRequest): Promise<T> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body) as T;
      } catch {
        return {} as T;
      }
    }
    return req.body as T;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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
  try {
    const data = await response.json();
    return (
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message ||
      `Request failed with status ${response.status}`
    );
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
