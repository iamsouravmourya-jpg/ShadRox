/**
 * Renderer-side mirror of electron/project-scaffold.cjs: the same folder-name
 * rules, checked before the IPC round-trip so the error is instant. The CJS file
 * stays the authority for the main process; projectName.test.ts asserts the two
 * agree on every case, so they cannot drift silently.
 */

export const MAX_NAME_LENGTH = 64;
/** Characters Windows forbids in a single path segment, plus path separators. */
const ILLEGAL = /[\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeProjectName(raw: string): string {
  if (typeof raw !== 'string') throw new Error('Give the project a name first.');
  let name = raw.trim();
  if (name === '.' || name === '..') throw new Error('That is not a project name.');
  name = name.replace(/[. ]+$/, '');
  if (!name) throw new Error('Give the project a name first.');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Keep the project name under ${MAX_NAME_LENGTH} characters.`);
  if (ILLEGAL.test(name)) throw new Error('A project name cannot contain \\ / : * ? " < > |');
  if (/[\u0000-\u001f]/.test(name)) throw new Error('A project name cannot contain control characters.');
  if (name.startsWith('.')) throw new Error('A project name cannot start with a dot — the explorer hides dot-folders.');
  if (RESERVED.test(name.split('.')[0])) throw new Error(`"${name}" is a reserved device name on Windows. Pick another.`);
  return name;
}
