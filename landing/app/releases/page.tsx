import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Download,
  ArrowRight,
  CalendarDays,
  Cpu,
  Layers,
  ShieldCheck,
  RefreshCw,
  BellRing,
  Archive,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, INSTALLER_DOWNLOAD_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'ShadRox — Releases',
  description:
    'What is new in ShadRox v0.1.4: one auto-routed autonomous agent (conversational / advisory / execution), ultra-lean BYOK token usage, AI Studio-style 1-click checkpoints with ↺ Restore, Git Push/Pull/Sync with inline diff, parallel terminals, Ctrl+V image paste, and inline SVG generation.',
  alternates: { canonical: '/releases' },
}

const highlights = [
  {
    icon: ShieldCheck,
    title: 'Enterprise security hardening',
    text: 'Hosted AI endpoint requests resolve DNS A/AAAA records upfront to block DNS-rebinding SSRF attacks, blob: popups run strictly sandboxed, and desktop builds exclude local .env files automatically.',
  },
  {
    icon: Cpu,
    title: 'Windows NTFS & process safety',
    text: 'Checkpoint rewinds reliably detect and refuse Windows NTFS hardlinks before restoring files, and stopped background jobs verify process-tree termination with taskkill/SIGKILL fallbacks.',
  },
  {
    icon: Layers,
    title: 'Modular architecture & agent polish',
    text: 'Domain-split Electron IPC and React workspace hooks cut monolith size cleanly while tightening autonomous milestone change verification, single-file milestone coalescing, and compact patch feedback.',
  },
]

const updateFlow = [
  {
    icon: RefreshCw,
    title: 'Checks on start',
    text: 'About 15 seconds after launch, and every 6 hours after that, ShadRox looks for a newer release.',
  },
  {
    icon: BellRing,
    title: 'A badge, nothing more',
    text: 'When an update exists you get a badge and the release notes. Nothing is downloaded or installed behind your back.',
  },
  {
    icon: Download,
    title: 'Install when you are ready',
    text: 'Download the installer from the release page and run it. Your settings and projects stay put.',
  },
]

function SectionHead({
  eyebrow,
  title,
  accent,
  sub,
}: {
  eyebrow: string
  title: string
  accent?: string
  sub?: string
}) {
  return (
    <div className="mx-auto mb-12 max-w-[720px] text-center">
      <Reveal>
        <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
          {eyebrow}
        </p>
      </Reveal>
      <Reveal delay={80}>
        <h2 className="text-balance text-[clamp(28px,4vw,44px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
          {title}
          {accent && (
            <>
              {' '}
              <em className="font-normal italic text-[var(--ac)]">{accent}</em>
            </>
          )}
        </h2>
      </Reveal>
      {sub && (
        <Reveal delay={160}>
          <p className="mx-auto mt-4 max-w-[600px] text-pretty text-base leading-7 text-[var(--mut)]">
            {sub}
          </p>
        </Reveal>
      )}
    </div>
  )
}

