import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Download,
  ArrowRight,
  ArrowUpRight,
  PackageCheck,
  ShieldAlert,
  LogIn,
  KeyRound,
  Fingerprint,
  SquareTerminal,
  RefreshCw,
  HardDrive,
  EyeOff,
  CodeXml,
  BadgeCheck,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL, LATEST_RELEASE_URL, GITHUB_REPO } from '@/lib/download'
import { CopyButton } from './copy-button'
import { SmartScreenMock } from './smartscreen-mock'

export const metadata: Metadata = {
  title: 'ShadRox — Download',
  description:
    'Download ShadRox for Windows 10 / 11 (64-bit). Free during beta — install in four steps, verify the SHA-512 hash, and see exactly why the unsigned build triggers a Windows SmartScreen warning.',
  alternates: { canonical: '/download' },
}

const INSTALLER_NAME = `ShadRox-v${APP_VERSION}-Setup.exe`
const FILE_BYTES = '144,905,745'
const SHA512 =
  '1jjcmtJntPmjnHnvA3Y3RimTd5Aor3cXnPDDup/w1c4sevffKATmoFw/d3XcqKH88VVhFU3pHbj3JbVfge1UMA=='
const PS_CMD = `Get-FileHash .\\${INSTALLER_NAME} -Algorithm SHA512`
const BUILD_CMD = 'npm install && npm run dist:win'

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
    chip: 'More info → Run anyway',
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

const clickThrough = [
  {
    title: 'Click “More info”',
    text: 'The small link under the warning text expands the details panel.',
  },
  {
    title: 'Check the publisher line',
    text: `It reads App: ${INSTALLER_NAME} and Publisher: Unknown — exactly what an unsigned build shows.`,
  },
  {
    title: 'Click “Run anyway”',
    text: 'The installer starts. Do this only after the checksum matches — or build from source instead.',
  },
]

