import React from 'react';

/**
 * Chat replies come back as markdown, and a model asked for a report answers in
 * tables, bold verdicts and numbered steps. Rendering only whole lines left the
 * user reading `**risk:**` and `|---|---|` as literal text — the answer looked
 * like noise, which reads as the model being bad even when it is right. So this
 * renderer covers the inline marks and tables, and nothing else: no HTML is
 * ever emitted, and a link is only a link when it starts with http(s).
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'link'; label: string; href: string };

/**
 * `*italic*` is deliberately absent: `*` is also the bullet marker, and
 * `_…_` would italicise the underscores inside every snake_case path.
 */
const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

/** Splits one line into styled runs, keeping the plain text between them. */
export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: 'text', value: line.slice(cursor, start) });
    const raw = match[0];
    if (raw.startsWith('`')) tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    else if (raw.startsWith('**')) tokens.push({ kind: 'bold', value: raw.slice(2, -2) });
    else {
      const close = raw.indexOf('](');
      tokens.push({ kind: 'link', label: raw.slice(1, close), href: raw.slice(close + 2, -1) });
    }
    cursor = start + raw.length;
  }
  if (cursor < line.length) tokens.push({ kind: 'text', value: line.slice(cursor) });
  return tokens;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; index: number; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'space' }
  | { kind: 'paragraph'; text: string };

function splitTableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

/** True for the `|---|:--:|` line that separates a table header from its rows. */
function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      if (code.length > 0) blocks.push({ kind: 'code', lines: code });
      continue;
    }

    const heading = /^(#{1,3}) (.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({ kind: 'bullet', text: trimmed.slice(2) });
      index += 1;
      continue;
    }

    const ordered = /^(\d{1,3})[.)] (.*)$/.exec(trimmed);
    if (ordered) {
      blocks.push({ kind: 'ordered', index: Number(ordered[1]), text: ordered[2] });
      index += 1;
      continue;
    }

    // A table is a `|` row followed by a divider row; anything else that starts
    // with a pipe is prose and stays a paragraph.
    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index].trim()));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    if (!trimmed) {
      blocks.push({ kind: 'space' });
      index += 1;
      continue;
    }

    blocks.push({ kind: 'paragraph', text: line });
    index += 1;
  }

  return blocks;
}