export default function ReleasesPage() {
  return (
    <PageShell
      eyebrow="Releases"
      title="What's new"
      accent="in ShadRox."
      sub="Every official ShadRox build is distributed from shadrox.cyou. Here is what changed in the current version, how updates reach you, and how older installers are rotated."
    >
      {/* ── Current release ── */}
      <section id="latest" className="scroll-mt-28 bg-[var(--bg)] px-5 pb-16 pt-2 lg:px-8 lg:pb-24">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <article className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-10">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 left-1/2 size-72 -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--ac) 16%, transparent)' }}
              />

              <div className="relative">
                {/* Version metadata */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4 font-mono text-xs tabular-nums">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-bold text-[var(--ac)]">v{APP_VERSION}</span>
                    <span className="text-[var(--mut)]">/</span>
                    <span className="uppercase tracking-[0.16em] text-[var(--ink2)]">Latest release</span>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-[var(--mut)]">
                    <CalendarDays className="size-3.5" />
                    November 2026
                  </span>
                </div>

                <h2 className="mt-6 max-w-[700px] text-balance text-[clamp(26px,3.6vw,42px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
                  One autonomous agent,{' '}
                  <em className="font-normal italic text-[var(--ac)]">ultra-lean and in control.</em>
                </h2>
                <p className="mt-4 max-w-[680px] text-sm leading-7 text-[var(--mut)]">
                  v{APP_VERSION} unifies the agent into a single auto-routed loop — conversational,
                  advisory, or execution — that keeps greetings tiny and only spends tokens when a
                  turn needs tools. Adds AI Studio-style 1-click checkpoints (↺ Restore), Git
                  Push / Pull / Sync with inline diffs, parallel terminals, Ctrl+V image paste, and
                  inline &lt;svg&gt; generation — still free, still BYOK, with zero billing.
                </p>

                {/* Highlights */}
                <div className="mt-8 grid gap-[18px] md:grid-cols-3">
                  {highlights.map(({ icon: Icon, title, text }) => (
                    <div
                      key={title}
                      className="feature-card h-full rounded-[22px] border border-[var(--line)] bg-[var(--bg2)] p-5 sm:p-6"
                    >
                      <span className="mb-4 grid size-[42px] place-items-center rounded-[13px] bg-[var(--card)]">
                        <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                      </span>
                      <h3 className="mb-2 text-[15px] font-bold leading-snug text-[var(--ink)]">
                        {title}
                      </h3>
                      <p className="text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                    </div>
                  ))}
                </div>

                {/* Actions */}
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <a
                    href={INSTALLER_DOWNLOAD_URL}
                    className="group inline-flex items-center justify-center gap-2.5 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-7 py-3.5 text-sm font-bold text-white shadow-[0_12px_36px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_48px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download v{APP_VERSION}
                  </a>
                  <Link
                    href="/download#verify"
                    className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-7 py-3.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Verify SHA-512 checksum
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
                <p className="mt-4 text-xs leading-5 text-[var(--mut)]">
                  Unsigned build — Windows SmartScreen may warn you; choose{' '}
                  <span className="font-semibold text-[var(--ink2)]">More → Run anyway</span>.
                </p>
              </div>
            </article>
          </Reveal>
        </div>
      </section>

      {/* ── How updates work ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <SectionHead
            eyebrow="Updates"
            title="How updates"
            accent="reach you."
            sub="A simple, predictable flow — ShadRox never downloads or installs anything without you."
          />

          <div className="grid gap-[18px] md:grid-cols-3">
            {updateFlow.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 100}>
                <article className="feature-card h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                  <span className="mb-5 grid size-[46px] place-items-center rounded-[14px] bg-[var(--bg2)]">
                    <Icon className="size-[22px] text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="mb-2 text-[17px] font-bold leading-snug text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Where older versions went ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <SectionHead eyebrow="Archive" title="Where older" accent="versions went." />

          <Reveal variant="scale">
            <div className="mx-auto max-w-[860px] rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[var(--bg2)]">
                  <Archive className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                </span>
                <div>
                  <h3 className="text-lg font-bold tracking-[-0.02em] text-[var(--ink)]">
                    Only the latest installer is kept.
                  </h3>
                  <p className="mt-2 text-sm leading-7 text-[var(--mut)]">
                    ShadRox keeps only the current official installer available on shadrox.cyou. When
                    a new build ships, older installers are rotated out — so this page documents the
                    current version directly without external mirrors.
                  </p>
                  <Link
                    href="/download"
                    className="group mt-5 inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-5 py-2.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Go to download &amp; install guide
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── End CTA ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative mx-auto max-w-3xl overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-8 text-center sm:p-12">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--ac) 18%, transparent)' }}
              />
              <div className="relative">
                <span className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-[var(--bg2)]">
                  <Download className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                </span>
                <h2 className="text-balance text-[clamp(24px,3.4vw,36px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                  Get the current build.
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--mut)]">
                  v{APP_VERSION} for Windows 10 / 11 (64-bit). Free during beta — unsigned, so
                  SmartScreen will ask you to confirm.
                </p>
                <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <a
                    href={INSTALLER_DOWNLOAD_URL}
                    className="group inline-flex items-center justify-center gap-2.5 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-7 py-3.5 text-sm font-bold text-white shadow-[0_12px_36px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_48px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download v{APP_VERSION}
                  </a>
                  <Link
                    href="/download"
                    className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-7 py-3.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Install guide
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}