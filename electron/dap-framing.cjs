'use strict';

/**
 * The DAP wire format, shared by the TypeScript client
 * (`src/lib/debug/abstractDebugAdapter.ts`) and the main-process host
 * (`electron/debug-host.cjs`).
 *
 * A frame is:
 *
 *   Content-Length: <byte length of the UTF-8 JSON body>\r\n
 *   \r\n
 *   <JSON body>
 *
 * The parser buffers partial input, so a header split across two `data`
 * events — or a body cut in the middle of a JSON token — still yields exactly
 * one message once the rest arrives.
 */

const TWO_CRLF = '\r\n\r\n';
const HEADER_LINE_SEPARATOR = /\r?\n/;
const HEADER_FIELD_SEPARATOR = /: */;

/** Bodies are bounded so a broken adapter cannot exhaust main-process memory. */
const DEFAULT_MAX_CONTENT_LENGTH = 16 * 1024 * 1024;

/**
 * Encode one protocol message as a DAP frame string.
 * @param {object} message
 * @returns {string}
 */
function encodeFrame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}${TWO_CRLF}${json}`;
}

/**
 * Encode one protocol message as a Buffer for stream writes.
 * @param {object} message
 * @returns {Buffer}
 */
function encodeFrameBuffer(message) {
  return Buffer.from(encodeFrame(message), 'utf8');
}

/**
 * Incremental DAP frame parser.
 *
 * @param {{
 *   onMessage?: (message: any) => void,
 *   onError?: (error: Error) => void,
 *   maxContentLength?: number
 * }} [options]
 * @returns {{ push: (chunk: Buffer | string) => void, reset: () => void, readonly bufferedBytes: number }}
 */
function createFrameParser(options = {}) {
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const maxContentLength = Number.isSafeInteger(options.maxContentLength) && options.maxContentLength > 0
    ? options.maxContentLength
    : DEFAULT_MAX_CONTENT_LENGTH;

  let rawData = Buffer.alloc(0);
  let contentLength = -1;

  /** Parse everything currently buffered; stop at the first incomplete frame. */
  function drain() {
    while (true) {
      if (contentLength >= 0) {
        if (rawData.length >= contentLength) {
          const body = rawData.toString('utf8', 0, contentLength);
          rawData = rawData.subarray(contentLength);
          contentLength = -1;
          if (body.length > 0) {
            try {
              onMessage(JSON.parse(body));
            } catch (error) {
              onError(new Error(`${(error && error.message) || error}\n${body}`));
            }
          }
          continue; // there may be more complete messages in the buffer
        }
        return; // the body is still arriving
      }

      const headerEnd = rawData.indexOf(TWO_CRLF);
      if (headerEnd === -1) {
        // A header without its terminator is still arriving. Guard against a
        // peer that never sends the separator (or sends binary garbage).
        if (rawData.length > 64 * 1024) {
          onError(new Error('DAP header exceeded 64 KiB without a Content-Length terminator.'));
          rawData = Buffer.alloc(0);
        }
        return;
      }

      const header = rawData.toString('utf8', 0, headerEnd);
      rawData = rawData.subarray(headerEnd + TWO_CRLF.length);

      let parsedLength = NaN;
      for (const line of header.split(HEADER_LINE_SEPARATOR)) {
        const kvPair = line.split(HEADER_FIELD_SEPARATOR);
        if (kvPair[0] === 'Content-Length') {
          const value = Number(kvPair[1]);
          parsedLength = Number.isFinite(value) && value >= 0 ? value : NaN;
        }
      }

      if (!Number.isFinite(parsedLength)) {
        onError(new Error(`DAP frame is missing a valid Content-Length header: ${header.slice(0, 200)}`));
        rawData = Buffer.alloc(0);
        return;
      }
      if (parsedLength > maxContentLength) {
        onError(new Error(`DAP frame Content-Length ${parsedLength} exceeds the ${maxContentLength}-byte limit.`));
        rawData = Buffer.alloc(0);
        return;
      }
      contentLength = parsedLength;
    }
  }

  return {
    /** Append bytes from the adapter's readable stream. */
    push(chunk) {
      if (typeof chunk === 'string') {
        rawData = Buffer.concat([rawData, Buffer.from(chunk, 'utf8')]);
      } else if (Buffer.isBuffer(chunk)) {
        rawData = rawData.length === 0 ? chunk : Buffer.concat([rawData, chunk]);
      } else if (chunk instanceof Uint8Array) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        rawData = rawData.length === 0 ? buffer : Buffer.concat([rawData, buffer]);
      } else {
        return;
      }
      drain();
    },
    /** Drop any buffered bytes, e.g. when a new transport is attached. */
    reset() {
      rawData = Buffer.alloc(0);
      contentLength = -1;
    },
    get bufferedBytes() {
      return rawData.length;
    }
  };
}

module.exports = {
  DEFAULT_MAX_CONTENT_LENGTH,
  encodeFrame,
  encodeFrameBuffer,
  createFrameParser
};
