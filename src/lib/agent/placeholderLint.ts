/**
 * Zero-placeholder AST/lexical lint verifier for generated TypeScript/JavaScript.
 *
 * Catches empty placeholder literals (`''`, `""`, `` `` ``, `null`, `undefined`)
 * paired with deferral comments (`TODO`, `FIXME`, `if needed`, `placeholder`,
 * `stub`, `retrieve ... if`, `for now`, `implement later`) plus explicit
 * `Not implemented` / `// ... existing code` truncation stubs. Rejecting these
 * on Attempt 1 forces Attempt 2 to wire real in-scope values before passing.
 */

import type { DiagnosticLine } from '../autonomy/types';

export interface PlaceholderIssue {
  path: string;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  column: number;
  message: string;
  snippet: string;
  severity: 'error';
}

const CHECKED_SCRIPT_EXT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;
const DECLARATION_EXT = /\.d\.(?:ts|mts|cts)$/i;

const DEFERRAL_COMMENT_RE =
  /(?:\/\/|\/\*)\s*.*\b(?:todo|fixme|placeholder|stub|if needed|for now|implement\s+later|wire\s+later|retrieve\b.*\bif|populate\b.*\bif|left empty|fill\s+in\s+later|dummy)\b/i;

const TRUNCATION_COMMENT_RE =
  /(?:\/\/|\/\*)\s*(?:\.\.\.\s*(?:rest|remaining|other|existing)\b|rest\s+of\s+(?:the\s+)?(?:file|code|implementation)\s+(?:unchanged|omitted))/i;

const EMPTY_VALUE_ASSIGNMENT_RE =
  /(?:[:=]|return)\s*(?:''|""|``|null|undefined)\s*[,;]?\s*(?:\/\/|\/\*)/;

const NOT_IMPLEMENTED_THROW_RE =
  /throw\s+new\s+Error\(\s*(['"`])(?:not\s+implemented(?:\s+yet)?|todo|placeholder|unimplemented)\1\s*\)/i;

const LITERAL_PLACEHOLDER_STRING_RE =
  /(?:[:=]|return)\s*(['"`])\s*(?:todo|fixme|placeholder|tbd|replace[_ ]?me|your[_ ]?[a-z_]+[_ ]?here)\s*\1/i;

export function isPlaceholderCheckedFile(path: string): boolean {
  const clean = path.trim();
  if (!clean || DECLARATION_EXT.test(clean)) return false;
  return CHECKED_SCRIPT_EXT.test(clean);
}

/** Inspect source content for incomplete placeholder stubs and return 1-based issues. */
export function lintPlaceholderCode(path: string, content: string): PlaceholderIssue[] {
  if (!isPlaceholderCheckedFile(path) || !content) return [];

  const issues: PlaceholderIssue[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : '';
    const lineNum = i + 1;

    if (TRUNCATION_COMMENT_RE.test(lineText)) {
      issues.push({
        path,
        line: lineNum,
        column: Math.max(1, lineText.search(/\S/) + 1),
        message: 'Incomplete code detected (truncation comment omitting code). Write the complete implementation.',
        snippet: lineText.trim(),
        severity: 'error'
      });
      continue;
    }

    if (NOT_IMPLEMENTED_THROW_RE.test(lineText)) {
      issues.push({
        path,
        line: lineNum,
        column: Math.max(1, lineText.search(/\S/) + 1),
        message: 'Unimplemented stub detected (`throw new Error(...)`). Provide the real implementation.',
        snippet: lineText.trim(),
        severity: 'error'
      });
      continue;
    }

    // Check same-line deferral comment paired with empty value: e.g. `courseTitle: '', // Retrieve course title if needed`
    if (DEFERRAL_COMMENT_RE.test(lineText) && EMPTY_VALUE_ASSIGNMENT_RE.test(lineText)) {
      issues.push({
        path,
        line: lineNum,
        column: Math.max(1, lineText.search(/\S/) + 1),
        message:
          'Placeholder empty value with deferral comment detected. Populate this field using real values or variables already in scope.',
        snippet: lineText.trim(),
        severity: 'error'
      });
      continue;
    }

    // Check preceding-line deferral comment followed immediately by empty literal assignment:
    //   // Retrieve course title if needed
    //   courseTitle: '',
    if (
      DEFERRAL_COMMENT_RE.test(prevLine) &&
      /(?:[:=]|return)\s*(?:''|""|``|null|undefined)\s*[,;]?\s*$/.test(lineText)
    ) {
      issues.push({
        path,
        line: lineNum,
        column: Math.max(1, lineText.search(/\S/) + 1),
        message:
          'Placeholder empty value following a TODO/if-needed comment detected. Populate this field using real values already in scope.',
        snippet: lineText.trim(),
        severity: 'error'
      });
      continue;
    }

    if (LITERAL_PLACEHOLDER_STRING_RE.test(lineText) && DEFERRAL_COMMENT_RE.test(lineText)) {
      issues.push({
        path,
        line: lineNum,
        column: Math.max(1, lineText.search(/\S/) + 1),
        message: 'Placeholder literal string detected. Replace with real domain values in scope.',
        snippet: lineText.trim(),
        severity: 'error'
      });
    }
  }

  return issues;
}

export function placeholderDiagnostics(path: string, content: string): DiagnosticLine[] {
  return lintPlaceholderCode(path, content).map((issue) => ({
    path: issue.path,
    line: issue.line,
    column: issue.column,
    message: issue.message,
    severity: 'error'
  }));
}
