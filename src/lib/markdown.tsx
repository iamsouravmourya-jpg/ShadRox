import React from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';

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
  | { kind: 'code'; lines: string[]; lang?: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
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
      const info = trimmed.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      if (code.length > 0) {
        // Only a bare language tag is a language; `path=src/a.ts` style info
        // lines belong to the patch extractor, not to a label.
        const tag = info.split(/\s+/)[0]?.toLowerCase() ?? '';
        if (/^[a-z0-9+#._-]{1,20}$/.test(tag)) blocks.push({ kind: 'code', lines: code, lang: tag });
        else blocks.push({ kind: 'code', lines: code });
      }
      continue;
    }

    const heading = /^(#{1,3})\s+(.*?)(?:\s+#+)?$/.exec(trimmed);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('+ ')) {
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
        <code
          key={key}
          className="rounded-[5px] border border-white/[0.07] bg-white/[0.06] px-1.5 py-px font-mono text-[10.5px] text-violet-200"
        >
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
        <a
          key={key}
          href={token.href}
          target="_blank"
          rel="noreferrer"
          className="text-violet-300 underline decoration-violet-400/35 underline-offset-2 transition-colors hover:text-violet-200 hover:decoration-violet-300"
        >
          {token.label}
        </a>
      );
    }
    return <React.Fragment key={key}>{token.value}</React.Fragment>;
  });
}

/** Fenced block with a quiet header (language + copy) — like a real editor card.
 * Long blocks start collapsed so one reply does not turn into a wall of code. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = React.useState(false);
  const lineCount = code.split('\n').length;
  const [open, setOpen] = React.useState(lineCount <= 10);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-ink-950/80">
      <div className="flex items-center justify-between gap-2 bg-white/[0.025] px-2.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          title={open ? 'Collapse this block' : 'Expand this block'}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer"
        >
          <ChevronRight className={`size-2.5 shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">{lang ?? 'code'}</span>
          <span className="font-mono text-[9px] text-neutral-600">{lineCount} line{lineCount === 1 ? '' : 's'}</span>
        </button>
        <button
          type="button"
          onClick={copy}
          title="Copy this block"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-neutral-200 cursor-pointer"
        >
          {copied ? <Check className="size-2.5 text-emerald-400" /> : <Copy className="size-2.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {open && (
        <pre className="overflow-x-auto border-t border-white/[0.05] p-3 font-mono text-[11.5px] leading-relaxed text-neutral-200">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** Handles headings, lists, tables, quotes, rules, fenced code and inline marks. */
