/**
 * Pure matching helpers for preview click-to-source.
 *
 * The preview iframe (static HTML served over the shadrox-preview:// protocol)
 * posts a small `reveal-source` message when the user clicks an element. This
 * module validates that message and maps it back to a 0-based position in the
 * source file.
 *
 * Matching strategy, in order:
 *   1. `id` present: the first opening tag of the same name whose `id`
 *      attribute equals it exactly (case-sensitive; attribute order and quote
 *      style are irrelevant).
 *   2. `className` with a distinctive token (>= 4 chars): the first opening tag
 *      of the same name whose `class` attribute contains that token
 *      (case-insensitive).
 *   3. Same tag name with the element's first text word appearing within the
 *      next 40 lines.
 *   4. A looser raw scan for `<tag` followed within 40 lines by that word
 *      (rescues markup whose attribute quoting the tag parser cannot read).
 *
 * Comments (`<!-- ... -->`) are masked before matching, so nothing inside them
 * is ever reported. `<html>` and `<body>` targets are rejected.
 */

export interface RevealSourceTarget {
  path: string;
  tag: string;
  id: string;
  className: string;
  text: string;
}

export interface RevealSourceLocation {
  line: number;
  character: number;
}

const MAX_PATH_LENGTH = 512;
const MAX_TAG_LENGTH = 64;
const MAX_ID_LENGTH = 256;
const MAX_CLASS_LENGTH = 400;
const MAX_TEXT_LENGTH = 200;
const TEXT_SEARCH_LINES = 40;

const TAG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;

/** Opening tags with quoted attribute values treated as opaque; no `g` reuse. */
const OPEN_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function sanitizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || path.length > MAX_PATH_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.includes('\\')) return null;
  if (path.includes('..')) return null;
  if (path.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(path)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return null;
  if (path.includes('<') || path.includes('>')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.')) return null;
  return path;
}

function sanitizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase();
  if (!tag || tag.length > MAX_TAG_LENGTH) return null;
  if (!TAG_NAME_PATTERN.test(tag)) return null;
  return tag;
}

function sanitizeField(value: unknown, maxLength: number, collapseWhitespace: boolean): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = collapseWhitespace ? value.replace(/\s+/g, ' ').trim() : value.trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized.slice(0, maxLength);
}

/**
 * Validates an iframe `message` payload. Returns null for anything that is not
 * a well-formed, safely-shaped reveal request (including hostile paths).
 */
export function parseRevealMessage(data: unknown): RevealSourceTarget | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.source !== 'shadrox-preview') return null;
  if (record.type !== 'reveal-source') return null;

  const path = sanitizePath(record.path);
  if (!path) return null;
  const tag = sanitizeTag(record.tag);
  if (!tag) return null;
  const id = sanitizeField(record.id, MAX_ID_LENGTH, false);
  if (id === null) return null;
  const className = sanitizeField(record.className, MAX_CLASS_LENGTH, true);
  if (className === null) return null;
  const text = sanitizeField(record.text, MAX_TEXT_LENGTH, true);
  if (text === null) return null;

  return { path, tag, id, className, text };
}

/** Replaces comment bodies with spaces (newlines kept) so offsets stay stable. */
function maskHtmlComments(source: string): string {
  const characters = source.split('');
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<!--', cursor);
    if (start === -1) break;
    const endMarker = source.indexOf('-->', start + 4);
    const end = endMarker === -1 ? source.length : endMarker + 3;
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
    }
    cursor = end;
  }
  return characters.join('');
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function locateOffset(lineStarts: number[], offset: number): RevealSourceLocation {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - lineStarts[low] };
}

function readAttribute(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    '(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))',
    'i'
  );
  const match = pattern.exec(attributes);
  if (!match) return null;
  if (typeof match[1] === 'string') return match[1];
  if (typeof match[2] === 'string') return match[2];
  if (typeof match[3] === 'string') return match[3];
  return '';
}

interface OpeningTag {
  index: number;
  attributes: string;
}