const trustAnchors = [
  {
    icon: EyeOff,
    title: 'No hidden telemetry',
    text: 'The app runs no usage analytics. Google sign-in stores only email, name, avatar, app version and platform — and the only background network call is the update check against GitHub Releases.',
  },
  {
    icon: KeyRound,
    title: 'Your keys stay local',
    text: 'Bring your own key: provider keys sit in OS-backed encrypted storage on your device and are never sent to ShadRox. Prompts go only to the provider you configure.',
  },
  {
    icon: CodeXml,
    title: 'Open source, AGPL-3.0',
    text: 'The full source is public on GitHub — read it, audit it, or build the installer yourself instead of trusting ours.',
    link: { label: 'View the repository', href: GITHUB_REPO },
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
        <p className="eyebrow mb-3">
          {eyebrow}
        </p>
      </Reveal>
      <Reveal delay={80}>
        <h2 className="text-[clamp(1.75rem,3.6vw,2.75rem)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
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
      <section className="bg-[var(--bg)] pb-16 pt-2 lg:pb-24">
        <div className="container-page">
          <Reveal variant="scale">
            <div
              className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-7 text-center sm:p-12"
              style={{ boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.4), 0 30px 80px -48px var(--shadow)' }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -top-32 left-1/2 size-80 -translate-x-1/2 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--ac) 16%, transparent)' }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-32 -right-24 size-72 rounded-full blur-3xl"
                style={{ background: 'color-mix(in srgb, var(--pink) 12%, transparent)' }}
              />

              <div className="relative">
                <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-3.5 py-1.5 font-mono text-[11px] font-bold text-[var(--ac)]">
                  <span className="glow-dot size-1.5 rounded-full bg-[var(--ac)]" aria-hidden />
                  v{APP_VERSION}
                </span>

                <h2 className="mx-auto mt-5 max-w-[620px] text-[clamp(1.75rem,3.6vw,2.625rem)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
                  Ready to <em className="font-normal italic text-[var(--ac)]">install?</em>
                </h2>
                <p className="mx-auto mt-4 max-w-[520px] text-sm leading-6 text-[var(--mut)]">
                  One installer for Windows 10 and 11. Sign in with Google on first launch, then
                  connect your own AI key and open a project folder.
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <a
                    href={WINDOWS_DOWNLOAD_URL}
                    className="cta-primary group w-full sm:w-auto"
                  >
                    <Download className="size-4" aria-hidden />
                    Download for Windows
                  </a>
                  <Link
                    href="/releases"
                    className="cta-ghost group w-full sm:w-auto"
                  >
                    All releases
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </div>

                <p className="mt-6 text-xs font-medium text-[var(--mut)]">
                  Windows 10 / 11 · 64-bit · ~138 MB · Free during beta
                </p>
                <p className="mt-2 break-all font-mono text-[11px] text-[var(--mut)]">{INSTALLER_NAME}</p>

                <p className="mx-auto mt-5 max-w-[540px] text-xs leading-5 text-[var(--mut)]">
                  The build is unsigned, so Windows SmartScreen may warn you — choose{' '}
                  <span className="font-semibold text-[var(--ink2)]">More info → Run anyway</span>.{' '}
                  <a
                    href="#smartscreen"
                    className="font-semibold text-[var(--ac)] underline-offset-2 hover:underline"
                  >
                    Why this happens, and how to verify
                  </a>
                  . The app checks for newer releases when it starts.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Install in four steps ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-24">
        <div className="container-page">
          <SectionHead
            eyebrow="Setup"
            title="Install in"
            accent="four steps."
            sub="From download to a running workspace in a few minutes. The only speed bump is an expected SmartScreen prompt for the unsigned beta build."
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ icon: Icon, title, text, chip }, i) => (
              <Reveal key={title} delay={i * 90} className="h-full">
                <article className="feature-card relative flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span className="absolute right-5 top-5 font-mono text-[11px] font-bold text-[var(--mut)]" aria-hidden>
                    0{i + 1}
                  </span>
                  <span className="grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <h3 className="mb-2 mt-5 text-[15px] font-bold leading-snug tracking-[-0.01em] text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                  {chip && (
                    <span className="mt-3 inline-block self-start rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                      {chip}
                    </span>
                  )}
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Windows SmartScreen ── */}
      <section
        id="smartscreen"
        className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-24"
      >
        <div className="container-page">
          <SectionHead
            eyebrow="SmartScreen"
            title="The warning is"
            accent="expected."
            sub="ShadRox is an indie, open-source beta maintained by one person. The installer is not code-signed yet, so Windows cannot verify its publisher — and SmartScreen says so. Here is exactly what you will see, and how to check the file before you run it."
          />

          <Reveal variant="scale">
            <div className="grid gap-10 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8 lg:grid-cols-2 lg:gap-12 lg:p-10">
              {/* Left: why it happens + exact click-through + verify */}
              <div>
                <div className="flex items-start gap-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-4 sm:p-5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="size-5" strokeWidth={1.75} aria-hidden />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-[var(--ink)]">Why Windows warns</h3>
                    <p className="mt-1.5 text-[13px] leading-6 text-[var(--mut)]">
                      Code-signing certificates cost money, and ShadRox is a free indie project —
                      signing is planned as it grows. Until then, SmartScreen treats the installer
                      as unrecognized. That is a reputation check, not a report that malware was
                      found.
                    </p>
                  </div>
                </div>

                <p className="mb-4 mt-7 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                  The click-through, exactly
                </p>
                <ol className="space-y-4">
                  {clickThrough.map((s, i) => (
                    <li key={s.title} className="flex gap-3.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--line)] bg-[var(--bg2)] font-mono text-[12px] font-bold text-[var(--ac)]">
                        {i + 1}
                      </span>
                      <div>
                        <h3 className="text-sm font-bold text-[var(--ink)]">{s.title}</h3>
                        <p className="mt-0.5 text-[13px] leading-6 text-[var(--mut)]">{s.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="mt-7 rounded-xl border border-[var(--line)] bg-[var(--bg2)] p-4 sm:p-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                      <SquareTerminal className="size-3.5 text-[var(--ac)]" aria-hidden />
                      Verify before you run
                    </span>
                    <CopyButton value={PS_CMD} label="Copy command" />
                  </div>
                  <p className="break-all rounded-lg border border-[var(--line)] bg-[var(--card)] p-3 font-mono text-[12px] leading-6 text-[var(--ink2)]">
                    {PS_CMD}
                  </p>
                  <p className="mt-2.5 text-xs leading-5 text-[var(--mut)]">
                    PowerShell prints hex; the published SHA-512 is the same hash in base64 —
                    convert one side to compare.{' '}
                    <a
                      href="#verify"
                      className="font-semibold text-[var(--ac)] underline-offset-2 hover:underline"
                    >
                      Checksum &amp; comparison guide
                    </a>{' '}
                    just below.
                  </p>
                </div>
              </div>

              {/* Right: interactive mock dialog */}
              <div className="flex flex-col justify-center">
                <SmartScreenMock installerName={INSTALLER_NAME} />
              </div>
            </div>
          </Reveal>

          {/* Trust anchors */}
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {trustAnchors.map(({ icon: Icon, title, text, link }, i) => (
              <Reveal key={title} delay={i * 90} className="h-full">
                <article className="feature-card flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span className="mb-4 grid size-10 place-items-center rounded-lg border border-[var(--line)] bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">{title}</h3>
                  <p className="mt-1.5 text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                  {link && (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--ac)] hover:underline hover:underline-offset-4"
                    >
                      {link.label}
                      <ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  )}
                </article>
              </Reveal>
            ))}
          </div>

          {/* Forward-looking: signing roadmap + build from source */}
          <Reveal delay={120} variant="scale">
            <div className="mt-4 flex flex-col gap-6 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--card)]">
                  <BadgeCheck className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                </span>
                <div>
                  <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                    Signing is on the roadmap.
                  </h3>
                  <p className="mt-1.5 max-w-[520px] text-[13px] leading-6 text-[var(--mut)]">
                    A code-signing certificate is planned as the project grows. Until then,
                    download only from the official GitHub release, verify the SHA-512 — or build
                    the installer yourself from the public source.
                  </p>
                </div>
              </div>
              <div className="shrink-0 lg:w-[340px]">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    Build from source
                  </span>
                  <CopyButton value={BUILD_CMD} label="Copy" />
                </div>
                <p className="break-all rounded-lg border border-[var(--line)] bg-[var(--card)] p-3 font-mono text-[12px] leading-6 text-[var(--ink2)]">
                  {BUILD_CMD}
                </p>
                <p className="mt-2 text-[11px] leading-4 text-[var(--mut)]">
                  From the repo root, after the README&apos;s .env setup. Requires Node.js 22.12+.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Verify your download ── */}
      <section
        id="verify"
        className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-24"
      >
        <div className="container-page">
          <SectionHead
            eyebrow="Integrity"
            title="Verify your"
            accent="download."
            sub="Every release publishes a SHA-512 hash in latest.yml. Check your installer against it to confirm the file is intact and came from the official release."
          />

          <Reveal variant="scale">
            <div className="mx-auto max-w-[860px] rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  {INSTALLER_NAME}
                </span>
                <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  {FILE_BYTES} bytes
                </span>
                <span className="rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]">
                  ~138 MB
                </span>
              </div>

              {/* SHA-512 */}
              <div className="mt-7">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    <Fingerprint className="size-3.5 text-[var(--ac)]" aria-hidden />
                    SHA-512 · base64
                  </span>
                  <CopyButton value={SHA512} label="Copy hash" />
                </div>
                <p className="break-all rounded-lg border border-[var(--line)] bg-[var(--bg2)] p-4 font-mono text-[12px] leading-6 text-[var(--ink2)]">
                  {SHA512}
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--mut)]">
                  This is the hash from{' '}
                  <a
                    href={LATEST_RELEASE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[var(--ac)] underline-offset-2 hover:underline"
                  >
                    latest.yml on the release page
                  </a>
                  .
                </p>
              </div>

              {/* PowerShell */}
              <div className="mt-7">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                    <SquareTerminal className="size-3.5 text-[var(--ac)]" aria-hidden />
                    PowerShell
                  </span>
                  <CopyButton value={PS_CMD} label="Copy command" />
                </div>
                <p className="break-all rounded-lg border border-[var(--line)] bg-[var(--bg2)] p-4 font-mono text-[12px] leading-6 text-[var(--ink2)]">
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
      <section className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-24">
        <div className="container-page">
          <SectionHead
            eyebrow="After install"
            title="Updates, on"
            accent="your terms."
            sub="ShadRox checks for newer releases and tells you when one is ready. Installing is always your call."
          />

          <Reveal variant="scale">
            <div className="mx-auto max-w-[900px] rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="grid gap-7 sm:grid-cols-2">
                <div className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--bg2)]">
                    <RefreshCw className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <div>
                    <h3 className="mb-1.5 text-[15px] font-bold text-[var(--ink)]">
                      Updates check on start
                    </h3>
                    <p className="text-[13.5px] leading-6 text-[var(--mut)]">
                      About 15 seconds after start, and every 6 hours after that, ShadRox looks for
                      a newer release and shows a badge when one is ready.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--bg2)]">
                    <Download className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <div>
                    <h3 className="mb-1.5 text-[15px] font-bold text-[var(--ink)]">
                      You install updates
                    </h3>
                    <p className="text-[13.5px] leading-6 text-[var(--mut)]">
                      Nothing downloads or installs automatically. When the badge appears, download
                      the installer from the release page and run it when you choose.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-7 flex flex-col gap-3 border-t border-[var(--line)] pt-6 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[13.5px] text-[var(--mut)]">
                  Questions about installing, signing in, or your AI key?
                </p>
                <Link
                  href="/faq"
                  className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-[var(--ac)] hover:underline hover:underline-offset-4"
                >
                  Read the FAQ
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Reassurance row ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-24">
        <div className="container-page">
          <div className="grid gap-4 sm:grid-cols-3">
            {reassurance.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 90} className="h-full">
                <div className="feature-card flex h-full items-start gap-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
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
            <p className="mt-7 text-center text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--mut)]">
              Local files · Bring your own key · Google sign-in
            </p>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}