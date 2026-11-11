import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  Download,
  FileDiff,
  FlaskConical,
  Gauge,
  History,
  Repeat,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { AgentSection } from '@/components/landing/agent-section'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, GITHUB_REPO, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { CommandApprovalDemo } from './command-approval-demo'

export const metadata: Metadata = {
  title: 'The agent — ShadRox',
  description:
    'A bounded, reviewable AI agent: 14 built-in tools, default-deny command approval, honest edit reports and checkpoints that restore files and Git position. Agent, autonomous run and team features are beta.',
  alternates: { canonical: '/agent' },
}

/** The exact verify forms that run without an approval prompt (matched verbatim). */
const ALLOWED_VERIFY_COMMANDS = [
  'npm test',
  'pytest',
  'python -m pytest',
  'tsc --noEmit',
  'npx tsc --noEmit',
  'git diff',
  'git status',
]

type LoopFact = {
  icon: LucideIcon
  value: string | null
  label: string
  sub: string
}

const loopFacts: LoopFact[] = [
  {
    icon: Wrench,
    value: '14',
    label: 'built-in tools',
    sub: 'A fixed toolkit for reading, searching, editing and verifying.',
  },
  {
    icon: Repeat,
    value: '5',
    label: 'tool rounds by default',
    sub: 'The loop is bounded from the start.',
  },
  {
    icon: Gauge,
    value: '6',
    label: 'calls per round, max',
    sub: 'Up to six tool calls in any single round.',
  },
  {
    icon: SquareTerminal,
    value: '1',
    label: 'shell command at a time',
    sub: 'Guarded and sequential, reported with its real exit code.',
  },
  {
    icon: FileDiff,
    value: null,
    label: 'patches held for review',
    sub: 'Edits wait for your accept — never an arbitrary write.',
  },
]

const approvalRules = [
  {
    icon: TriangleAlert,
    text: 'One extra argument or a shell operator breaks the match.',
  },
  {
    icon: ShieldCheck,
    text: 'Everything else opens a native approval dialog before it runs.',
  },
  {
    icon: ScanSearch,
    text: 'The workspace is re-checked between approval and execution.',
  },
  {
    icon: Trash2,
    text: 'Deleting a path needs an explicit confirm plus a follow-up read that proves it is gone.',
  },
]

