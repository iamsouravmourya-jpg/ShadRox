'use strict';

/**
 * A command's risk notice arrives over IPC from the renderer, whose text a model
 * can influence, so it is allowed to be read and nothing else: one line, no
 * control characters, capped. Main keeps the decision; this only protects the
 * dialog's typography from whatever the model made the renderer say.
 */
const MAX_RISK_NOTICE_CHARS = 400;

function sanitizeRiskNotice(value) {
  if (typeof value !== 'string') return '';
  const plain = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RISK_NOTICE_CHARS);
  return plain || '';
}

module.exports = { MAX_RISK_NOTICE_CHARS, sanitizeRiskNotice };
