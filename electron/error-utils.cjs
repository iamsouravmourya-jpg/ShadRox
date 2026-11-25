'use strict';

/**
 * Recursively unwraps Node.js / Electron errors — especially `AggregateError`
 * instances thrown by `fetch` / `net.connect` / Happy-Eyeballs whose `.message`
 * is `""` and whose `.errors` property is a non-enumerable `[Getter/Setter]`.
 *
 * Guarantees a crisp, non-empty human-readable message and never leaks
 * `[errors]: [Getter/Setter]` or an empty string.
 */
function unwrapErrorMessage(error, seen = new Set()) {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed && trimmed !== '[errors]: [Getter/Setter]' ? trimmed : 'Unknown error';
  }
  if (typeof error !== 'object') {
    return String(error).trim() || 'Unknown error';
  }
  if (seen.has(error)) return '';
  seen.add(error);

  const parts = [];
  const pushUnique = (text) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean || clean === '[errors]: [Getter/Setter]' || clean === '[object Object]') return;
    if (!parts.includes(clean)) parts.push(clean);
  };

  let rawMessage = '';
  try {
    if (typeof error.message === 'string') rawMessage = error.message.trim();
  } catch {
    rawMessage = '';
  }

  let code = '';
  try {
    if (typeof error.code === 'string' && error.code.trim()) code = error.code.trim();
  } catch {
    code = '';
  }

  // Safely inspect AggregateError.errors (may be a getter property).
  let nestedErrors = null;
  try {
    const candidate = error.errors;
    if (Array.isArray(candidate)) {
      nestedErrors = candidate;
    } else if (candidate && typeof candidate[Symbol.iterator] === 'function') {
      nestedErrors = [...candidate];
    }
  } catch {
    nestedErrors = null;
  }

  if (nestedErrors && nestedErrors.length > 0) {
    const childMessages = [];
    for (const child of nestedErrors) {
      const msg = unwrapErrorMessage(child, seen);
      if (msg && msg !== 'Unknown error' && !childMessages.includes(msg)) {
        childMessages.push(msg);
      }
    }
    if (rawMessage) {
      pushUnique(code && !rawMessage.includes(code) ? `${code}: ${rawMessage}` : rawMessage);
    } else if (code && childMessages.length === 0) {
      pushUnique(code);
    }
    for (const childMsg of childMessages) {
      pushUnique(childMsg);
    }
  } else if (rawMessage) {
    pushUnique(code && !rawMessage.includes(code) ? `${code}: ${rawMessage}` : rawMessage);
  }

  // Also unwrap `.cause` if present (fetch TypeError often wraps AggregateError in `.cause`).
  try {
    if (error.cause !== undefined && error.cause !== null) {
      const causeMsg = unwrapErrorMessage(error.cause, seen);
      if (causeMsg && causeMsg !== 'Unknown error') pushUnique(causeMsg);
    }
  } catch {
    /* ignore getter failure */
  }

  if (parts.length === 0 && code) pushUnique(code);

  if (parts.length === 0) {
    try {
      const name = typeof error.name === 'string' && error.name !== 'Error' ? error.name.trim() : '';
      if (name) pushUnique(name);
    } catch {
      /* ignore */
    }
  }

  if (parts.length === 0) {
    try {
      const fallback = String(error).trim();
      if (fallback && fallback !== '[object Object]' && !fallback.includes('[Getter/Setter]')) {
        pushUnique(fallback);
      }
    } catch {
      /* ignore */
    }
  }

  return parts.length > 0 ? parts.join(' | ') : 'Unknown error';
}

module.exports = {
  unwrapErrorMessage
};
