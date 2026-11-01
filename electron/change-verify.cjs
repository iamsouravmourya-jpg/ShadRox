/**
 * Pre-apply verification gate for AI-proposed file contents.
 *
 * The renderer parses an AI response into a change set (path + full new
 * content), and before ShadRox writes any of it to disk this module statically
 * checks every proposed file: TypeScript/JavaScript syntax diagnostics, JSON
 * parse errors, CSS brace balance, and a cheap HTML close-tag check.
 *
 * This is not a sandbox. It never executes, builds, imports, writes, or reads
 * workspace content: the only filesystem call is the `statSync` that validates
 * the root directory. A patch that survives here can still be semantically
 * wrong; it just is not obviously broken.
 *
 * Return shape (line/character are 0-based, matching the desktop diagnostics
 * in electron/ts-service.cjs):
 *
 *   {
 *     ok: boolean,                 // true only when there is no error issue
 *     checked: number,             // files that were actually verified
 *     issues: Array<{
 *       path: string,              // workspace-relative, forward slashes
 *       line: number,              // 0-based
 *       character: number,         // 0-based
 *       severity: 'error' | 'warning',
 *       code: string,              // 'TS####', 'JSON_PARSE_ERROR', ...
 *       message: string
 *     }>,
 *     skipped: string[]            // paths not verified: unknown extension,
 *                                  // empty content, or over a size limit
 *   }
 *
 * Limits, and the rule for each one:
 *   - more than maxFiles entries: rejected by throwing (malformed input shape)
 *   - one file larger than maxFileBytes: reported as an error issue and also
 *     listed in `skipped`, so the gate fails closed
 *   - the change set exceeding maxTotalBytes: the overflowing entry gets an
 *     error issue and it plus every remaining entry land in `skipped`
 *   - more than maxIssues findings: sorted, truncated to maxIssues, ok = false
 *
 * A path that is absolute, drive-lettered, UNC, NUL-bearing, or escapes the
 * root through `..` produces an 'outside the opened workspace' issue instead of
 * throwing, so one bad entry cannot mask the rest of the change set. Nothing is
 * ever read from or written to that path.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isPathInsideDirectory } = require('./desktop-security.cjs');

const CHANGE_VERIFY_LIMITS = Object.freeze({
  maxFiles: 50,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxIssues: 200
});

const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const JSON_EXTENSIONS = new Set(['.json', '.jsonc']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less']);

const OUTSIDE_WORKSPACE_MESSAGE = 'outside the opened workspace';

let cachedTypeScript = null;

function loadTypeScript() {
  if (cachedTypeScript) return cachedTypeScript;
  try {
    // typescript@7 (the `typescript` package) is the native port with no JS
    // API, so the parser always comes from the aliased legacy package.
    cachedTypeScript = require('typescript-legacy');
  } catch (error) {
    throw new Error(`The bundled TypeScript parser is unavailable: ${error.message}`);
  }
  return cachedTypeScript;
}

/** 0-based line/character for a UTF-16 offset in `text`. */
function positionToLineCharacter(text, position) {
  const limit = Math.max(0, Math.min(Number.isInteger(position) ? position : 0, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: limit - lineStart };
}

function displayPath(value) {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

/**
 * Resolves a proposed path against the root. Returns null for anything that is
 * not a plain workspace-relative path: absolute, drive-lettered (`C:x`),
 * UNC/rooted (`\\server`, `//server`, `\foo`, `/foo`), NUL-bearing, or escaping
 * the root after `..` resolution. Textual only: no filesystem access.
 */
function resolveWorkspaceRelativePath(root, candidate) {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!value || value.includes('\0')) return null;

  const slashed = value.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return null;

  const absolute = path.resolve(root, slashed);
  if (!isPathInsideDirectory(root, absolute)) return null;

  return {
    absolute,
    relative: path.relative(root, absolute).split(path.sep).join('/')
  };
}

function scriptKindFor(ts, extension) {
  switch (extension) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      // .ts, .mts, .cts: TypeScript syntax without JSX, which is exactly the
      // distinction that catches "<div>" written into a .ts file.
      return ts.ScriptKind.TS;
  }
}

