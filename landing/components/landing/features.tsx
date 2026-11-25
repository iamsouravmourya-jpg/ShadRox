'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  MessagesSquare, FileCode2, SearchCode, Command,
  Eye, Terminal, GitBranch, Replace, History, ArrowRight,
  Image as ImageIcon, Save, Check, X
} from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

type Feature = {
  icon: typeof MessagesSquare
  title: string
  text: string
  wide?: 'from-md' | 'from-lg'
  visual?: ReactNode
}

const mono = 'font-mono text-[11px]'

const features: Feature[] = [
  {
    icon: MessagesSquare,
    title: 'AI chat & autonomous queue',
    text: 'Use Gemini, Groq, or any OpenAI-compatible endpoint (including Ollama and LM Studio) with your own BYOK key. Queue follow-up messages while a turn runs, review proposed diffs before applying, and escalate multi-file goals to verified milestones.',
    wide: 'from-md',
    visual: (
      <div className="mt-6 grid max-w-[280px] gap-1.5 sm:mt-0">
        <div className="justify-self-end rounded-xl rounded-br-md bg-[var(--ac)] px-3 py-2 text-[12px] font-semibold text-white">
          Add a loading state
        </div>
        <div className={`rounded-xl rounded-bl-md bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-400 ${mono}`}>{'- ready={ready}'}</div>
        <div className={`rounded-xl rounded-bl-md bg-emerald-500/10 px-3 py-2 text-emerald-700 dark:text-emerald-400 ${mono}`}>{'+ loading={!ready}'}</div>
      </div>
    ),
  },
  {
    icon: ImageIcon,
    title: 'Paste screenshots · Ctrl+V',
    text: 'Drop or paste an image straight into chat with Ctrl+V. ShadRox attaches the screenshot to your message so the agent can read UI bugs and mockups visually.',
  },
  {
    icon: FileCode2,
    title: 'Editor & Markdown',
    text: 'CodeMirror 6 with split editor groups, pinned and reorderable tabs, quick open, file outline, inline AI completions, and a one-click Markdown source/preview toggle.',
  },
  {
    icon: SearchCode,
    title: 'Code navigation',
    text: 'TypeScript diagnostics, go-to-definition, find references, rename symbols, quick fixes, semantic highlighting, and workspace symbol search.',
  },
  {
    icon: Command,
    title: 'Palette & Ctrl+K',
    text: 'Fuzzy-find files, workspace symbols, and commands from one palette. Select any code and press Ctrl+K for an inline AI edit with ghost-text completions.',
  },
  {
    icon: Eye,
    title: 'Local preview + console',
    text: 'Preview static sites, Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, and Node projects with runtime error capture, console error forwarding, and click-to-source jump.',
  },
  {
    icon: Terminal,
    title: 'Parallel terminals',
    text: 'Run two terminal sessions side by side with resizable split panes rooted in your workspace. Assistant-initiated commands use a separate risk-tiered approval gate.',
  },
  {
    icon: GitBranch,
    title: 'Source control',
    text: 'Inspect staged and unstaged changes with inline diffs, then Git Push, Pull, or Sync and commit with AI-generated messages.',
    wide: 'from-md',
  },
  {
    icon: Replace,
    title: 'Search & replace',
    text: 'Search files on disk and in open buffers with case-sensitive, whole-word, or regex controls, and replace selected or all occurrences.',
  },
  {
    icon: Save,
    title: 'Accept/Reject bar with Auto-Save',
    text: 'Cursor-style Accept/Reject bar shows every file change inline. Toggle Auto-Save ON to apply instantly, or OFF to review each diff before it hits disk.',
    wide: 'from-md',
    visual: (
      <div className="mt-6 grid max-w-[280px] gap-1.5 sm:mt-0">
        <div className="rounded-xl border border-line bg-base p-2.5 text-[11px] font-mono">
          <div className="flex items-center gap-2 text-ok">
            <Check className="h-3 w-3" /> Accept src/App.tsx
          </div>
          <div className="flex items-center gap-2 text-danger mt-1">
            <X className="h-3 w-3" /> Skip src/utils.ts
          </div>
          <div className="flex items-center gap-2 text-accent mt-1">
            <Save className="h-3 w-3" /> Auto-Save: ON
          </div>
        </div>
      </div>
    ),
  },
  {
    icon: History,
    title: 'Signed edit receipts',
    text: 'Every agent mutation is recorded in a hash-chained local proof ledger with atomic rollback support if an experiment goes sideways.',
  },
]

export function Features() {
  return (
    <section id="features" className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-28">
      <div className="container-page">
        <Reveal>
          <p className="eyebrow mb-3 text-center">
            Everything in one place
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(1.875rem,3.8vw,3.25rem)] font-bold leading-[1.08] tracking-[-0.04em] text-[var(--ink)]">
            Stop switching windows.{' '}
            <em className="font-normal italic text-[var(--ac)]">Start shipping.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-14 max-w-[620px] text-center text-base leading-7 text-[var(--mut)]">
            Editor, a unified autonomous AI agent, live preview, Git tools,
            and parallel terminals live side by side in one local-first workspace.
          </p>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text, wide, visual }, i) => (
            <Reveal
              key={title}
              as="article"
              delay={(i % 3) * 80}
              className={cn(
                'h-full',
                wide === 'from-md' && 'md:col-span-2',
                wide === 'from-lg' && 'lg:col-span-2',
              )}
            >
              <div className="feature-card flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                <div className={cn('flex h-full flex-col', wide === 'from-md' && 'sm:flex-row sm:items-center sm:gap-8')}>
                  <div className="min-w-0 flex-1">
                    <span className="grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                      <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                    </span>
                    <h3 className="mt-5 text-[16px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                      {title}
                    </h3>
                    <p className="mt-2 max-w-[56ch] text-[13.5px] leading-6 text-[var(--mut)]">{text}</p>
                  </div>
                  {visual && <div className="sm:w-[240px] sm:shrink-0">{visual}</div>}
                </div>
              </div>
            </Reveal>
          ))}

          {/* Closing link to full capability sheet */}
          <Reveal delay={80} className="h-full md:col-span-2 lg:col-span-1">
            <Link
              href="/features"
              className="feature-card group flex h-full flex-col justify-between rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-6 sm:p-7"
            >
              <span className="grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--card)]">
                <ArrowRight
                  className="size-5 text-[var(--ac)] transition-transform duration-300 group-hover:translate-x-0.5"
                  strokeWidth={1.75}
                  aria-hidden
                />
              </span>
              <div className="mt-8">
                <h3 className="text-[16px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                  See every capability
                </h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--mut)]">
                  The full, itemised breakdown grouped by how you build.
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ac)]">
                  Browse features
                  <ArrowRight className="size-3.5" aria-hidden />
                </span>
              </div>
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
