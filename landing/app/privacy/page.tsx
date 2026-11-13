import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  Cloud,
  Download,
  FileDiff,
  HardDrive,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Privacy } from '@/components/landing/privacy'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'Privacy — ShadRox',
  description:
    'What ShadRox keeps on your computer, what a single AI request sends to your provider, and what the required Google sign-in stores. Local project files, OS-encrypted provider keys and default-deny agent commands.',
  alternates: { canonical: '/privacy' },
}

const eyebrow = 'text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]'
const chip =
  'rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]'

const askFirstExamples = [
  'npm test',
  'pytest',
  'python -m pytest',
  'tsc --noEmit',
  'npx tsc --noEmit',
  'git diff',
  'git status',
]

type Row = { label: string; text: string; chips?: string[] }

const places: {
  icon: typeof HardDrive
  tag: string
  title: string
  lead: string
  rows: Row[]
  note?: string
}[] = [
  {
    icon: HardDrive,
    tag: 'stays local',
    title: 'On your computer',
    lead: 'Everything the app needs to open your project lives on this machine.',
    rows: [
      {
        label: 'Project files',
        text: 'Opened and edited locally. There is no ShadRox cloud project sync — the app works in the folder you pick.',
      },
      {
        label: 'Provider keys',
        text: 'Your Gemini, Groq or compatible key sits in OS-backed encrypted storage on your device.',
      },
      {
        label: 'Rules & workspace settings',
        text: 'Rule files and workspace settings are read from the project folder itself.',
      },
    ],
  },
  {
    icon: Cloud,
    tag: 'per request',
    title: 'Sent to your AI provider',
    lead: 'An AI turn sends the request you made — not your whole disk.',
    rows: [
      {
        label: 'Your prompt',
        text: 'The message you write, sent to the provider configured for that request.',
      },
      {
        label: 'The context you choose',
        text: 'Only the project context you include with that request travels with it.',
      },
      {
        label: 'Their terms apply',
        text: 'AI providers process that data under their own data-handling terms.',
      },
    ],
    note: 'Point ShadRox at Ollama or LM Studio and the prompt stays on your PC.',
  },
  {
    icon: UserRound,
    tag: 'sign-in',
    title: 'ShadRox account',
    lead: 'Google sign-in through Supabase is required to enter the desktop app.',
    rows: [
      {
        label: 'Profile fields',
        text: 'The account record holds these five fields:',
        chips: ['email', 'name', 'avatar URL', 'app version', 'platform'],
      },
      {
        label: 'No password',
        text: 'Google handles the sign-in, so there is no ShadRox password to create.',
      },
      {
        label: 'Your provider key',
        text: 'Never sent to ShadRox. Requests go from your machine straight to the provider.',
      },
    ],
  },
]

const guards: { icon: typeof ShieldCheck; title: string; text: string }[] = [
  {
    icon: ShieldCheck,
    title: 'Shell approval is default-deny',
    text: 'Every agent shell command — including npm test, pytest, tsc --noEmit and Git status/diff — opens a native approval dialog with a plain-language risk notice. The workspace is re-checked between approval and execution.',
  },
  {
    icon: FileDiff,
    title: 'Edits arrive as diffs',
    text: 'File changes go through a patch, review and apply flow. Unsafe patches are held for review instead of written in place, and file notes report the real apply outcome.',
  },
  {
    icon: Trash2,
    title: 'Deleting a path needs proof',
    text: 'Removing a file or folder takes an explicit confirm, followed by a read that proves the path is actually gone.',
  },
]

