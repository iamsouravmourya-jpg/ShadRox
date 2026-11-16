/**
 * In-app feedback delivery.
 *
 * The destination is the owner's Google Apps Script web app, configured at
 * build time via SHADROX_FEEDBACK_WEBHOOK and baked into the bundle obfuscated.
 * There is no user setup, no ShadRox backend, and no database in this path:
 * only the message and its kind travel, and Google stamps the date.
 */

import { decodeWebhook } from './webhook-codec';

export type FeedbackKind = 'bug' | 'feature';

declare const __FEEDBACK_WEBHOOK_ENC__: string;

const REQUEST_TIMEOUT_MS = 15000;
const MIN_MESSAGE_LENGTH = 3;
const MAX_MESSAGE_LENGTH = 4000;

/** Resolved once at module load; the build injects only the encoded form. */
const FEEDBACK_ENDPOINT: string = (() => {
  const encoded = typeof __FEEDBACK_WEBHOOK_ENC__ === 'undefined' ? '' : __FEEDBACK_WEBHOOK_ENC__;
  if (!encoded) return '';
  try {
    return decodeWebhook(encoded).trim();
  } catch {
    return '';
  }
})();

export function isFeedbackConfigured(): boolean {
  return FEEDBACK_ENDPOINT.length > 0;
}

/**
 * Sends one report to the owner's Google Apps Script web app.
 *
 * `Content-Type: text/plain` is deliberate: it keeps the request a CORS
 * "simple request", so the browser does not send an OPTIONS preflight that an
 * Apps Script web app cannot answer.
 */
export async function submitFeedback(input: { kind: FeedbackKind; message: string }): Promise<void> {
  const message = input.message.trim();
  if (message.length < MIN_MESSAGE_LENGTH) {
    throw new Error('Please write at least a few words so we know what happened.');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Please keep feedback under ${MAX_MESSAGE_LENGTH} characters.`);
  }

  if (!FEEDBACK_ENDPOINT) {
    throw new Error("Feedback isn't configured in this build.");
  }
  await postFeedback(FEEDBACK_ENDPOINT, input.kind, message);
}

/** Internal, exported for tests. Apps Script answers HTTP 200 even on refusal. */
export async function postFeedback(
  endpoint: string,
  kind: FeedbackKind,
  message: string
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ kind, message }),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      throw new Error('The feedback sheet took too long to answer. Try again in a moment.');
    }
    throw new Error('Could not reach the feedback sheet. Check your connection and try again.');
  }

  const text = await response.text().catch(() => '');
  let result: { ok?: boolean; error?: string } | null = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }

  if (!response.ok || result?.ok !== true) {
    if (result?.error === 'rate_limited') {
      throw new Error('The feedback sheet is getting a lot of reports right now. Try again later.');
    }
    throw new Error('The feedback sheet did not confirm the report. Try again in a moment.');
  }
}