function inlineNodes(tokens: InlineToken[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((token, position) => {
    const key = `${keyPrefix}-${position}`;
    if (token.kind === 'code') {
      return (
        <code key={key} className="bg-neutral-800 text-violet-200 rounded px-1 py-px font-mono text-[11px]">
          {token.value}
        </code>
      );
    }
    if (token.kind === 'bold') {
      return (
        <strong key={key} className="font-semibold text-neutral-100">
          {token.value}
        </strong>
      );
    }
    if (token.kind === 'link') {
      return (
        <a key={key} href={token.href} target="_blank" rel="noreferrer" className="text-violet-300 underline">
          {token.label}
        </a>
      );
    }
    return <React.Fragment key={key}>{token.value}</React.Fragment>;
  });
}

/** Handles headings, bullet and numbered lists, tables, fenced code and inline marks. */
export function renderMarkdownContent(content: string): React.ReactNode {
  const blocks = parseMarkdownBlocks(content).map((block, idx) => {
    if (block.kind === 'space') return <div key={idx} className="h-1" />;

    if (block.kind === 'code') {
      return (
        <pre
          key={idx}
          className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 overflow-x-auto text-[11px] leading-relaxed text-neutral-200 font-mono"
        >
          <code>{block.lines.join('\n')}</code>
        </pre>
      );
    }

    if (block.kind === 'heading') {
      const text = inlineNodes(parseInline(block.text), `h-${idx}`);
      if (block.level === 1) {
        return (
          <h1 key={idx} className="text-base font-bold text-white border-b border-neutral-800 pb-1">
            {text}
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2 key={idx} className="text-sm font-semibold text-violet-300">
            {text}
          </h2>
        );
      }
      return (
        <h3 key={idx} className="text-xs font-semibold text-neutral-200">
          {text}
        </h3>
      );
    }

    if (block.kind === 'bullet') {
      return (
        <div key={idx} className="flex items-start gap-2 pl-1 text-neutral-300">
          <span className="text-violet-300 font-bold">•</span>
          <span>{inlineNodes(parseInline(block.text), `b-${idx}`)}</span>
        </div>
      );
    }

    if (block.kind === 'ordered') {
      return (
        <div key={idx} className="flex items-start gap-2 pl-1 text-neutral-300">
          <span className="text-violet-300 font-mono text-[11px] tabular-nums pt-px">{block.index}.</span>
          <span>{inlineNodes(parseInline(block.text), `o-${idx}`)}</span>
        </div>
      );
    }

    if (block.kind === 'table') {
      return (
        <div key={idx} className="overflow-x-auto border border-neutral-800 rounded-lg">
          <table className="w-full text-[11px] leading-relaxed border-collapse">
            <thead>
              <tr className="bg-neutral-900 text-neutral-200">
                {block.header.map((cell, column) => (
                  <th key={column} className="text-left font-semibold px-2 py-1 border-b border-neutral-800">
                    {inlineNodes(parseInline(cell), `th-${idx}-${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="text-neutral-300">
                  {row.map((cell, column) => (
                    <td key={column} className="px-2 py-1 align-top border-b border-neutral-900">
                      {inlineNodes(parseInline(cell), `td-${idx}-${rowIdx}-${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <p key={idx} className="text-neutral-300 leading-relaxed">
        {inlineNodes(parseInline(block.text), `p-${idx}`)}
      </p>
    );
  });

  return <div className="space-y-1.5 font-sans text-xs break-words">{blocks}</div>;
}

/** A deliberate full-file rewrite requested by the model. */
export interface FilePatch {
  path: string;
  content: string;
}

/** The files the user currently has open. Used to resolve where a block belongs. */
export interface KnownFile {
  name: string;
  content: string;
  language?: string;
}

export interface PatchScan {
  patches: FilePatch[];
  /** Code blocks that carried real code but had no resolvable file target. */
  unmapped: number;
}

const FENCE_ALIASES: Record<string, string[]> = {
  ts: ['ts', 'typescript'],
  tsx: ['tsx', 'typescript', 'ts'],
  js: ['js', 'javascript'],
  jsx: ['jsx', 'javascript', 'js'],
  mjs: ['js', 'javascript'],
  cjs: ['js', 'javascript'],
  html: ['html', 'htm'],
  css: ['css', 'scss'],
  json: ['json'],
  md: ['md', 'markdown'],
  py: ['py', 'python'],
  sh: ['sh', 'bash', 'shell'],
  yml: ['yml', 'yaml'],
  yaml: ['yaml', 'yml']
};

/** Strips markdown noise (`**`, quotes, bracket wrappers) off a raw token. */
function normalizeToken(token: string): string {
  return token
    .replace(/\\/g, '/')
    .replace(/^[`*"'([{<,;:\s]+/, '')
    .replace(/[`*"')\]}>.,;:\s]+$/, '')
    .replace(/^\.?\/+/, '')
    .toLowerCase();
}

/** Matches a raw token from the reply against the files the user actually has open. */
function findKnownFile(token: string, files: KnownFile[]): string | null {
  const normalized = normalizeToken(token);
  if (!normalized) return null;

  const basename = normalized.split('/').pop() || normalized;
  const hit =
    files.find((file) => file.name.toLowerCase() === normalized) ||
    files.find((file) => (file.name.split('/').pop() || file.name).toLowerCase() === basename);

  return hit ? hit.name : null;
}

function languageMatchesFence(info: string, fileName: string): boolean {
  const tagged = info.trim().toLowerCase();
  if (!tagged) return true;

  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const allowed = FENCE_ALIASES[ext];
  if (!allowed) return true;

  const tags = tagged.split(/\s+/);
  return allowed.some((alias) => tags.includes(alias));
}

/**
 * Works out which open file a code block belongs to.
 *
 * Every signal is checked against the real file names in the workspace, so the
 * assistant can never point a write at a file the user does not have.
 */
export function resolveTarget(info: string, context: string, body: string, files: KnownFile[]): string | null {
  // 1. The model declared the path itself: ```tsx path=src/App.tsx
  const declared = info.match(/(?:path|file|filename|filepath)\s*[:=]\s*["'`]?([^\s"'`]+)/i);
  if (declared) return declared[1];

  // 1b. A quoted name in the info line: ```tsx title="App.tsx"
  const quoted = info.match(/["'`]([^"'`\s]+\.[a-z0-9]{1,5})["'`]/i);
  if (quoted) return quoted[1];

  // 2. A real open file named in the fence info or on the line right above it.
  for (const token of `${info} ${context}`.split(/\s+/)) {
    const known = findKnownFile(token, files);
    if (known) return known;
  }

  // 3. A real open file named in a comment at the top of the block.
  for (const line of body.split('\n').slice(0, 3)) {
    const trimmed = line.trim();
    if (!/^(\/\/|#|\/\*|\*|<!--|--)/.test(trimmed)) continue;
    for (const token of trimmed.split(/\s+/)) {
      const known = findKnownFile(token, files);
      if (known) return known;
    }
  }

  // 4. Only one file open and the block's language fits it — nothing to confuse it with.
  if (files.length === 1 && languageMatchesFence(info, files[0].name)) return files[0].name;

  return null;
}

/**
 * Pulls intended file writes out of an AI reply.
 *
 * A block is only written when it maps onto a real workspace file, so plain
 * examples always stay chat-only.
 */
export function extractFilePatches(content: string, files: KnownFile[] = []): PatchScan {
  const lines = content.split('\n');
  const patches: FilePatch[] = [];
  let unmapped = 0;
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim().startsWith('```')) {
      index += 1;
      continue;
    }

    const info = lines[index].trim().slice(3);
    const bodyLines: string[] = [];
    let close = index + 1;

    while (close < lines.length && !lines[close].trim().startsWith('```')) {
      bodyLines.push(lines[close]);
      close += 1;
    }

    // Unterminated fence means the stream stopped mid-block — never write half a file.
    if (close >= lines.length) break;

    const body = bodyLines.join('\n').replace(/\s+$/, '');

    if (body.trim()) {
      let context = '';
      for (let scan = index - 1; scan >= 0; scan -= 1) {
        if (lines[scan].trim()) {
          context = lines[scan].trim();
          break;
        }
      }

      const target = resolveTarget(info, context, body, files);
      if (target) patches.push({ path: target, content: body });
      else unmapped += 1;
    }

    index = close + 1;
  }

  return { patches, unmapped };
}

/**
 * The chat view of a reply: file writes are replaced by a one-line note.
 *
 * The assistant streams whole files, but those go straight into the editor, so
 * repeating them in the chat is just noise. Blocks that are not tied to a real
 * file (examples) are left exactly as the model wrote them.
 */
export function maskFileWrites(content: string, files: KnownFile[] = []): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim().startsWith('```')) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const info = lines[index].trim().slice(3);
    const bodyLines: string[] = [];
    let close = index + 1;

    while (close < lines.length && !lines[close].trim().startsWith('```')) {
      bodyLines.push(lines[close]);
      close += 1;
    }

    const terminated = close < lines.length;
    const body = bodyLines.join('\n').replace(/\s+$/, '');

    let context = '';
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      if (lines[scan].trim()) {
        context = lines[scan].trim();
        break;
      }
    }

    const target = resolveTarget(info, context, body, files);

    if (target) {
      const known = files.some((file) => file.name === target);
      const hasSearchReplace = body.includes('<<<<<<< ORIGINAL');
      output.push(
        hasSearchReplace
          ? `- ${target} — patched via search/replace, open in code editor`
          : `- ${target} — ${known ? 'updated' : 'created'}, open in code editor`
      );
    } else {
      output.push(lines[index], ...bodyLines);
      if (terminated) output.push(lines[close]);
    }

    // A half-streamed block cannot be judged any further.
    if (!terminated) break;
    index = close + 1;
  }

  return output.join('\n');
}