function findOpeningTags(source: string, tagName: string): OpeningTag[] {
  const tags: OpeningTag[] = [];
  OPEN_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_PATTERN.exec(source))) {
    if (match[1].toLowerCase() !== tagName) continue;
    tags.push({ index: match.index, attributes: match[2] });
  }
  return tags;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstTextWord(text: string): string {
  if (typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/);
  return words[0] || '';
}

function distinctiveClassToken(className: string): string | null {
  if (typeof className !== 'string') return null;
  const tokens = className.split(/\s+/).filter((token) => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token));
  const distinctive = tokens
    .filter((token) => token.length >= 4)
    .sort((left, right) => right.length - left.length);
  return distinctive.length > 0 ? distinctive[0].toLowerCase() : null;
}

function offsetWithinLines(source: string, start: number, lineCount: number): number {
  let offset = start;
  let remaining = lineCount;
  while (remaining > 0 && offset < source.length) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
    remaining -= 1;
  }
  return offset;
}

/**
 * Returns the offset of the opening tag whose following text window contains
 * `word` and sits closest to it; a nested tag of the same name wins over an
 * outer wrapper because its window is shorter.
 */
function nearestTagWithText(source: string, tagOffsets: number[], word: string): number | null {
  if (!word) return null;
  const needle = word.toLowerCase();
  const haystack = source.toLowerCase();
  let bestOffset: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const offset of tagOffsets) {
    const occurrence = haystack.indexOf(needle, offset);
    if (occurrence === -1) continue;
    if (occurrence > offsetWithinLines(source, offset, TEXT_SEARCH_LINES)) continue;
    const distance = occurrence - offset;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/** Maps a reveal target to a 0-based line/character in the source file. */
export function findElementLine(
  source: string,
  target: RevealSourceTarget
): RevealSourceLocation | null {
  if (typeof source !== 'string' || !source || !target) return null;
  const tag = typeof target.tag === 'string' ? target.tag.trim().toLowerCase() : '';
  if (!tag || tag === 'html' || tag === 'body') return null;

  const masked = maskHtmlComments(source);
  const lineStarts = buildLineStarts(masked);
  const openings = findOpeningTags(masked, tag);
  const locate = (offset: number) => locateOffset(lineStarts, offset);
  const word = firstTextWord(target.text);

  // 1. id (case-sensitive), attribute order and quote style irrelevant.
  if (target.id) {
    for (const opening of openings) {
      if (readAttribute(opening.attributes, 'id') === target.id) return locate(opening.index);
    }
  }

  // 2. distinctive class token (case-insensitive).
  const classToken = distinctiveClassToken(target.className);
  if (classToken) {
    for (const opening of openings) {
      const className = readAttribute(opening.attributes, 'class');
      if (className !== null) {
        const tokens = className.split(/\s+/).map((token) => token.toLowerCase());
        if (tokens.indexOf(classToken) !== -1) return locate(opening.index);
      }
    }
  }

  // With no text to anchor to, a bare tag guess is only safe when nothing more
  // specific was reported (no id that already failed to match).
  if (!word) {
    if (!target.id && openings.length > 0) return locate(openings[0].index);
    return null;
  }

  // 3. same tag name + first text word within the next 40 lines. The nearest
  //    opening tag above the word wins, so nested tags beat outer wrappers.
  const parsedMatch = nearestTagWithText(
    masked,
    openings.map((opening) => opening.index),
    word
  );
  if (parsedMatch !== null) return locate(parsedMatch);

  // 4. loose raw scan for `<tag`, still requiring the text nearby.
  const rawPattern = new RegExp('<' + escapeRegExp(tag) + '(?=[\\s/>])', 'gi');
  const rawOffsets: number[] = [];
  let raw: RegExpExecArray | null;
  while ((raw = rawPattern.exec(masked))) rawOffsets.push(raw.index);
  const rawMatch = nearestTagWithText(masked, rawOffsets, word);
  if (rawMatch !== null) return locate(rawMatch);

  return null;
}
