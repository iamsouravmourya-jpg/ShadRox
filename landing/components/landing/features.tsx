'use client'

import type { MouseEvent, ReactNode } from 'react'
import {
  MessagesSquare, FileCode2, SearchCode, Command,
  Eye, Terminal, GitBranch, Replace, History,
} from 'lucide-react'
import { Reveal } from './reveal'

type Feature = {
  icon: typeof MessagesSquare
  title: string
  text: string
  span?: 4 | 3 | 2
  visual?: ReactNode
}

const mono = 'font-mono text-[11px]'

const features: Feature[] = [
  {
    icon: MessagesSquare,
    title: 'AI chat & queue',
    text: 'Use Gemini, Groq or any OpenAI-compatible endpoint with your own BYOK key. Queue follow-up messages while a turn is running, review proposed diffs before applying, and dictate prompts by voice. File notes report the real apply outcome, and long code blocks stay collapsed until you open them.',
    span: 4,
    visual: (
      <div className="mt-5 grid gap-2 text-xs">
        <div className="justify-self-end rounded-xl bg-[var(--ac)] px-3 py-2 font-semibold text-white">Add a loading state</div>
        <div className={`rounded-xl bg-red-500/10 px-3 py-2 text-red-600 dark:text-red-400 ${mono}`}>{'- ready={ready}'}</div>
        <div className={`rounded-xl bg-emerald-500/10 px-3 py-2 text-emerald-700 dark:text-emerald-400 ${mono}`}>{'+ loading={!ready}'}</div>
      </div>
    ),
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
    text: 'Fuzzy-find files, workspace symbols and commands from one palette. Select any code and press Ctrl+K for an inline AI edit with ghost-text completions.',
  },
  {
    icon: Eye,
    title: 'Local preview',
    text: 'Preview static sites, Vite, Next.js, Nuxt, Astro, Angular, SvelteKit and Node-based projects, plus detected Python, Go, PHP, Java and .NET backends.',
  },
  {
    icon: Terminal,
    title: 'Integrated terminal',
    text: 'Multiple terminal sessions with resizable split panes rooted in your workspace. Assistant-initiated commands use a separate approval-gated path.',
  },
  {
    icon: GitBranch,
    title: 'Source control',
    text: 'Inspect staged and unstaged changes, preview diffs, stage or unstage, switch branches, resolve conflicts, and commit with AI-generated messages.',
    span: 4,
    visual: (
      <div className="mt-5 grid gap-2 text-xs">
        <div className={`rounded-xl bg-emerald-500/10 px-3 py-2 font-semibold text-emerald-700 dark:text-emerald-400 ${mono}`}>✓ 3 files staged</div>
        <div className="rounded-xl bg-[var(--bg2)] px-3 py-2 text-[var(--mut)]">feat: add loading state to App</div>
      </div>
    ),
  },
  {
    icon: Replace,
    title: 'Search & replace',
    text: 'Search files on disk and in open buffers, review every match, and replace selected or all occurrences.',
    span: 3,
  },
  {
    icon: History,
    title: 'Checkpoints',
    text: 'Review assistant checkpoints and restore earlier workspace content when an experiment goes sideways.',
    span: 3,
  },
]

function trackGlow(e: MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--x', `${e.clientX - rect.left}px`)
  e.currentTarget.style.setProperty('--y', `${e.clientY - rect.top}px`)
}

export function Features() {
  return (
    <section id="features" className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--ac)]">
            Everything in one place
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(32px,5vw,58px)] font-bold tracking-[-0.04em] leading-[1.08] text-[var(--ink)]">
            Stop switching windows.{' '}
            <em className="font-normal italic text-[var(--ac)]">Start shipping.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-14 max-w-[600px] text-center text-[var(--mut)] text-base leading-7">
            Editor, AI chat, preview, Git tools and terminal live side by side — writing,
            reviewing, running and committing stay in one flow.
          </p>
        </Reveal>

        <div className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-6">
          {features.map(({ icon: Icon, title, text, span = 2, visual }, i) => (
            <Reveal
              key={title}
              as="article"
              delay={(i % 3) * 90}
              className={
                span === 4 ? 'md:col-span-2 lg:col-span-4' :
                span === 3 ? 'lg:col-span-3' : 'lg:col-span-2'
              }
            >
              <div
                onMouseMove={trackGlow}
                className="group relative h-full overflow-hidden rounded-[26px] border border-[var(--line)] bg-[var(--card)] p-6 sm:p-[30px] feature-card"
              >
                {/* cursor spotlight */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{
                    background:
                      'radial-gradient(380px circle at var(--x,50%) var(--y,50%), var(--glow), transparent 60%)',
                  }}
                />
                <div className="relative">
                  <span className="mb-5 grid size-[46px] place-items-center rounded-[14px] bg-[var(--bg2)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:-rotate-6 motion-safe:group-hover:scale-110">
                    <Icon className="size-[22px] text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="mb-2 text-[17px] font-bold text-[var(--ink)] leading-snug">{title}</h3>
                  <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                  {visual}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
