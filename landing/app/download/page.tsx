import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Download,
  ArrowRight,
  PackageCheck,
  ShieldAlert,
  LogIn,
  KeyRound,
  Fingerprint,
  SquareTerminal,
  RefreshCw,
  HardDrive,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL, LATEST_RELEASE_URL } from '@/lib/download'
import { CopyButton } from './copy-button'

export const metadata: Metadata = {
  title: 'Download — ShadRox',
  description:
    'Download ShadRox for Windows 10 / 11 (64-bit). Free during beta — install in four steps, verify the SHA-512 hash, and see how updates work. The build is unsigned, so Windows SmartScreen will ask you to confirm.',
  alternates: { canonical: '/download' },
}

const INSTALLER_NAME = `ShadRox-v${APP_VERSION}-Setup.exe`
const FILE_BYTES = '144,847,123'
const SHA512 =
  'AizaIYv7E0dd/cw6vbxNT6bxyXJvL5uknlex462z0xxOphKd1rJzhQJ9msWVCOnF5K7vWWFjPPS/wBG8ukdxKw=='
const PS_CMD = `Get-FileHash .\\${INSTALLER_NAME} -Algorithm SHA512`

const steps = [
  {
    icon: PackageCheck,
    title: 'Download the installer',
    text: `Save ${INSTALLER_NAME} with the button above. Make sure it comes from the official GitHub release — that is the only place the installer is published.`,
  },
  {
    icon: ShieldAlert,
    title: 'Confirm SmartScreen',
    text: 'The build is unsigned, so Windows SmartScreen may show a warning. That is expected for a beta installer — choose:',
    chip: 'More → Run anyway',
  },
  {
    icon: LogIn,
    title: 'Sign in with Google',
    text: 'On first launch the app asks you to continue with Google. Your browser handles the sign-in and returns you to ShadRox.',
  },
  {
    icon: KeyRound,
    title: 'Add your key, open a folder',
    text: 'Connect your own Gemini, Groq, or OpenAI-compatible key (Ollama and LM Studio work too), then open any project folder to start.',
  },
]

