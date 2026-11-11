import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Check, Download } from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { Features } from '@/components/landing/features'
import { APP_VERSION, GITHUB_REPO, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { CapabilitySheet } from './capability-sheet'

export const metadata: Metadata = {
  title: 'Features — ShadRox',
  description:
    'Editor, AI chat, local preview, Git and terminal in one Windows workspace. The full capability sheet: CodeMirror 6 editing, @-mention context, MCP servers, approval-gated runs, rewindable checkpoints and GitHub push.',
  alternates: { canonical: '/features' },
}

const included = [
  'Editor, AI chat, preview, Git tools and terminal in one window',
  'Free bring-your-own-key tier — you pay your provider, ShadRox adds no cap',
  'Google sign-in at first launch, then your own provider key',
  'Multi-step runs, teams, plugins and automations — included, still beta',
]

export default function FeaturesPage() {
  return (
    <PageShell
      eyebrow="Features"
      title="Every tool,"
      accent="one window."
      sub="ShadRox keeps the project files, editor, AI chat, local preview, Git tools and terminal side by side on your desktop. Here is the short version, then the full capability sheet underneath it."
    >
      <Features />

      <CapabilitySheet />

      {/* ── CTA band ── */}
      <section
        id="get-shadrox"
        className="scroll-mt-28 border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg2)] px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
              <div
                aria-hidden
                className="pointer-events-none absolute -left-24 -top-28 size-72 rounded-full blur-3xl"
                style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-32 -right-24 size-80 rounded-full blur-3xl"
                style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
              />

              <div className="relative grid gap-10 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:gap-14">
                <div>
                  <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                    Get ShadRox
                  </p>
                  <h2 className="max-w-[520px] text-[clamp(27px,3.6vw,42px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                    One download.{' '}
                    <em className="font-normal italic text-[var(--ac)]">The whole workspace.</em>
                  </h2>
                  <p className="mt-4 max-w-[480px] text-sm leading-7 text-[var(--mut)]">
                    A native Windows app, not a browser tab. Open a project folder from your
                    computer and start editing, asking, running and committing from there.
                  </p>

                  <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <a
                      href={WINDOWS_DOWNLOAD_URL}
                      className="inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
                    >
                      <Download className="size-4" />
                      Download for Windows
                    </a>
                    <Link
                      href="/preview-support"
                      className="group inline-flex items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-6 py-3 text-sm font-semibold text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--ac)] hover:text-[var(--ac)]"
                    >
                      What it can preview
                      <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                    </Link>
                  </div>

                  <p className="mt-5 text-xs leading-5 text-[var(--mut)]">
                    v{APP_VERSION} · Windows 10 or 11 (64-bit) · the installer is unsigned, so
                    Windows may warn — choose More → Run anyway.
                  </p>
                </div>

                <div className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ink)]">
                    What you get on day one
                  </h3>
                  <ul className="mt-5 space-y-3.5">
                    {included.map((line) => (
                      <li key={line} className="flex gap-3 text-[13px] leading-6 text-[var(--ink2)]">
                        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[var(--bg2)]">
                          <Check className="size-2.5 text-[var(--ac)]" strokeWidth={3} />
                        </span>
                        {line}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6 border-t border-[var(--line)] pt-5">
                    <a
                      href={GITHUB_REPO}
                      className="group inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--mut)] transition hover:text-[var(--ac)]"
                    >
                      Browse the repository on GitHub
                      <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}