'use strict';

/**
 * Picks a folder name for a new, empty project: a name the filesystem will
 * accept, and nothing else. Pure functions so the rules are tested without a
 * dialog or a disk.
 */

const MAX_NAME_LENGTH = 64;
/** Characters Windows forbids in a single path segment, plus path separators. */
const ILLEGAL = /[\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validates a project folder name. Throws with a user-readable reason rather
 * than silently rewriting it — a folder the user did not name is a surprise.
 */
function sanitizeProjectName(raw) {
  if (typeof raw !== 'string') throw new Error('Give the project a name first.');
  let name = raw.trim();
  if (name === '.' || name === '..') throw new Error('That is not a project name.');
  name = name.replace(/[. ]+$/, '');
  if (!name) throw new Error('Give the project a name first.');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Keep the project name under ${MAX_NAME_LENGTH} characters.`);
  if (ILLEGAL.test(name)) throw new Error('A project name cannot contain \\ / : * ? " < > |');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw new Error('A project name cannot contain control characters.');
  if (name.startsWith('.')) throw new Error('A project name cannot start with a dot — the explorer hides dot-folders.');
  if (RESERVED.test(name.split('.')[0])) throw new Error(`"${name}" is a reserved device name on Windows. Pick another.`);
  return name;
}

module.exports = { sanitizeProjectName, MAX_NAME_LENGTH };