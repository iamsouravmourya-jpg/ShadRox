import React from 'react';

/**
 * Minimal dependency-free markdown renderer used for chat replies and .md previews.
 * Handles headings, bullet lists, fenced code blocks and plain paragraphs.
 */
export function renderMarkdownContent(content: string): React.ReactNode {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let codeBuffer: string[] = [];
  let inCodeBlock = false;

  const flushCode = (key: string) => {
    if (codeBuffer.length === 0) return;
    blocks.push(
      <pre
        key={key}
        className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 overflow-x-auto text-[11px] leading-relaxed text-neutral-200 font-mono"
      >
        <code>{codeBuffer.join('\n')}</code>
      </pre>
    );
    codeBuffer = [];
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        flushCode(`code-${idx}`);
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      return;
    }

    if (trimmed.startsWith('# ')) {
      blocks.push(
        <h1 key={idx} className="text-base font-bold text-white border-b border-neutral-800 pb-1">
          {trimmed.slice(2)}
        </h1>
      );
      return;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push(
        <h2 key={idx} className="text-sm font-semibold text-emerald-400">
          {trimmed.slice(3)}
        </h2>
      );
      return;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push(
        <h3 key={idx} className="text-xs font-semibold text-neutral-200">
          {trimmed.slice(4)}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push(
        <div key={idx} className="flex items-start gap-2 pl-1 text-neutral-300">
          <span className="text-emerald-400 font-bold">•</span>
          <span>{trimmed.slice(2)}</span>
        </div>
      );
      return;
    }
    if (!trimmed) {
      blocks.push(<div key={idx} className="h-1" />);
      return;
    }
    blocks.push(
      <p key={idx} className="text-neutral-300 leading-relaxed">
        {line}
      </p>
    );
  });

  flushCode('code-final');

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
function resolveTarget(info: string, context: string, body: string, files: KnownFile[]): string | null {
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