const fileNotes = [
  {
    file: 'src/app.tsx',
    status: 'applied',
    chip: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  {
    file: 'src/lib/api.ts',
    status: 'awaiting review',
    chip: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  {
    file: 'README.md',
    status: 'not applied',
    chip: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-400',
    dot: 'bg-rose-500',
  },
]

export default function AgentPage() {
  return (
    <PageShell
      eyebrow="The agent"
      title="Bounded,"
      accent="reviewable, honest."
      sub="It reads before it writes, asks before it runs, and reports what actually happened. The loop is bounded and every patch is reviewable — and the agent, autonomous run and team features are still beta."
    >
      <AgentSection />

      {/* ── The bounded loop: facts row ────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
              Guardrails
            </p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mx-auto mb-4 max-w-[640px] text-center text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
              The <em className="font-normal italic text-[var(--ac)]">bounded</em> loop.
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="mx-auto mb-10 max-w-[560px] text-center text-sm leading-7 text-[var(--mut)]">
              No runaway agent. The loop has hard limits, and these are the defaults.
            </p>
          </Reveal>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {loopFacts.map(({ icon: Icon, value, label, sub }, i) => (
              <Reveal
                key={label}
                delay={i * 80}
                className={i === loopFacts.length - 1 ? 'col-span-2 sm:col-span-1' : undefined}
              >
                <div className="feature-card flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5">
                  {value ? (
                    <span className="font-mono text-4xl font-bold tracking-[-0.04em] text-[var(--ink)]">
                      {value}
                    </span>
                  ) : (
                    <Icon className="size-9 text-[var(--ac)]" strokeWidth={1.5} />
                  )}
                  <span className="mt-3 flex items-center gap-1.5 text-sm font-bold leading-5 text-[var(--ink)]">
                    {value && <Icon className="size-3.5 shrink-0 text-[var(--ac)]" strokeWidth={2} />}
                    {label}
                  </span>
                  <p className="mt-1.5 text-xs leading-5 text-[var(--mut)]">{sub}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Default-deny command approval ──────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
              Command approval
            </p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[640px] text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
              Default-deny,{' '}
              <em className="font-normal italic text-[var(--ac)]">by design.</em>
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="mb-10 mt-4 max-w-[620px] text-sm leading-7 text-[var(--mut)]">
              The agent cannot run whatever it likes. A short, exact allowlist covers routine
              verification — everything else stops and asks you first.
            </p>
          </Reveal>

          <div className="grid gap-5 lg:grid-cols-2">
            <Reveal>
              <div className="feature-card h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                <h3 className="mb-1 font-bold text-[var(--ink)]">
                  Runs without a prompt — only these exact forms
                </h3>
                <p className="mb-4 text-xs leading-5 text-[var(--mut)]">
                  Matched verbatim, nothing more:
                </p>
                <div className="flex flex-wrap gap-2">
                  {ALLOWED_VERIFY_COMMANDS.map((cmd) => (
                    <span
                      key={cmd}
                      className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]"
                    >
                      {cmd}
                    </span>
                  ))}
                </div>

                <div className="my-6 h-px bg-[var(--line)]" />

                <ul className="space-y-4">
                  {approvalRules.map(({ icon: Icon, text }) => (
                    <li key={text} className="flex items-start gap-3">
                      <Icon className="mt-0.5 size-4 shrink-0 text-[var(--ac)]" strokeWidth={1.75} />
                      <span className="text-sm leading-6 text-[var(--ink2)]">{text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>

            <Reveal delay={120}>
              <CommandApprovalDemo allowed={ALLOWED_VERIFY_COMMANDS} />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Honest edit reports ────────────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="grid gap-10 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8 lg:grid-cols-2 lg:gap-14 lg:p-10">
              <div>
                <span className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ac)]">
                  <Sparkles className="size-3" strokeWidth={2} />
                  New in v{APP_VERSION}
                </span>
                <h2 className="text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.03em] leading-[1.15] text-[var(--ink)]">
                  Honest{' '}
                  <em className="font-normal italic text-[var(--ac)]">edit reports.</em>
                </h2>
                <p className="mt-4 text-sm leading-7 text-[var(--mut)]">
                  A truncated or malformed edit block never disappears quietly. It becomes an
                  explicit failure, and ShadRox gets one repair retry using the exact current
                  file contents.
                </p>
                <ul className="mt-6 space-y-3">
                  <li className="flex gap-3 text-sm leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    Explicit failures — never silently dropped
                  </li>
                  <li className="flex gap-3 text-sm leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    One repair retry against the exact current file contents
                  </li>
                  <li className="flex gap-3 text-sm leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    File notes state the real outcome, remembered across restarts
                  </li>
                </ul>
              </div>

              {/* File-note mock */}
              <div className="flex flex-col justify-center">
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-5">
                  <p className="mb-4 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    File notes
                  </p>
                  <div className="space-y-2.5">
                    {fileNotes.map(({ file, status, chip, dot }) => (
                      <div
                        key={file}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border border-[var(--line)] bg-[var(--card)] px-4 py-3"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileDiff className="size-3.5 shrink-0 text-[var(--mut)]" strokeWidth={1.75} />
                          <span className="truncate font-mono text-xs text-[var(--ink2)]">{file}</span>
                        </span>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${chip}`}
                        >
                          <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
                          {status}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-[11px] leading-4 text-[var(--mut)]">
                    Applied, awaiting review, or not applied — the real outcome, kept across
                    restarts.
                  </p>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Checkpoints, honestly ──────────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="grid gap-10 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8 lg:grid-cols-2 lg:gap-14 lg:p-10">
              <div>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Checkpoints
                </p>
                <h2 className="text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.03em] leading-[1.15] text-[var(--ink)]">
                  Rewind files,{' '}
                  <em className="font-normal italic text-[var(--ac)]">not the world.</em>
                </h2>
                <p className="mt-4 max-w-md text-sm leading-7 text-[var(--mut)]">
                  When a turn goes sideways, restore earlier files and your local Git position.
                  A checkpoint rewinds your project — not everything the project touched, and
                  we will not pretend otherwise.
                </p>
              </div>

              <div className="flex flex-col justify-center gap-4">
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-5">
                  <p className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--ink)]">
                    <History className="size-4 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
                    Restores
                  </p>
                  <ul className="space-y-2">
                    {['Earlier file contents', 'Your local Git position'].map((item) => (
                      <li key={item} className="flex items-center gap-2.5 text-sm leading-6 text-[var(--ink2)]">
                        <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-5">
                  <p className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--ink)]">
                    <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
                    Does not undo
                  </p>
                  <ul className="space-y-2">
                    {[
                      'Installed packages',
                      'Running terminals',
                      'Remote effects — anything already done outside your project',
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-2.5 text-sm leading-6 text-[var(--ink2)]">
                        <TriangleAlert className="mt-1 size-4 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Beta callout ───────────────────────────────────────────────── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <div className="flex flex-col items-start gap-5 rounded-3xl border border-amber-500/30 bg-amber-500/[0.06] p-6 sm:flex-row sm:p-8">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
                <FlaskConical className="size-5" strokeWidth={1.75} />
              </span>
              <div>
                <h2 className="text-lg font-bold text-[var(--ink)]">Beta, and evolving.</h2>
                <p className="mt-2 max-w-[720px] text-sm leading-7 text-[var(--mut)]">
                  Agent, autonomous run and team features are beta. Model output can be wrong —
                  review the results and keep backups of important work.{' '}
                  <a
                    href={GITHUB_REPO}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-semibold text-[var(--ac)] transition hover:opacity-80"
                  >
                    Built in the open — view the source
                    <ArrowUpRight className="size-3" />
                  </a>
                </p>
              </div>
            </div>
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
                  Your call, always
                </p>
                <h2 className="mx-auto max-w-[560px] text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                  Put the agent{' '}
                  <em className="font-normal italic text-[var(--ac)]">to work.</em>
                </h2>
                <p className="mx-auto mt-4 max-w-[520px] text-sm leading-7 text-[var(--mut)]">
                  Download ShadRox for Windows (version {APP_VERSION}, 64-bit), open a project,
                  and let the agent propose its first diff — you decide what lands.
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
                    href="/how-it-works"
                    className="group inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-6 py-3 text-sm font-bold text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--ac)]"
                  >
                    See how it works
                    <ArrowRight className="size-4 text-[var(--ac)] transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>

                <p className="mt-5 text-xs leading-5 text-[var(--mut)]">
                  Windows may warn about an unsigned installer — More → Run anyway.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}