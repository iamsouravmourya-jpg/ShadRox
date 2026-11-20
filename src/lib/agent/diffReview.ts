import { getDesktopBridge } from '../desktop';
import { containsSecret, redactSecrets } from '../secrets';
import type { ToolDefinition, ToolOutcome } from './tools';

/**
 * Pre-finish diff review: read the turn's real git diff through the existing
 * read-only git bridge and report structured, actionable findings — debug
 * prints, TODOs, secret-like strings, out-of-scope/unrelated changes, missed
 * expected files and oversized edits. The loop can act on these BEFORE finish.
 *
 * Everything here is evidence from the actual diff; nothing is guessed. A
 * secret finding names the shape and the line, never the secret itself.
 */

export type DiffFindingSeverity = 'error' | 'warning' | 'info';

export interface DiffFinding {
  severity: DiffFindingSeverity;
  kind: 'secret' | 'debug_print' | 'todo' | 'unrelated' | 'out_of_scope' | 'missed_file' | 'large_change' | 'untracked';
  path: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface DiffReviewOptions {
  /** What the turn was asked to do; drives the unrelated-change heuristic. */
  intent?: string;
  /** Files the turn declared it would touch; drives scope + missed checks. */
  expectedFiles?: string[];
}

export interface DiffReviewResult {
  isRepo: boolean;
  filesChanged: number;
  addedLines: number;
  removedLines: number;
  findings: DiffFinding[];
}

const MAX_FILES = 400;
const MAX_LINES = 20_000;
const LARGE_CHANGE_ADDED = 200;

const DEBUG_PRINT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bconsole\.(log|debug|info|trace|dir|table)\s*\(/, label: 'console.* print' },
  { pattern: /\bdebugger\s*(;|$)/, label: 'debugger statement' },
  { pattern: /^\s*print\s*\(/, label: 'print() call' },
  { pattern: /\bdbg!\s*\(/, label: 'dbg! macro' },
  { pattern: /\bSystem\.out\.print/, label: 'System.out.print' },
  { pattern: /\bfmt\.Print(ln|f|s)?\s*\(/, label: 'fmt.Print* call' },
  { pattern: /\bvar_dump\s*\(/, label: 'var_dump' },
  { pattern: /\bdd\s*\(/, label: 'dd() dump' },
  { pattern: /\bbinding\.pry\b/, label: 'binding.pry' }
];

const EXTRA_SECRET_SHAPES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, label: 'GitHub token shape' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, label: 'GitHub fine-grained token shape' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{15,}/, label: 'GitLab token shape' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token shape' },
  { pattern: /\bAQ\.[A-Za-z0-9_-]{20,}/, label: 'Google auth-key shape' },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, label: 'private key block' },
  { pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i, label: 'credential-bearing connection string' }
];

const TEST_PATH = /(?:\.test\.|\.spec\.|__tests__\/|\/tests?\/)/i;

const INTENT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'add', 'fix', 'make', 'update', 'change',
  'please', 'should', 'would', 'could', 'into', 'when', 'where', 'what', 'how', 'why', 'not', 'are'
]);

function intentTokens(intent: string): string[] {
  const words = intent.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !INTENT_STOP_WORDS.has(word)))].slice(0, 12);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

interface ParsedFile {
  path: string;
  added: Array<{ line: number; text: string }>;
  removedCount: number;
}

/** Parse a unified git diff into per-file added/removed evidence. */
export function parseDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let newLine = 0;
  let linesSeen = 0;
  for (const raw of diff.split('\n')) {
    if (linesSeen++ >= MAX_LINES) break;
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      if (files.length >= MAX_FILES) break;
      current = { path: header[2], added: [], removedCount: 0 };
      files.push(current);
      newLine = 0;
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      current.added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      current.removedCount += 1;
    } else if (!raw.startsWith('\\')) {
      newLine += 1;
    }
  }
  return files;
}

function isSecretLine(text: string): string | null {
  if (containsSecret(text)) return 'credential-shaped assignment/key';
  for (const shape of EXTRA_SECRET_SHAPES) {
    if (shape.pattern.test(text)) return shape.label;
  }
  return null;
}