/** Syntactic/parse diagnostics only; no program, no type checking, no emit. */
function checkScript(relativePath, content, extension) {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(ts, extension)
  );
  const diagnostics = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
  const issues = diagnostics.map((diagnostic) => {
    const start = typeof diagnostic.start === 'number' ? diagnostic.start : 0;
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, start);
    return {
      line,
      character,
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    };
  });

  // TypeScript's JS parser accepts JSX so it can serve allowJs/checkJs projects;
  // the change set only allows it in .jsx files, so JSX in .js/.mjs/.cjs is
  // reported explicitly.
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const jsxNode = findJsxNode(ts, sourceFile);
    if (jsxNode) {
      issues.push({
        ...ts.getLineAndCharacterOfPosition(sourceFile, jsxNode.getStart(sourceFile)),
        code: 'JSX_NOT_ALLOWED',
        message: `JSX syntax is not allowed in a ${extension} file; use .jsx or .tsx.`
      });
    }
  }

  return issues;
}

function findJsxNode(ts, sourceFile) {
  const jsxKinds = new Set([
    ts.SyntaxKind.JsxElement,
    ts.SyntaxKind.JsxSelfClosingElement,
    ts.SyntaxKind.JsxFragment
  ]);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (jsxKinds.has(node.kind)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Replaces `//` and `/* *\/` comments with spaces while leaving string literals
 * alone. Length and newlines are preserved so JSON error positions still point
 * at the original document.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        out += char;
      } else {
        out += ' ';
      }
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        out += '  ';
        index += 1;
      } else {
        out += char === '\n' || char === '\r' ? char : ' ';
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      out += '  ';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      out += '  ';
      index += 1;
      continue;
    }
    out += char;
  }

  return out;
}

function jsonErrorLocation(text, message) {
  const position = /at position (\d+)/.exec(message);
  if (position) return positionToLineCharacter(text, Number(position[1]));

  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) {
    return {
      line: Math.max(0, Number(lineColumn[1]) - 1),
      character: Math.max(0, Number(lineColumn[2]) - 1)
    };
  }

  return { line: 0, character: 0 };
}

function checkJson(content, extension) {
  // A leading BOM is invisible in editors but fatal to JSON.parse, so it is
  // dropped before parsing (it only shifts first-line columns by one).
  const text = (extension === '.jsonc' ? stripJsonComments(content) : content).replace(/^\uFEFF/, '');
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Invalid JSON document.';
    const { line, character } = jsonErrorLocation(text, message);
    return [{ line, character, code: 'JSON_PARSE_ERROR', message }];
  }
}

/**
 * Brace balance outside strings and comments. `//` comments only apply to
 * SCSS/LESS; plain CSS treats `//` as content so `url(http://...)` is not
 * mistaken for a comment. Reports the first stray `}` or the outermost
 * unclosed `{`.
 */
function checkBraceBalance(content, allowLineComments) {
  const stack = [];
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (allowLineComments && char === '/' && next === '/') {
      // `url(http://...)` in SCSS/LESS is URL content, not a comment; Sass
      // resolves the ambiguity the same way, and treating it as a comment would
      // swallow the rest of the rule and report a false unbalanced brace.
      if (!/https?:$/i.test(content.slice(Math.max(0, index - 6), index))) {
        lineComment = true;
        index += 1;
        continue;
      }
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      stack.push(index);
      continue;
    }
    if (char === '}') {
      if (stack.length === 0) {
        return [{ ...positionToLineCharacter(content, index), code: 'CSS_UNBALANCED_BRACE', message: 'Unexpected "}" with no matching "{".' }];
      }
      stack.pop();
    }
  }

  if (stack.length > 0) {
    return [{
      ...positionToLineCharacter(content, stack[0]),
      code: 'CSS_UNBALANCED_BRACE',
      message: 'Unclosed "{" in this stylesheet.'
    }];
  }
  return [];
}

function checkStyle(content, extension) {
  return checkBraceBalance(content, extension !== '.css');
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function checkHtml(content) {
  const lower = content.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  // Only real documents are checked; HTML fragments are left alone because a
  // partial file is not evidence of a broken patch.
  if (!lower.startsWith('<!doctype') && !lower.startsWith('<html')) return [];

  const issues = [];
  const openTags = countOccurrences(lower, '<script');
  const closeTags = countOccurrences(lower, '</script>');

  if (closeTags > openTags) {
    issues.push({
      ...positionToLineCharacter(content, lower.indexOf('</script>')),
      code: 'HTML_UNBALANCED_SCRIPT',
      message: 'A </script> tag has no matching <script>.'
    });
  } else if (openTags > closeTags) {
    issues.push({
      ...positionToLineCharacter(content, lower.lastIndexOf('<script')),
      code: 'HTML_UNBALANCED_SCRIPT',
      message: 'A <script> tag is never closed.'
    });
  }

  if (!lower.includes('</html>')) {
    issues.push({
      line: 0,
      character: 0,
      code: 'HTML_MISSING_CLOSE_HTML',
      message: 'This document has no </html> tag.'
    });
  }

  return issues;
}

function compareIssues(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.character !== right.character) return left.character - right.character;
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  return 0;
}

