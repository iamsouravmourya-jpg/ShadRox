import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowUpRight,
  Download,
  FileDiff,
  FolderOpen,
  GitCommitHorizontal,
  HardDrive,
  Info,
  KeyRound,
  LogIn,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { HowItWorks } from '@/components/landing/how-it-works'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, GITHUB_REPO, WINDOWS_DOWNLOAD_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'How it works — ShadRox',
  description:
    'From folder to commit: sign in with Google, open a local project, connect your own AI key, review every diff, then run, preview and commit — all inside one Windows app.',
  alternates: { canonical: '/how-it-works' },
}

type SessionStep = {
  icon: LucideIcon
  num: string
  title: string
  text: string
  chips: string[]
}

const sessionSteps: SessionStep[] = [
  {
    icon: LogIn,
    num: '01',
    title: 'Sign in with Google',
    text: 'The first screen opens your browser to continue with Google, then returns you to the app. ShadRox stores only five things about you:',
    chips: ['email', 'name', 'avatar URL', 'app version', 'platform'],
  },
  {
    icon: FolderOpen,
    num: '02',
    title: 'Open a local folder',
    text: 'Choose any project folder on your computer. ShadRox builds a compact repo map and loads your rule files automatically — no cloud sync, no upload. Rule files it picks up:',
    chips: ['.cursorrules', 'AGENTS.md', 'SHADROX.md'],
  },
  {
    icon: KeyRound,
    num: '03',
    title: 'Connect a provider',
    text: 'Add a Gemini, Groq, or OpenAI-compatible key — local runtimes work too, so Ollama and LM Studio can keep inference on your machine. Keys live in OS-backed encrypted storage.',
    chips: ['Gemini', 'Groq', 'OpenAI-compatible', 'Ollama', 'LM Studio'],
  },
  {
    icon: MessagesSquare,
    num: '04',
    title: 'Ask, then review',
    text: 'Chat in plain language, @-mention exactly the context you want included, or select code and press Ctrl+K. Every proposed change arrives as a diff you accept or reject — and follow-ups queue while a turn is still running.',
    chips: ['@file', '@folder', '@problems', '@git-changes', 'Ctrl+K'],
  },
  {
    icon: GitCommitHorizontal,
    num: '05',
    title: 'Run, preview, commit',
    text: 'Launch a detected preview with your approval, use the integrated terminal when you need it, then stage your diffs and commit with an AI-written message.',
    chips: ['terminal', 'stage diffs', 'AI commit message'],
  },
]

const ownership = [
  {
    icon: HardDrive,
    title: 'Files on your disk',
    text: 'Your project is a plain folder. ShadRox reads and edits it in place — no cloud copy, no sync.',
  },
  {
    icon: KeyRound,
    title: 'Keys on your device',
    text: 'Provider keys live in OS-backed encrypted storage and are used only to call the provider you chose.',
  },
  {
    icon: FileDiff,
    title: 'Every edit reviewable',
    text: 'AI changes arrive as diffs. Nothing lands in your files until you accept it.',
  },
]

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
      {children}
    </span>
  )
}