export default function PrivacyPage() {
  return (
    <PageShell
      eyebrow="Privacy"
      title="Local-first,"
      accent="by design."
      sub="Your project folder is opened and edited on your computer. When you ask AI for help, the prompt and the project context you choose go to the provider you configured — and your provider key never reaches ShadRox."
    >
      <Privacy />

      {/* ── What is stored where ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>The detail</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[720px] text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
              What is stored <em className="font-normal italic text-[var(--ac)]">where.</em>
            </h2>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-5 max-w-[640px] text-pretty text-sm leading-7 text-[var(--mut)]">
              Three places, three different rules. Your files and keys stay on your device, an AI
              request carries only what you put into it, and the account you sign in with holds a
              short profile record.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {places.map(({ icon: Icon, tag, title, lead, rows, note }, i) => (
              <Reveal key={title} as="article" delay={i * 100} variant="scale" className="h-full">
                <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                  <div className="mb-6 flex items-center justify-between gap-3">
                    <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--bg2)]">
                      <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                    </span>
                    <span className={chip}>{tag}</span>
                  </div>

                  <h3 className="text-[19px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="mt-2.5 text-sm leading-6 text-[var(--mut)]">{lead}</p>

                  <ul className="mt-6 space-y-5 border-t border-[var(--line)] pt-6">
                    {rows.map((row) => (
                      <li key={row.label} className="flex gap-3">
                        <span
                          aria-hidden
                          className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]"
                        />
                        <div>
                          <b className="block text-[13px] font-bold text-[var(--ink)]">
                            {row.label}
                          </b>
                          <span className="mt-1 block text-[13px] leading-5 text-[var(--mut)]">
                            {row.text}
                          </span>
                          {row.chips && (
                            <span className="mt-2.5 flex flex-wrap gap-1.5">
                              {row.chips.map((c) => (
                                <code key={c} className={chip}>
                                  {c}
                                </code>
                              ))}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>

                  {note && (
                    <div className="mt-auto pt-6">
                      <p className="flex gap-2.5 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-4 text-[13px] leading-5 text-[var(--ink2)]">
                        <Terminal
                          className="mt-0.5 size-4 shrink-0 text-[var(--ac)]"
                          strokeWidth={1.75}
                        />
                        {note}
                      </p>
                    </div>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Guarded by default ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
            <Reveal>
              <div>
                <p className={`mb-4 ${eyebrow}`}>Agent guardrails</p>
                <h2 className="max-w-sm text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                  Guarded by <em className="font-normal italic text-[var(--ac)]">default.</em>
                </h2>
                <p className="mt-5 max-w-sm text-sm leading-7 text-[var(--mut)]">
                  The agent works inside your opened folder and asks before it acts. Inspection
                  tools are read-only, commands are approval-gated, and edits stay reviewable — so
                  an AI turn cannot quietly rewrite your project.
                </p>
                <p className="mt-4 max-w-sm text-xs leading-5 text-[var(--mut)]">
                  Agent and autonomous workflows are beta. Inspect the results and keep backups of
                  important work.
                </p>
              </div>
            </Reveal>

            <div className="grid gap-4">
              {guards.map(({ icon: Icon, title, text }, i) => (
                <Reveal key={title} delay={i * 90}>
                  <div className="flex gap-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5 transition-all duration-300 hover:translate-x-1.5 hover:border-[var(--ac)] hover:shadow-[4px_0_20px_var(--glow)] sm:p-6">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--bg2)]">
                      <Icon className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
                    </span>
                    <div>
                      <h3 className="mb-1.5 text-sm font-bold text-[var(--ink)]">{title}</h3>
                      <p className="text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>

          {/* Ask-first band */}
          <Reveal delay={120} variant="scale">
            <div className="mt-10 rounded-3xl border border-[var(--line)] bg-[var(--bg2)] p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--card)]">
                  <Terminal className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-[var(--ink)]">Every command asks first</h3>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--mut)]">
                    Even routine verification — nothing runs without your OK.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-1.5 border-t border-[var(--line)] pt-5">
                {askFirstExamples.map((c) => (
                  <code key={c} className={chip}>
                    {c}
                  </code>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-8 sm:p-12">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl"
                style={{ background: 'var(--glow)' }}
              />
              <div className="relative flex flex-col gap-9 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl">
                  <p className={`mb-4 ${eyebrow}`}>Get the beta</p>
                  <h2 className="text-balance text-[clamp(24px,3vw,34px)] font-bold leading-[1.14] tracking-[-0.04em] text-[var(--ink)]">
                    Check it against{' '}
                    <em className="font-normal italic text-[var(--ac)]">your own project.</em>
                  </h2>
                  <p className="mt-4 text-sm leading-7 text-[var(--mut)]">
                    Version {APP_VERSION} for Windows 10 or 11 (64-bit). Free to download — sign in
                    with Google, then connect your own provider key.
                  </p>
                </div>

                <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download for Windows
                  </a>
                  <Link
                    href="/faq"
                    className="group inline-flex items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-6 py-3 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Read the FAQ
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </div>

              <p className="relative mt-8 border-t border-[var(--line)] pt-6 text-xs leading-5 text-[var(--mut)]">
                The Windows build is unsigned, so SmartScreen may warn — verify the download source,
                then choose More → Run anyway.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}