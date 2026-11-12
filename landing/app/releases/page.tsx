import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Download,
  ArrowRight,
  ArrowUpRight,
  Sparkles,
  CalendarDays,
  ShieldCheck,
  ClipboardCheck,
  MessagesSquare,
  TriangleAlert,
  RefreshCw,
  RotateCw,
  PackageX,
  Archive,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL, GITHUB_REPO, RELEASES_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'Releases — ShadRox',
  description:
    'What is new in ShadRox v0.0.8: honest edit reports, file-note outcomes you can trust, and a calmer chat. See how updates work, why same-version rebuilds need a manual reinstall, and where older installers went.',
  alternates: { canonical: '/releases' },
}

const RELEASE_TAG_URL = `${GITHUB_REPO}/releases/tag/v${APP_VERSION}`

const highlights = [
  {
    icon: ShieldCheck,
    title: 'Edits land — or say why',
    text: 'A reply cut off mid-code-block is no longer dropped silently. Truncated or malformed edit blocks become explicit failures, and the agent retries once with the exact current file contents.',
  },
  {
    icon: ClipboardCheck,
    title: 'Outcomes you can trust',
    text: 'Every file note reports the real result — applied, awaiting review or not applied — instead of guessing from the reply text. Outcomes are remembered when you reopen the project.',
  },
  {
    icon: MessagesSquare,
    title: 'A calmer chat',
    text: 'Long code blocks collapse to a one-line summary, reasoning traces fold once the answer lands, and model and token stats live under a single Usage toggle.',
  },
]

const updateFlow = [
  {
    icon: RefreshCw,
    title: 'Checks on start',
    text: 'ShadRox looks for a newer release when it starts and tells you when an update is ready.',
  },
  {
    icon: RotateCw,
    title: 'Restart to install',
    text: 'Review the release notes, then restart the app to install the update.',
  },
  {
    icon: PackageX,
    title: 'Same-version rebuilds are manual',
    text: 'If a build is replaced under the same version number, auto-update will not detect it. Download and reinstall that one manually.',
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
      sub="Every ShadRox build is published on GitHub Releases. Here is what changed in the current version, how updates reach you, and where older installers went."
    >
      {/* ── Current release ── */}
      <section className="bg-[var(--bg)] px-5 pb-16 pt-2 lg:px-8 lg:pb-24">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <article className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-10">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 left-1/2 size-72 -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--ac) 16%, transparent)' }}
              />

              <div className="relative">
                {/* Version header */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-4 py-1.5 font-mono text-sm font-bold text-white shadow-[0_8px_24px_var(--glow)]">
                    v{APP_VERSION}
                  </span>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em]"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--ac) 40%, transparent)',
                      color: 'var(--ac)',
                      background: 'color-mix(in srgb, var(--ac) 10%, transparent)',
                    }}
                  >
                    <Sparkles className="size-3.5" />
                    Latest · rebuilt
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-[var(--mut)]">
                    <CalendarDays className="size-3.5" />
                    November 2026
                  </span>
                </div>

                <h2 className="mt-6 max-w-[700px] text-balance text-[clamp(26px,3.6vw,42px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
                  Edits you can trust,{' '}
                  <em className="font-normal italic text-[var(--ac)]">and a calmer chat.</em>
                </h2>
                <p className="mt-4 max-w-[660px] text-sm leading-7 text-[var(--mut)]">
                  The first v{APP_VERSION} build was replaced by a rebuilt installer with the same
                  version number. These are the fixes it ships.
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

                {/* Same-version reinstall callout */}
                <div
                  className="mt-6 flex gap-4 rounded-2xl border p-5"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--ac) 35%, transparent)',
                    background: 'color-mix(in srgb, var(--ac) 8%, transparent)',
                  }}
                >
                  <span
                    className="grid size-9 shrink-0 place-items-center rounded-xl"
                    style={{ background: 'color-mix(in srgb, var(--ac) 16%, transparent)' }}
                  >
                    <TriangleAlert className="size-[18px] text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-[var(--ink)]">
                      On the first v{APP_VERSION} build? Reinstall manually.
                    </h3>
                    <p className="mt-1 text-[13px] leading-6 text-[var(--ink2)]">
                      Auto-update cannot detect a rebuild published under the same version number.
                      Download this installer and run it again — same version, fixed build.
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="group inline-flex items-center justify-center gap-2.5 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-7 py-3.5 text-sm font-bold text-white shadow-[0_12px_36px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_48px_var(--glow)]"
                  >
                    <Download className="size-4" />
                    Download v{APP_VERSION}
                  </a>
                  <a
                    href={RELEASE_TAG_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-7 py-3.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Release page on GitHub
                    <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </a>
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
            sub="A simple, predictable flow — ShadRox never silently swaps a build under the same version number."
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
                    ShadRox keeps just the current installer on GitHub Releases. When a new build
                    ships, older installers are removed — so this page documents the current version
                    rather than a full history. For every release and its notes, go straight to
                    GitHub.
                  </p>
                  <a
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group mt-5 inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-5 py-2.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    Browse all releases on GitHub
                    <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </a>
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
                    href={WINDOWS_DOWNLOAD_URL}
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