export function renderMarkdownContent(content: string): React.ReactNode {
  const blocks = parseMarkdownBlocks(content).map((block, idx) => {
    if (block.kind === 'space') return null;

    if (block.kind === 'code') {
      return <div key={idx} className="mt-2.5"><CodeBlock code={block.lines.join('\n')} lang={block.lang} /></div>;
    }

    if (block.kind === 'heading') {
      const text = inlineNodes(parseInline(block.text), `h-${idx}`);
      if (block.level === 1) {
        return (
          <h1 key={idx} className="mt-4 border-b border-white/[0.07] pb-1.5 text-[15px] font-semibold tracking-tight text-white">
            {text}
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2 key={idx} className="mt-3.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight text-neutral-100">
            <span className="h-3 w-[2px] shrink-0 rounded-full bg-gradient-to-b from-violet-400 to-indigo-400" />
            {text}
          </h2>
        );
      }
      return (
        <h3 key={idx} className="mt-3 text-[12.5px] font-semibold text-neutral-200">
          {text}
        </h3>
      );
    }

    if (block.kind === 'rule') {
      return <div key={idx} className="my-3.5 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent" />;
    }

    if (block.kind === 'quote') {
      return (
        <blockquote
          key={idx}
          className="mt-2.5 rounded-r-lg border-l-2 border-violet-400/35 bg-white/[0.025] py-1.5 pl-3 pr-2.5 text-neutral-400"
        >
          {inlineNodes(parseInline(block.text), `q-${idx}`)}
        </blockquote>
      );
    }

    if (block.kind === 'bullet') {
      return (
        <div key={idx} className="mt-1.5 flex items-start gap-2.5">
          <span className="mt-[7px] size-1 shrink-0 rounded-full bg-violet-400/80" />
          <span className="min-w-0 flex-1">{inlineNodes(parseInline(block.text), `b-${idx}`)}</span>
        </div>
      );
    }

    if (block.kind === 'ordered') {
      return (
        <div key={idx} className="mt-1.5 flex items-start gap-2.5">
          <span className="w-4 shrink-0 pt-px text-right font-mono text-[10.5px] tabular-nums text-violet-300/90">
            {block.index}
          </span>
          <span className="min-w-0 flex-1">{inlineNodes(parseInline(block.text), `o-${idx}`)}</span>
        </div>
      );
    }

    if (block.kind === 'table') {
      return (
        <div key={idx} className="mt-2.5 overflow-x-auto rounded-xl border border-white/[0.07]">
          <table className="w-full border-collapse text-[11px] leading-relaxed">
            <thead>
              <tr className="bg-white/[0.035]">
                {block.header.map((cell, column) => (
                  <th
                    key={column}
                    className="border-b border-white/[0.07] px-2.5 py-1.5 text-left text-[9.5px] font-semibold uppercase tracking-wider text-neutral-400"
                  >
                    {inlineNodes(parseInline(cell), `th-${idx}-${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {block.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="text-neutral-300 transition-colors hover:bg-white/[0.02]">
                  {row.map((cell, column) => (
                    <td key={column} className="px-2.5 py-1.5 align-top">
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
      <p key={idx} className="mt-2 text-neutral-300">
        {inlineNodes(parseInline(block.text), `p-${idx}`)}
      </p>
    );
  });

  return (
    <div className="break-words font-sans text-[12.5px] leading-[1.7] text-neutral-300 [&>*:first-child]:mt-0">
      {blocks}
    </div>
  );
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
 * What actually happened to a proposed file write. The chat bullet must say
 * this, never what the reply's shape merely suggests — a streamed block that
 * was dropped or refused is "not applied", not "patched".
 */
export type PatchWriteOutcome =
  | 'streaming'
  | 'applied'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'reverted'
  | 'unapplied'
  | 'historic';

export type PatchOutcomeLookup = (path: string) => PatchWriteOutcome;

/**
 * The chat view of a reply: file writes are replaced by a one-line note.
 *
 * The assistant streams whole files, but those go straight into the editor, so
 * repeating them in the chat is just noise. Blocks that are not tied to a real
 * file (examples) are left exactly as the model wrote them.
 *
 * The note's wording comes from the apply outcome when the caller supplies it;
 * without one it defaults to "not applied", because a bullet is not proof that
 * anything landed.
 */
export function maskFileWrites(content: string, files: KnownFile[] = [], outcome?: PatchOutcomeLookup): string {
  const lines = content.split('\n');
  const output: string[] = [];
  const masked = new Set<string>();
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
      const key = target.toLowerCase();
      // Two fences for one path are two edits, not two files: the Changes list
      // already shows both, so a second bullet would only read as a duplicate.
      if (!masked.has(key)) {
        masked.add(key);
        const state = outcome ? outcome(target) : 'unapplied';
        const label =
          state === 'applied'
            ? 'change applied'
            : state === 'pending'
              ? 'change awaiting review'
              : state === 'failed'
                ? 'not applied — see Changes below'
                : state === 'skipped'
                  ? 'change skipped'
                  : state === 'reverted'
                    ? 'change reverted'
                    : state === 'streaming'
                      ? 'writing change…'
                      : state === 'historic'
                        ? 'change from an earlier session'
                        : 'not applied';
        output.push(`- ${target} — ${label}`);
      }
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
