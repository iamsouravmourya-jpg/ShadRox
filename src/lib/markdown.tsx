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

/** Extracts the first fenced code block from an AI reply (used for patch apply). */
export function extractFirstCodeBlock(content: string): string | null {
  const match = content.match(/```(?:[\w+-]*)\s*\n?([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}