export default function HowItWorksPage() {
  return (
    <PageShell
      eyebrow="How it works"
      title="From folder"
      accent="to commit."
      sub="ShadRox is a local-first workspace for Windows. Open a project folder, bring your own AI key, and stay in control of every change — here is the whole path, from first sign-in to your first commit."
    >
      <HowItWorks />

      {/* ── Your first session: the deeper walkthrough ─────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr] lg:gap-20">
            {/* Sticky intro */}
            <div className="lg:sticky lg:top-28 lg:self-start">
              <Reveal>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Your first session
                </p>
              </Reveal>
              <Reveal delay={80}>
                <h2 className="text-[clamp(28px,3.5vw,42px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                  Five steps,{' '}
                  <em className="font-normal italic text-[var(--ac)]">start to finish.</em>
                </h2>
              </Reveal>
              <Reveal delay={160}>
                <p className="mt-5 max-w-sm text-sm leading-7 text-[var(--mut)]">
                  The flow above is the shape of it. Here is what actually happens at each
                  step — what ShadRox stores, what it loads, and where you stay in the loop.
                </p>
              </Reveal>
              <Reveal delay={240}>
                <div className="mt-7 flex flex-wrap items-center gap-2">
                  <Chip>{`v${APP_VERSION}`}</Chip>
                  <Chip>Windows 10 / 11 · 64-bit</Chip>
                </div>
              </Reveal>
            </div>

            {/* Step cards */}
            <div className="flex flex-col gap-5">
              {sessionSteps.map(({ icon: Icon, num, title, text, chips }, i) => (
                <Reveal key={num} delay={i * 80}>
                  <article className="feature-card rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                    <div className="flex items-start gap-4 sm:gap-5">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,var(--ac),var(--pink))] font-mono text-xs font-bold text-white shadow-[0_6px_18px_var(--glow)]">
                        {num}
                      </span>
                      <div className="min-w-0">
                        <div className="mb-2 flex items-center gap-2">
                          <Icon className="size-4 shrink-0 text-[var(--ac)] opacity-80" strokeWidth={1.75} />
                          <h3 className="text-base font-bold text-[var(--ink)]">{title}</h3>
                        </div>
                        <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {chips.map((c) => (
                            <Chip key={c}>{c}</Chip>
                          ))}
                        </div>
                      </div>
                    </div>
                  </article>
                </Reveal>
              ))}

              <Reveal delay={120}>
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] px-5 py-4">
                  <Info className="mt-0.5 size-4 shrink-0 text-[var(--ac)]" strokeWidth={1.75} />
                  <p className="text-xs leading-5 text-[var(--mut)]">
                    Your prompt and the context you attach are sent to the AI provider you
                    connect — that is how the model sees your code. Your files and keys are
                    not uploaded.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ── What stays yours ───────────────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
              Local-first
            </p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mx-auto mb-10 max-w-[640px] text-center text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
              What stays <em className="font-normal italic text-[var(--ac)]">yours.</em>
            </h2>
          </Reveal>

          <div className="grid gap-5 md:grid-cols-3">
            {ownership.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 100}>
                <div className="feature-card h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                  <span className="mb-5 grid size-11 place-items-center rounded-2xl border border-[var(--line)] bg-[var(--bg2)] text-[var(--ac)]">
                    <Icon className="size-5" strokeWidth={1.75} />
                  </span>
                  <h3 className="mb-2 font-bold text-[var(--ink)]">{title}</h3>
                  <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <p className="mx-auto mt-8 max-w-[620px] text-center text-xs leading-5 text-[var(--mut)]">
              The prompt and the context you choose go to your AI provider — files and keys
              do not.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── CTA band ───────────────────────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] px-6 py-12 text-center sm:px-12 sm:py-16">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-36 left-1/2 size-[440px] -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
              />
              <div className="relative">
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Ready when you are
                </p>
                <h2 className="mx-auto max-w-[560px] text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                  Try it on{' '}
                  <em className="font-normal italic text-[var(--ac)]">your own project.</em>
                </h2>
                <p className="mx-auto mt-4 max-w-[520px] text-sm leading-7 text-[var(--mut)]">
                  Free download for Windows 10 and 11 (64-bit), version {APP_VERSION}. Sign in
                  with Google, open a folder, connect your key — your first session starts
                  right here.
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download for Windows
                  </a>
                  <Link
                    href="/agent"
                    className="group inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-6 py-3 text-sm font-bold text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--ac)]"
                  >
                    Meet the agent
                    <ArrowRight className="size-4 text-[var(--ac)] transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>

                <p className="mt-5 text-xs leading-5 text-[var(--mut)]">
                  Windows may warn about an unsigned installer — More → Run anyway.{' '}
                  <a
                    href={GITHUB_REPO}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-semibold text-[var(--ac)] transition hover:opacity-80"
                  >
                    View the source
                    <ArrowUpRight className="size-3" />
                  </a>
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}