const reassurance = [
  {
    icon: HardDrive,
    title: 'Local files',
    text: 'Your project folder stays on your disk. ShadRox opens it locally — no cloud project sync.',
  },
  {
    icon: KeyRound,
    title: 'Bring your own key',
    text: 'Use Gemini, Groq, or any OpenAI-compatible endpoint, including Ollama and LM Studio.',
  },
  {
    icon: LogIn,
    title: 'Google sign-in',
    text: 'Required once at first launch to enter the app. Free during beta.',
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

export default function DownloadPage() {
  return (
    <PageShell
      eyebrow="Download"
      title="Get ShadRox"
      accent="for Windows."
      sub="The native Windows workspace for local projects — editor, bring-your-own-key AI chat, live preview, Git tools and terminal in one app. Free during beta. The installer is unsigned, so Windows SmartScreen will ask you to confirm before it runs."
    >
      {/* ── Hero download card ── */}
      <section className="bg-[var(--bg)] px-5 pb-16 pt-2 lg:px-8 lg:pb-24">
        <div className="mx-auto max-w-[1180px]">
          <Reveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-8 text-center sm:p-12">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 left-1/2 size-72 -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--ac) 20%, transparent)' }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-28 -right-20 size-64 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--pink) 16%, transparent)' }}
              />

              <div className="relative">
                <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-3.5 py-1.5 font-mono text-[11px] font-bold text-[var(--ac)]">
                  <span className="glow-dot size-1.5 rounded-full bg-[var(--ac)]" aria-hidden />
                  v{APP_VERSION}
                </span>

                <h2 className="mx-auto mt-5 max-w-[620px] text-balance text-[clamp(26px,3.6vw,40px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
                  Ready to <em className="font-normal italic text-[var(--ac)]">install?</em>
                </h2>
                <p className="mx-auto mt-4 max-w-[520px] text-sm leading-6 text-[var(--mut)]">
                  One installer for Windows 10 and 11. Sign in with Google on first launch, then
                  connect your own AI key and open a project folder.
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="group inline-flex items-center justify-center gap-2.5 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-8 py-4 text-base font-bold text-white shadow-[0_12px_36px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_48px_var(--glow)]"
                  >
                    <Download className="size-5" />
                    Download for Windows
                  </a>
                  <Link
                    href="/releases"
                    className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-7 py-4 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    All releases
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>

                <p className="mt-6 text-xs font-medium text-[var(--mut)]">
                  Windows 10 / 11 · 64-bit · ~133 MB · Free during beta
                </p>
                <p className="mt-2 font-mono text-[11px] text-[var(--mut)]">{INSTALLER_NAME}</p>

                <p className="mx-auto mt-5 max-w-[540px] text-xs leading-5 text-[var(--mut)]">
                  The build is unsigned, so Windows SmartScreen may warn you — choose{' '}
                  <span className="font-semibold text-[var(--ink2)]">More → Run anyway</span>. The app
                  checks for newer releases when it starts.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Install in four steps ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <SectionHead
            eyebrow="Setup"
            title="Install in"
            accent="four steps."
            sub="From download to a running workspace in a few minutes. The only speed bump is an expected SmartScreen prompt for the unsigned beta build."
          />

          <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ icon: Icon, title, text, chip }, i) => (
              <Reveal key={title} delay={i * 90}>
                <article className="feature-card relative h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                  <span className="absolute right-5 top-5 font-mono text-[11px] font-bold text-[var(--mut)]">
                    0{i + 1}
                  </span>
                  <span className="mb-5 grid size-[46px] place-items-center rounded-[14px] bg-[var(--bg2)]">
                    <Icon className="size-[22px] text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="mb-2 text-[17px] font-bold leading-snug text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                  {chip && (
                    <span className="mt-3 inline-block rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                      {chip}
                    </span>
                  )}
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Verify your download ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <SectionHead
            eyebrow="Integrity"
            title="Verify your"
            accent="download."
            sub="Every release publishes a SHA-512 hash in latest.yml. Check your installer against it to confirm the file is intact and came from the official release."
          />

          <Reveal variant="scale">
            <div className="mx-auto max-w-[860px] rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  {INSTALLER_NAME}
                </span>
                <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  {FILE_BYTES} bytes
                </span>
                <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  ~133 MB
                </span>
              </div>

              {/* SHA-512 */}
              <div className="mt-7">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    <Fingerprint className="size-3.5 text-[var(--ac)]" />
                    SHA-512 · base64
                  </span>
                  <CopyButton value={SHA512} label="Copy hash" />
                </div>
                <p className="break-all rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-4 font-mono text-[12px] leading-6 text-[var(--ink2)]">
                  {SHA512}
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--mut)]">
                  This is the hash from{' '}
                  <a
                    href={LATEST_RELEASE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[var(--ac)] underline-offset-2 transition hover:underline"
                  >
                    latest.yml on the release page
                  </a>
                  .
                </p>
              </div>

              {/* PowerShell */}
              <div className="mt-7">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    <SquareTerminal className="size-3.5 text-[var(--ac)]" />
                    PowerShell
                  </span>
                  <CopyButton value={PS_CMD} label="Copy command" />
                </div>
                <p className="break-all rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-4 font-mono text-[12px] leading-6 text-[var(--ink2)]">
                  {PS_CMD}
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--mut)]">
                  PowerShell prints the hash in hex, while latest.yml publishes it in base64. Convert
                  one to compare, or compare with the hash published in latest.yml on the release
                  page.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── After install ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <SectionHead
            eyebrow="After install"
            title="Updates, on"
            accent="your terms."
            sub="ShadRox checks for newer releases and tells you when one is ready. Installing is always your call."
          />

          <Reveal variant="scale">
            <div className="mx-auto max-w-[900px] rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="grid gap-7 sm:grid-cols-2">
                <div className="flex gap-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[var(--bg2)]">
                    <RefreshCw className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h3 className="mb-1.5 text-[15px] font-bold text-[var(--ink)]">
                      Updates check on start
                    </h3>
                    <p className="text-sm leading-6 text-[var(--mut)]">
                      About 15 seconds after start, and every 6 hours after that, ShadRox looks for
                      a newer release and shows a badge when one is ready.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[var(--bg2)]">
                    <Download className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h3 className="mb-1.5 text-[15px] font-bold text-[var(--ink)]">
                      You install updates
                    </h3>
                    <p className="text-sm leading-6 text-[var(--mut)]">
                      Nothing downloads or installs automatically. When the badge appears, download
                      the installer from the release page and run it when you choose.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-7 flex flex-col gap-3 border-t border-[var(--line)] pt-6 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[var(--mut)]">
                  Questions about installing, signing in, or your AI key?
                </p>
                <Link
                  href="/faq"
                  className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-[var(--ac)] transition hover:gap-2.5"
                >
                  Read the FAQ
                  <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Reassurance row ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-[18px] sm:grid-cols-3">
            {reassurance.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 90}>
                <div className="feature-card flex h-full items-start gap-4 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-[var(--ink)]">{title}</h3>
                    <p className="mt-1 text-[13px] leading-5 text-[var(--mut)]">{text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={140}>
            <p className="mt-7 text-center text-xs font-medium uppercase tracking-[0.18em] text-[var(--mut)]">
              Local files · Bring your own key · Google sign-in
            </p>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}