/** The pure review core — exported so tests drive it with fixture diffs. */
export function reviewDiff(diff: string, status: string, options: DiffReviewOptions = {}): DiffReviewResult {
  const files = parseDiff(diff);
  const findings: DiffFinding[] = [];
  let addedLines = 0;
  let removedLines = 0;
  const tokens = options.intent ? intentTokens(options.intent) : [];
  const expected = (options.expectedFiles ?? []).map(normalizePath);
  const changedPaths = new Set(files.map((file) => normalizePath(file.path)));

  for (const file of files) {
    addedLines += file.added.length;
    removedLines += file.removedCount;
    const inTests = TEST_PATH.test(file.path);
    for (const added of file.added) {
      const secret = isSecretLine(added.text);
      if (secret) {
        findings.push({
          severity: 'error',
          kind: 'secret',
          path: file.path,
          line: added.line,
          message: `Added line looks like a secret (${secret}). The value is NOT echoed here.`,
          suggestion: 'Remove the credential from the diff; load it from env/secret store instead. Rotate it if it was ever committed.'
        });
        continue;
      }
      for (const debug of DEBUG_PRINT_PATTERNS) {
        if (debug.pattern.test(added.text)) {
          findings.push({
            severity: inTests ? 'info' : 'warning',
            kind: 'debug_print',
            path: file.path,
            line: added.line,
            message: `Added ${debug.label}${inTests ? ' (test file — often intentional)' : ''}: ${redactSecrets(added.text.trim()).slice(0, 120)}`,
            suggestion: inTests ? undefined : 'Remove the debug output before finishing, or justify it as intentional logging.'
          });
          break;
        }
      }
      const todo = /\b(TODO|FIXME|XXX|HACK)\b/.exec(added.text);
      if (todo) {
        findings.push({
          severity: 'warning',
          kind: 'todo',
          path: file.path,
          line: added.line,
          message: `Added ${todo[1]} marker: ${redactSecrets(added.text.trim()).slice(0, 120)}`,
          suggestion: 'Either complete the marked work now or tell the user it remains, explicitly.'
        });
      }
    }
    if (file.added.length > LARGE_CHANGE_ADDED) {
      findings.push({
        severity: 'info',
        kind: 'large_change',
        path: file.path,
        message: `${file.added.length} added lines — verify this is all in scope for the request.`,
        suggestion: 'Re-read the diff hunks of this file before finishing.'
      });
    }
    if (expected.length > 0) {
      if (!expected.includes(normalizePath(file.path))) {
        findings.push({
          severity: 'warning',
          kind: 'out_of_scope',
          path: file.path,
          message: 'Changed file was not in the declared expected-files list.',
          suggestion: 'Confirm the change belongs to this turn; revert it if it is collateral.'
        });
      }
    } else if (tokens.length > 0) {
      const pathTokens = normalizePath(file.path).split(/[^a-z0-9]+/).filter(Boolean);
      const overlap = tokens.some((token) => pathTokens.some((part) => part.includes(token) || token.includes(part)));
      if (!overlap) {
        findings.push({
          severity: 'info',
          kind: 'unrelated',
          path: file.path,
          message: 'No vocabulary overlap with the stated intent — possibly an unrelated change (heuristic, not proof).',
          suggestion: 'Check whether this file needed to change for the request.'
        });
      }
    }
  }

  for (const path of expected) {
    if (!changedPaths.has(path)) {
      findings.push({
        severity: 'info',
        kind: 'missed_file',
        path,
        message: 'Declared expected file has no change in the working-tree diff.',
        suggestion: 'If the task required editing it, the edit is missing (or already committed).'
      });
    }
  }

  // Untracked files never appear in `git diff`; the status porcelain lists them.
  for (const raw of status.split('\n')) {
    const untracked = /^\?\?\s+(.+)$/.exec(raw.trim());
    if (untracked) {
      findings.push({
        severity: 'info',
        kind: 'untracked',
        path: untracked[1].replace(/^"|"$/g, ''),
        message: 'New untracked file — verify it is intended (and not a stray artifact).',
        suggestion: 'Keep it if the task created it; remove stray logs/dumps.'
      });
    }
  }

  const order: Record<DiffFindingSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity] || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  return { isRepo: true, filesChanged: files.length, addedLines, removedLines, findings: findings.slice(0, 120) };
}

function renderReview(result: DiffReviewResult): string {
  const counts = {
    error: result.findings.filter((entry) => entry.severity === 'error').length,
    warning: result.findings.filter((entry) => entry.severity === 'warning').length,
    info: result.findings.filter((entry) => entry.severity === 'info').length
  };
  const head = `Diff review: ${result.filesChanged} file(s), +${result.addedLines}/-${result.removedLines} lines · ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info(s).`;
  if (result.findings.length === 0) return `${head}\nNo issues found in the added lines. Safe to finish.`;
  const body = result.findings.map((finding) =>
    `[${finding.severity}] ${finding.kind} ${finding.path}${finding.line !== undefined ? `:${finding.line}` : ''} — ${finding.message}${finding.suggestion ? ` → ${finding.suggestion}` : ''}`
  ).join('\n');
  return `${head}\n${body}\n\nAct on errors and warnings BEFORE finish; info items need a conscious decision, not necessarily a change.`;
}

export async function handleDiffReview(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const desktop = getDesktopBridge();
  if (!desktop) return { ok: false, content: '', error: 'The desktop bridge is unavailable, so the diff cannot be read.', refused: true };
  if (!workspaceId) return { ok: false, content: '', error: 'diff_review needs an opened folder workspace.', refused: true };
  try {
    const git = await desktop.gitRead(workspaceId);
    if (!git.isRepo) return { ok: true, content: 'This folder is not a git repository, so there is no diff to review. Verify changes by re-reading the files you edited instead.' };
    const expectedFiles = Array.isArray(args.expectedFiles)
      ? args.expectedFiles.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 40)
      : undefined;
    const intent = typeof args.intent === 'string' ? args.intent.slice(0, 600) : undefined;
    if (!git.diff.trim() && !/^\?\?/m.test(git.status)) {
      return { ok: true, content: 'The working tree has no uncommitted changes — nothing to review. (If you expected changes, they may already be committed or were never written.)' };
    }
    const result = reviewDiff(git.diff, git.status, { intent, expectedFiles });
    const json = JSON.stringify({ kind: 'shadrox:diff-review', ...result });
    const rendered = renderReview(result);
    const content = json.length <= 16_000
      ? `${rendered}\n\`\`\`shadrox:diff-review\n${json}\n\`\`\``
      : rendered;
    return { ok: true, content: content.length <= 22_000 ? content : `${content.slice(0, 22_000)}\n…(output bounded)` };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  }
}

export const DIFF_REVIEW_TOOLS: ToolDefinition[] = [
  {
    name: 'diff_review',
    description: 'Review the turn\'s real working-tree git diff before finishing: secret-like strings (error), debug prints and TODOs (warning), out-of-scope/unrelated changes, missed expected files and oversized edits (info). Returns structured findings you must act on before finish. Read-only.',
    parameters: 'intent?: string (what the turn was asked to do), expectedFiles?: string[] (files the turn declared it would touch)'
  }
];

export const DIFF_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: 'The user request this turn serves; drives the unrelated-change heuristic.' },
    expectedFiles: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files the turn planned to touch.' }
  },
  additionalProperties: false
};