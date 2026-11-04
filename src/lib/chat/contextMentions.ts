/*
 * PORTED FROM CLINE (https://github.com/cline/cline), Apache License 2.0,
 * Copyright (c) Cline Bot Inc. contributors.
 *
 * `mentionRegex` / `mentionRegexGlobal` are a verbatim port of the mention
 * grammar in cline's `apps/vscode/src/shared/context-mentions.ts`, and the
 * rewrite-then-append behavior of `expandContextMentions` mirrors
 * `parseMentions` in cline's `apps/vscode/src/core/mentions/index.ts`
 * (`<file_content>` / `<folder_content>` blocks appended after pointer
 * phrases). This copy is used under Apache-2.0 with attribution; the full
 * license is at reference/cline-main/LICENSE.
 *
 * ShadRox scope: @file/@folder paths, @problems and @git-changes resolve
 * against the live workspace buffers plus the desktop bridge (the same
 * sources the `problems` / `git_state` read-only tools use). URLs, git
 * commit hashes, @terminal and workspace-prefixed paths are recognized by
 * the grammar but have no read-only data source in this app today, so
 * they degrade to plain text — a mention that cannot be resolved never
 * errors and never rewrites.
 */

/**
 * Mention regex (ported verbatim from cline's context-mentions.ts):
 * - `@` — the mention must start with '@'.
 * - `[\w-]+:/[^\s]*?` — workspace-prefixed paths (`@name:/path`); ShadRox is
 *   single-root, so these stay literal.
 * - `[\w-]+:"\/[^"]*?"` — workspace-prefixed quoted paths.
 * - `/[^\s]*?` — plain workspace-relative paths starting with '/'.
 * - `"\/[^"]*?"` — quoted paths that may contain spaces.
 * - `(?:\w+:\/\/)[^\s]+?` — URLs; recognized, not resolved here.
 * - `[a-f0-9]{7,40}\b` — git commit hashes; recognized, not resolved here.
 * - `problems\b`, `terminal\b`, `git-changes\b` — exact keywords.
 * - `(?=[.,;:!?()]*(?=[\s\r\n]|$))` — trailing punctuation is excluded from
 *   the match so `@problems,` still mentions `problems`.
 */
export const mentionRegex = new RegExp(
  '@(' +
    '[\\w-]+:/[^\\s]*?' + // Workspace-prefixed file paths: @workspace:name/path
    '|[\\w-]+:"\\/[^"]*?"' + // Workspace-prefixed quoted file paths
    '|/[^\\s]*?' + // Simple file paths
    '|"\\/[^"]*?"' + // Quoted file paths which can contain spaces
    '|(?:\\w+:\\/\\/)[^\\s]+?' + // URLs
    '|[a-f0-9]{7,40}\\b' + // Git commit hashes
    '|problems\\b' + // Exact word 'problems'
    '|terminal\\b' + // Exact word 'terminal'
    '|git-changes\\b' + // Exact word 'git-changes'
    ')' +
    '(?=[.,;:!?()]*(?=[\\s\\r\\n]|$))' // Lookahead for trailing punctuation (multiple allowed)
);
export const mentionRegexGlobal = new RegExp(mentionRegex.source, 'g');

/** A mention token is everything after the '@' the grammar captured. */
export function parseContextMentions(text: string): string[] {
  const matches = text.match(mentionRegexGlobal);
  if (!matches) return [];
  return [...new Set(matches.map((match) => match.slice(1)))];
}

/** File mentions are '/path' or quoted '"/path with spaces"' forms. */
export function isFileMention(token: string): boolean {
  return token.startsWith('/') || token.startsWith('"/');
}

/** Unquote and strip the leading '/': the workspace-relative path. */
export function filePathFromMention(token: string): string {
  const quoted = /^"(.*)"$/.exec(token);
  return (quoted ? quoted[1] : token).slice(1);
}