function verifyChangeSet(options) {
  const { root, files } = options || {};

  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('verifyChangeSet requires a workspace root directory.');
  }

  let rootStats;
  try {
    rootStats = fs.statSync(root);
  } catch {
    throw new Error(`The workspace root does not exist or is not readable: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`The workspace root is not a directory: ${root}`);
  }

  if (!Array.isArray(files)) {
    throw new TypeError('verifyChangeSet requires files to be an array of { path, content } entries.');
  }
  if (files.length > CHANGE_VERIFY_LIMITS.maxFiles) {
    throw new Error(`A change set may contain at most ${CHANGE_VERIFY_LIMITS.maxFiles} files (received ${files.length}).`);
  }

  const issues = [];
  const skipped = [];
  let checked = 0;
  let totalBytes = 0;

  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each change set entry must be an object with path and content.');
    }

    const resolved = resolveWorkspaceRelativePath(root, entry.path);
    if (!resolved) {
      issues.push({
        path: displayPath(entry.path),
        line: 0,
        character: 0,
        severity: 'error',
        code: 'PATH_OUTSIDE_WORKSPACE',
        message: OUTSIDE_WORKSPACE_MESSAGE
      });
      continue;
    }
    const { relative } = resolved;

    if (typeof entry.content !== 'string') {
      issues.push({
        path: relative,
        line: 0,
        character: 0,
        severity: 'error',
        code: 'INVALID_CONTENT',
        message: 'File content must be a string.'
      });
      continue;
    }

    const content = entry.content;
    if (!content.trim()) {
      skipped.push(relative);
      continue;
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > CHANGE_VERIFY_LIMITS.maxFileBytes) {
      skipped.push(relative);
      issues.push({
        path: relative,
        line: 0,
        character: 0,
        severity: 'error',
        code: 'FILE_TOO_LARGE',
        message: `File content is larger than the ${CHANGE_VERIFY_LIMITS.maxFileBytes} byte verification limit.`
      });
      continue;
    }

    if (totalBytes + bytes > CHANGE_VERIFY_LIMITS.maxTotalBytes) {
      skipped.push(relative);
      issues.push({
        path: relative,
        line: 0,
        character: 0,
        severity: 'error',
        code: 'CHANGE_SET_TOO_LARGE',
        message: `The change set exceeds the ${CHANGE_VERIFY_LIMITS.maxTotalBytes} byte verification limit.`
      });
      continue;
    }
    totalBytes += bytes;

    const extension = path.extname(resolved.absolute).toLowerCase();
    let fileIssues;
    if (SCRIPT_EXTENSIONS.has(extension)) {
      fileIssues = checkScript(relative, content, extension);
    } else if (JSON_EXTENSIONS.has(extension)) {
      fileIssues = checkJson(content, extension);
    } else if (STYLE_EXTENSIONS.has(extension)) {
      fileIssues = checkStyle(content, extension);
    } else if (extension === '.html' || extension === '.htm') {
      fileIssues = checkHtml(content);
    } else {
      skipped.push(relative);
      continue;
    }

    checked += 1;
    for (const issue of fileIssues) {
      issues.push({
        path: relative,
        line: issue.line,
        character: issue.character,
        severity: 'error',
        code: issue.code,
        message: issue.message
      });
    }
  }

  issues.sort(compareIssues);
  const truncated = issues.length > CHANGE_VERIFY_LIMITS.maxIssues;
  const reported = truncated ? issues.slice(0, CHANGE_VERIFY_LIMITS.maxIssues) : issues;
  const hasError = reported.some((issue) => issue.severity === 'error');

  return {
    ok: !truncated && !hasError,
    checked,
    issues: reported,
    skipped
  };
}

module.exports = { verifyChangeSet, CHANGE_VERIFY_LIMITS };
