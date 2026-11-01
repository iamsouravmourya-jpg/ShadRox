'use strict';

// Opt-in helper: remove a document's own CSP <meta> tag so the local preview
// frame can render. Response headers and all other markup are left untouched.

const CSP_EQUIVS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
]);

// Elements whose contents are raw text and must never be scanned for tags.
const RAWTEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// Returns the index just past the closing '>' of the tag starting at `start`,
// honouring quoted attribute values (a '>' inside quotes does not end the tag),
// or -1 when the tag is unterminated.
function findTagEnd(html, start) {
  let quote = 0;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return -1;
}

// Parses attributes from the slice of a single tag (contents between '<' and
// '>'), starting at `i` (just after the tag name). Names are lowercased; the
// first occurrence of a duplicated attribute wins.
function parseAttributes(raw, start) {
  const attrs = Object.create(null);
  const n = raw.length;
  let i = start;

  while (i < n) {
    while (i < n && (isSpace(raw[i]) || raw[i] === '/')) i++;
    if (i >= n) break;

    const nameStart = i;
    while (i < n && !isSpace(raw[i]) && raw[i] !== '=' && raw[i] !== '/') i++;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }

    while (i < n && isSpace(raw[i])) i++;

    let value = '';
    if (raw[i] === '=') {
      i++;
      while (i < n && isSpace(raw[i])) i++;
      const quote = raw[i];
      if (quote === '"' || quote === "'") {
        i++;
        const valueStart = i;
        while (i < n && raw[i] !== quote) i++;
        value = raw.slice(valueStart, i);
        if (i < n) i++;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(raw[i])) i++;
        // Tolerate a self-closing slash glued to an unquoted value.
        value = raw.slice(valueStart, i).replace(/\/+$/, '');
      }
    }

    if (!(name in attrs)) attrs[name] = value;
  }

  return attrs;
}

// Returns the index just past the closing tag of a raw-text element, or -1.
function findRawTextEnd(html, from, tagName) {
  const needle = '</' + tagName;
  let i = from;
  while (i < html.length) {
    const idx = html.indexOf('</', i);
    if (idx === -1) return -1;
    if (html.slice(idx, idx + needle.length).toLowerCase() === needle) {
      return findTagEnd(html, idx);
    }
    i = idx + 2;
  }
  return -1;
}

function stripContentSecurityPolicyMeta(html) {
  if (typeof html !== 'string') return html;

  const n = html.length;
  let out = '';
  let copied = 0;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    // Comments may mention CSP; skip them wholesale.
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }

    const end = findTagEnd(html, lt);
    if (end === -1) break; // unterminated tag: leave the rest alone

    const raw = html.slice(lt + 1, end - 1);
    let p = 0;
    const isEndTag = raw[0] === '/';
    if (isEndTag) p = 1;
    while (p < raw.length && isSpace(raw[p])) p++;
    let nameEnd = p;
    while (nameEnd < raw.length && !isSpace(raw[nameEnd]) && raw[nameEnd] !== '/') nameEnd++;
    const tagName = raw.slice(p, nameEnd).toLowerCase();

    if (!isEndTag && tagName === 'meta') {
      const attrs = parseAttributes(raw, nameEnd);
      const equiv = attrs['http-equiv'];
      if (typeof equiv === 'string' && CSP_EQUIVS.has(equiv.trim().toLowerCase())) {
        let removeEnd = end;

        // If the tag was alone on its line, also drop the line's trailing
        // newline so no empty line is left behind.
        let lineStart = lt;
        while (lineStart > 0 && html[lineStart - 1] !== '\n') lineStart--;
        let aloneOnLine = true;
        for (let k = lineStart; k < lt; k++) {
          const c = html[k];
          if (c !== ' ' && c !== '\t' && c !== '\r') {
            aloneOnLine = false;
            break;
          }
        }
        if (aloneOnLine) {
          let k = end;
          while (k < n && (html[k] === ' ' || html[k] === '\t' || html[k] === '\r')) k++;
          if (k >= n) removeEnd = n;
          else if (html[k] === '\n') removeEnd = k + 1;
        }

        out += html.slice(copied, lt);
        copied = removeEnd;
        i = removeEnd;
        continue;
      }
    }

    if (!isEndTag && RAWTEXT_ELEMENTS.has(tagName)) {
      const rawEnd = findRawTextEnd(html, end, tagName);
      if (rawEnd === -1) break;
      i = rawEnd;
      continue;
    }

    i = end;
  }

  if (copied === 0) return html;
  return out + html.slice(copied);
}

function isHtmlDocument(relativePath, contentType) {
  const type = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  if (type) return type.startsWith('text/html');
  if (typeof relativePath !== 'string') return false;
  const path = relativePath.split('#')[0].split('?')[0].toLowerCase();
  return path.endsWith('.html') || path.endsWith('.htm');
}

module.exports = { stripContentSecurityPolicyMeta, isHtmlDocument };