export interface MentionSources {
  /** Workspace-relative file contents; null when the file cannot be read. */
  readFile?: (path: string) => Promise<string | null> | string | null;
  /** Direct children of a workspace-relative folder (trailing '/' in, out). */
  listDirectory?: (path: string) => Promise<string[] | null> | string[] | null;
  /** Compiler problems text, the same payload the `problems` tool reports. */
  problems?: () => Promise<string> | string;
  /** Working-tree status/diff, the same payload the `git_state` tool reports. */
  gitChanges?: () => Promise<string> | string;
}

export interface MentionExpandOptions {
  /** Per-mention block clip before it reaches the prompt. */
  maxCharsPerBlock?: number;
  /** Hard ceiling on the whole appended context, protecting the window. */
  maxTotalChars?: number;
}

const DEFAULT_MAX_CHARS_PER_BLOCK = 40_000;
const DEFAULT_MAX_TOTAL_CHARS = 160_000;

function clipBlock(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[... truncated: ${content.length} characters total]`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/**
 * Resolve one mention token to its rewrite phrase + context block, or null
 * when nothing can be resolved — the call site then leaves the original
 * `@token` in the text untouched. Every failure mode (missing source,
 * missing file, throwing provider) degrades to plain text; nothing throws.
 */
async function resolveMention(
  token: string,
  sources: MentionSources,
  maxCharsPerBlock: number
): Promise<{ phrase: string; block: string } | null> {
  try {
    if (token === 'problems') {
      if (!sources.problems) return null;
      const body = await sources.problems();
      if (!body) return null;
      return {
        phrase: 'Workspace Problems (see below for diagnostics)',
        block: `<problems>\n${clipBlock(body, maxCharsPerBlock)}\n</problems>`
      };
    }
    if (token === 'git-changes') {
      if (!sources.gitChanges) return null;
      const body = await sources.gitChanges();
      if (!body) return null;
      return {
        phrase: 'Working directory changes (see below for details)',
        block: `<git_changes>\n${clipBlock(body, maxCharsPerBlock)}\n</git_changes>`
      };
    }
    // @terminal is in the grammar but this app has no read-only terminal
    // output source (the renderer's ring buffer is consume-on-read for tab
    // remounts), so the mention falls through to the literal path below.
    if (isFileMention(token)) {
      const relPath = filePathFromMention(token);
      // Cline's safety guard: a bare "@/" would expand to the whole root.
      if (!relPath) return null;
      if (relPath.endsWith('/')) {
        if (!sources.listDirectory) return null;
        const entries = await sources.listDirectory(relPath);
        if (entries === null || entries === undefined) return null;
        const listing = entries.length > 0 ? entries.join('\n') : '(empty folder)';
        return {
          phrase: `'${relPath}' (see below for folder content)`,
          block: `<folder_content path="${escapeAttr(relPath)}">\n${clipBlock(listing, maxCharsPerBlock)}\n</folder_content>`
        };
      }
      if (!sources.readFile) return null;
      const content = await sources.readFile(relPath);
      if (content === null || content === undefined) return null;
      return {
        phrase: `'${relPath}' (see below for file content)`,
        block: `<file_content path="${escapeAttr(relPath)}">\n${content.length > 0 ? clipBlock(content, maxCharsPerBlock) : '(empty file)'}\n</file_content>`
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Expand every resolvable mention in `text`: the matched token is rewritten
 * to a pointer phrase and the fetched payload is appended in tagged blocks
 * below, exactly like cline's parseMentions. Unresolvable and unknown
 * mentions keep their raw text. Resolves each unique token once.
 */
export async function expandContextMentions(
  text: string,
  sources: MentionSources = {},
  options: MentionExpandOptions = {}
): Promise<string> {
  const maxCharsPerBlock = options.maxCharsPerBlock ?? DEFAULT_MAX_CHARS_PER_BLOCK;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const tokens = parseContextMentions(text);
  if (tokens.length === 0) return text;

  const phrases = new Map<string, string>();
  const blocks: string[] = [];
  let used = 0;
  for (const token of tokens) {
    if (used >= maxTotalChars) break;
    const resolved = await resolveMention(token, sources, maxCharsPerBlock);
    if (!resolved) continue;
    phrases.set(token, resolved.phrase);
    blocks.push(resolved.block);
    used += resolved.block.length;
  }
  if (phrases.size === 0) return text;

  const rewritten = text.replace(mentionRegexGlobal, (match, token: string) => phrases.get(token) ?? match);
  return `${rewritten}\n\n${blocks.join('\n\n')}`;
}

// --- ShadRox workspace sources ---------------------------------------------

export interface MentionWorkspaceFile {
  name: string;
  content: string;
}

/** The four bridge calls mentions need; ShadRoxDesktopAPI fits structurally. */
export interface MentionBridgeLike {
  readFile(workspaceId: string, path: string): Promise<{ content: string }>;
  listDirectory(
    workspaceId: string,
    path?: string,
    cursor?: number
  ): Promise<{ entries: Array<{ path: string; kind: 'file' | 'directory' }> }>;
  diagnostics(
    workspaceId: string,
    overrides?: unknown,
    files?: string[]
  ): Promise<{ diagnostics: Array<{ severity: string; file: string; line: number; message: string }>; truncated?: boolean }>;
  gitRead(workspaceId: string): Promise<{ isRepo: boolean; status: string; diff: string }>;
}

export interface MentionSourceContext {
  files: MentionWorkspaceFile[];
  bridge?: MentionBridgeLike | null;
  workspaceId?: string | null;
}

/** './a/b' and 'C:\a\b' both become 'a/b'-style workspace-relative paths. */
function normalizeMentionPath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

export function createWorkspaceMentionSources(context: MentionSourceContext): MentionSources {
  const { files, bridge, workspaceId } = context;
  const hasBridge = Boolean(bridge && workspaceId);
  return {
    readFile: async (path) => {
      const rel = normalizeMentionPath(path);
      // Live editor buffers win over disk: the user mentions what they see.
      const live = files.find((file) => file.name.toLowerCase() === rel.toLowerCase());
      if (live) return live.content;
      if (!bridge || !workspaceId) return null;
      try {
        const file = await bridge.readFile(workspaceId, rel);
        return file.content;
      } catch {
        return null;
      }
    },
    listDirectory: async (path) => {
      const rel = normalizeMentionPath(path).replace(/\/$/, '');
      const prefix = rel ? `${rel}/` : '';
      if (bridge && workspaceId) {
        try {
          const page = await bridge.listDirectory(workspaceId, rel);
          return page.entries.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path));
        } catch {
          // fall through to the buffer-derived listing below
        }
      }
      const children = new Set<string>();
      for (const file of files) {
        const name = file.name.startsWith('./') ? file.name.slice(2) : file.name;
        if (!name.toLowerCase().startsWith(prefix.toLowerCase()) || name.length <= prefix.length) continue;
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf('/');
        children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (children.size === 0) return null;
      return [...children].sort((a, b) => a.localeCompare(b));
    },
    problems: hasBridge
      ? async () => {
          const result = await bridge!.diagnostics(workspaceId as string, undefined, undefined);
          if (result.diagnostics.length === 0) return 'No compiler problems reported.';
          const lines = result.diagnostics.slice(0, 200).map((diagnostic) =>
            `${diagnostic.severity} ${diagnostic.file}:${diagnostic.line + 1} ${diagnostic.message}`);
          return `${result.diagnostics.length} problem(s)${result.truncated ? ' (list truncated)' : ''}\n${lines.join('\n')}`;
        }
      : undefined,
    gitChanges: hasBridge
      ? async () => {
          const status = await bridge!.gitRead(workspaceId as string);
          if (!status.isRepo) return 'This folder is not a git repository.';
          return `status:\n${status.status}\n\ndiff:\n${status.diff}`;
        }
      : undefined
  };
}

/**
 * The chat-side entry: expand mentions against the live workspace. The
 * message the user reads keeps the raw typed text; only the turn handed to
 * the model is expanded.
 */
export async function expandChatMentions(text: string, context: MentionSourceContext): Promise<string> {
  if (!text.includes('@')) return text;
  return expandContextMentions(text, createWorkspaceMentionSources(context));
}
