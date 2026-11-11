'use client'

import { useState } from 'react'
import { Code, Eye, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

type View = 'preview' | 'source'

const sourceLines = [
  '# ShadRox',
  '',
  'A desktop workspace for the projects',
  'on your computer.',
  '',
  '- Editor, AI chat, preview, Git and terminal',
  '- Bring your own provider key',
  '- Preview asks before it installs or runs',
  '',
  '[shadrox.cyou](https://www.shadrox.cyou)',
]

function sourceLineClass(line: string) {
  if (line.startsWith('# ')) return 'font-bold text-[var(--ink)]'
  if (line.startsWith('- ')) return 'text-[var(--ink2)]'
  if (line.startsWith('[')) return 'text-[var(--ac)]'
  return 'text-[var(--mut)]'
}

/**
 * Illustration of the Markdown Preview / Source toggle that sits beside the
 * file name in the editor. Static content, real interaction.
 */
export function MarkdownToggleDemo() {
  const [view, setView] = useState<View>('preview')

  const tabClass = (active: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all duration-300',
      active
        ? 'bg-[linear-gradient(110deg,var(--ac),var(--pink))] text-white shadow-[0_6px_16px_var(--glow)]'
        : 'text-[var(--mut)] hover:bg-[var(--card)] hover:text-[var(--ink)]',
    )

  return (
    <div>
      <div className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] shadow-[0_18px_44px_var(--shadow)]">
        {/* File bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] bg-[var(--bg2)] px-4 py-3 sm:px-5">
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-[var(--line)]" />
            <span className="size-2.5 rounded-full bg-[var(--line)]" />
            <span className="size-2.5 rounded-full bg-[var(--line)]" />
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] text-[var(--ink2)]">
            <FileText className="size-3.5 text-[var(--ac)]" strokeWidth={1.75} />
            README.md
          </span>
          <div
            role="group"
            aria-label="Markdown view"
            className="ml-auto flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg)] p-1"
          >
            <button
              type="button"
              aria-pressed={view === 'preview'}
              onClick={() => setView('preview')}
              className={tabClass(view === 'preview')}
            >
              <Eye className="size-3.5" strokeWidth={2} />
              Preview
            </button>
            <button
              type="button"
              aria-pressed={view === 'source'}
              onClick={() => setView('source')}
              className={tabClass(view === 'source')}
            >
              <Code className="size-3.5" strokeWidth={2} />
              Source
            </button>
          </div>
        </div>

        {/* Document body */}
        <div
          key={view}
          className="min-h-[268px] px-5 py-6 sm:px-7"
          style={{ animation: 'slide-down .35s cubic-bezier(.22,1,.36,1)' }}
        >
          {view === 'preview' ? (
            <div className="max-w-[440px]">
              <h4 className="text-[22px] font-bold tracking-[-0.03em] text-[var(--ink)]">
                ShadRox
              </h4>
              <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">
                A desktop workspace for the projects on your computer.
              </p>
              <ul className="mt-4 space-y-2.5">
                {[
                  'Editor, AI chat, preview, Git and terminal',
                  'Bring your own provider key',
                  'Preview asks before it installs or runs',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 text-[13px] leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[13px] font-semibold text-[var(--ac)] underline underline-offset-4">
                shadrox.cyou
              </p>
            </div>
          ) : (
            <div className="font-mono text-[12px] leading-6">
              {sourceLines.map((line, i) => (
                <div key={`${i}-${line}`} className="flex gap-4">
                  <span className="w-4 shrink-0 select-none text-right text-[var(--mut)] opacity-60">
                    {i + 1}
                  </span>
                  <span className={cn('min-w-0 break-words', sourceLineClass(line))}>
                    {line === '' ? ' ' : line}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-center text-[11px] leading-5 text-[var(--mut)]">
        An illustration of the toggle beside the file name — same file, two views.
      </p>
    </div>
  )
}