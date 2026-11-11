import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight, ArrowUpRight, Ban, Boxes, Download, FileText, FolderSearch,
  Globe, MousePointerClick, Play, ScanEye, Server, ShieldCheck, Trash2,
  TriangleAlert,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { PreviewSupport } from '@/components/landing/preview-support'
import { APP_VERSION, GITHUB_REPO, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { MarkdownToggleDemo } from './markdown-toggle-demo'

export const metadata: Metadata = {
  title: 'Preview support — ShadRox',
  description:
    'What ShadRox can preview: Markdown files, static sites, detected Node web projects (Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, webpack, Parcel) and Python, Go, PHP, Java and .NET backends — with approval before anything installs or launches.',
  alternates: { canonical: '/preview-support' },
}

const chipClass =
  'font-mono text-[11px] rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 text-[var(--mut)]'

const steps = [
  {
    icon: FolderSearch,
    num: '01',
    title: 'Detect the project type',
    chip: 'on open',
    text: 'ShadRox reads the folder you opened and works out what it is: a static site, a Node web project with a supported package script, or a detected backend entry point.',
  },
  {
    icon: ShieldCheck,
    num: '02',
    title: 'Ask before anything runs',
    chip: 'your approval',
    text: 'Installing missing dependencies and launching a detected script are managed run actions. Both ask for your approval first — nothing installs or starts on its own.',
  },
  {
    icon: Play,
    num: '03',
    title: 'Serve the project locally',
    chip: 'on your machine',
    text: 'The project is served locally and rendered in the in-app preview panel, beside the editor, the chat and the terminal it came from.',
  },
  {
    icon: ScanEye,
    num: '04',
    title: 'Grade the rendered frame',
    chip: 'bounded check',
    text: 'A bounded check grades the rendered frame, so a blank or broken preview is reported instead of quietly counting as a success.',
  },
  {
    icon: Trash2,
    num: '05',
    title: 'Clean up stale servers',
    chip: 'next start',
    text: 'Dev servers left behind by an earlier session are cleaned up on the next start, so old processes do not pile up in the background.',
  },
]

type Coverage = {
  icon: typeof FileText
  title: string
  text: string
  chips: string[]
  note?: string
}

const coverage: Coverage[] = [
  {
    icon: FileText,
    title: 'Markdown files',
    text: 'Open a Markdown file and switch between the rendered page and its markup with the Preview / Source toggle beside the file name.',
    chips: ['.md', 'Preview', 'Source'],
  },
  {
    icon: Globe,
    title: 'Static sites',
    text: 'Plain HTML, CSS and JavaScript folders are served locally and shown in the preview panel — no build step and no configuration.',
    chips: ['HTML', 'CSS', 'JS'],
  },
  {
    icon: Boxes,
    title: 'Node web projects',
    text: 'Detected frameworks and bundlers running their supported package scripts, including nested projects you pick from a list.',
    chips: ['Vite', 'Next.js', 'Nuxt', 'Astro', 'Angular', 'SvelteKit', 'webpack', 'Parcel'],
  },
  {
    icon: Server,
    title: 'Detected backends',
    text: 'Entry points for these backends are detected in your workspace. How far a preview gets depends on the project and its configuration.',
    chips: ['Python', 'Go', 'PHP', 'Java', '.NET'],
    note: 'The runtime must be installed on your machine.',
  },
]

const caveats = [
  {
    icon: TriangleAlert,
    tone: 'warn' as const,
    title: 'Not every configuration',
    text: 'Detection covers the setups listed above. A project with an unusual configuration may not be detected, or may not run the way you expect.',
  },
  {
    icon: Ban,
    tone: 'warn' as const,
    title: 'Some sites block embedding',
    text: 'External sites that refuse to be embedded will not render inside the preview panel, however healthy they are in a browser.',
  },
  {
    icon: MousePointerClick,
    tone: 'ok' as const,
    title: 'Click-to-source',
    text: 'On pages ShadRox serves, click an element in the preview to jump straight to its source line in the editor.',
  },
  {
    icon: ShieldCheck,
    tone: 'ok' as const,
    title: 'Approval before action',
    text: 'Managed run actions always ask before anything installs or launches. You stay the one who decides what runs.',
  },
]

const firstRun = [
  'Continue with Google on first launch — the app stores only email, name, avatar URL, version and platform.',
  'Open a project folder from your computer. ShadRox maps it and detects what it can run.',
  'Approve the detected preview script when you are asked, then keep working in the same window.',
]

export default function PreviewSupportPage() {
  return (
    <PageShell
      eyebrow="Preview support"
      title="See it running,"
      accent="beside the code."
      sub="ShadRox serves static sites and detected web projects locally, asks before it installs or launches anything, and checks the rendered frame so you know the preview actually worked. Here is exactly what that covers."
    >
      <PreviewSupport />

      {/* ── 1. How a preview runs ── */}
      <section
        id="how-a-preview-runs"
        className="scroll-mt-28 border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-10 lg:grid-cols-[.82fr_1.18fr] lg:gap-16">
            <div>
              <Reveal>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Under the hood
                </p>
              </Reveal>
              <Reveal delay={80}>
                <h2 className="max-w-[380px] text-[clamp(27px,3.6vw,42px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                  How a preview{' '}
                  <em className="font-normal italic text-[var(--ac)]">runs.</em>
                </h2>
              </Reveal>
              <Reveal delay={150}>
                <p className="mt-5 max-w-[380px] text-sm leading-7 text-[var(--mut)]">
                  Five steps between opening a folder and seeing the page. Two of them
                  are yours: approving what runs, and reading the result.
                </p>
              </Reveal>
              <Reveal delay={220} variant="scale">
                <div className="feature-card mt-8 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                  <span className="mb-4 grid size-11 place-items-center rounded-2xl bg-[var(--bg2)]">
                    <ShieldCheck className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="text-[16px] font-bold leading-snug text-[var(--ink)]">
                    Nothing installs behind your back.
                  </h3>
                  <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">
                    Every managed run action — dependency install or detected script —
                    waits for your approval before it touches the project.
                  </p>
                </div>
              </Reveal>
            </div>

            <Reveal delay={120}>
              <ol className="divide-y divide-[var(--line)] overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)]">
                {steps.map(({ icon: Icon, num, title, chip, text }) => (
                  <li key={num}>
                    <div className="group flex gap-4 p-6 transition-colors duration-300 hover:bg-[var(--bg2)] sm:gap-5 sm:p-7">
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-[var(--bg2)] font-mono text-[12px] font-bold text-[var(--ac)] transition-all duration-300 group-hover:bg-[linear-gradient(135deg,var(--ac),var(--pink))] group-hover:text-white group-hover:shadow-[0_8px_20px_var(--glow)]">
                        {num}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                          <Icon className="size-4 shrink-0 text-[var(--ac)]" strokeWidth={1.75} />
                          <h3 className="text-[15px] font-bold leading-snug text-[var(--ink)]">
                            {title}
                          </h3>
                          <span className={chipClass}>{chip}</span>
                        </div>
                        <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 2. What it can preview ── */}
      <section
        id="coverage"
        className="scroll-mt-28 border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
              Coverage
            </p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mx-auto mb-4 max-w-[720px] text-center text-[clamp(28px,4vw,46px)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
              What it can{' '}
              <em className="font-normal italic text-[var(--ac)]">preview.</em>
            </h2>
          </Reveal>
          <Reveal delay={150}>
            <p className="mx-auto max-w-[620px] text-center text-base leading-7 text-[var(--mut)]">
              Detection happens when you open a folder. What actually runs depends on the
              project — and on what is installed on your machine.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {coverage.map(({ icon: Icon, title, text, chips, note }, i) => (
              <Reveal key={title} as="article" delay={(i % 4) * 80}>
                <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span className="mb-4 grid size-10 place-items-center rounded-xl bg-[var(--bg2)]">
                    <Icon className="size-[19px] text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="text-[15px] font-bold leading-snug text-[var(--ink)]">{title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                  {note && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
                      {note}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
                    {chips.map((chip) => (
                      <span key={chip} className={chipClass}>
                        {chip}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Interactive Markdown toggle illustration */}
          <div className="mt-14 grid gap-10 lg:mt-16 lg:grid-cols-[.85fr_1.15fr] lg:items-center lg:gap-14">
            <Reveal>
              <div>
                <h3 className="max-w-[380px] text-[clamp(23px,3vw,32px)] font-bold leading-[1.15] tracking-[-0.035em] text-[var(--ink)]">
                  Markdown,{' '}
                  <em className="font-normal italic text-[var(--ac)]">both ways.</em>
                </h3>
                <p className="mt-4 max-w-[400px] text-sm leading-7 text-[var(--mut)]">
                  The Preview / Source switch sits right beside the file name. Read the
                  rendered page, flip to the markup to fix a heading or a link, and flip
                  back — without opening another tool.
                </p>
                <div className="mt-5 flex flex-wrap gap-1.5">
                  <span className={chipClass}>README.md</span>
                  <span className={chipClass}>Preview</span>
                  <span className={chipClass}>Source</span>
                </div>
                <p className="mt-6 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ac)]">
                  <MousePointerClick className="size-3.5" strokeWidth={2} />
                  Try the toggle
                </p>
              </div>
            </Reveal>
            <Reveal delay={120} variant="scale">
              <MarkdownToggleDemo />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 3. Good to know ── */}
      <section
        id="good-to-know"
        className="scroll-mt-28 border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20"
      >
        <div className="mx-auto max-w-[1180px]">
          <div className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
            <Reveal>
              <div>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Good to know
                </p>
                <h2 className="max-w-[440px] text-[clamp(27px,3.6vw,42px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                  The limits,{' '}
                  <em className="font-normal italic text-[var(--ac)]">stated plainly.</em>
                </h2>
              </div>
            </Reveal>
            <Reveal delay={100}>
              <p className="max-w-[420px] text-sm leading-7 text-[var(--mut)] lg:text-right">
                Preview is a convenience, not a universal runtime. These are the edges you
                will actually meet, plus the two behaviours worth knowing about.
              </p>
            </Reveal>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {caveats.map(({ icon: Icon, tone, title, text }, i) => (
              <Reveal key={title} as="article" delay={(i % 4) * 80}>
                <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
                  <span
                    className={
                      tone === 'warn'
                        ? 'mb-4 grid size-10 place-items-center rounded-xl bg-amber-500/10'
                        : 'mb-4 grid size-10 place-items-center rounded-xl bg-[var(--bg2)]'
                    }
                  >
                    <Icon
                      className={
                        tone === 'warn'
                          ? 'size-[19px] text-amber-600 dark:text-amber-400'
                          : 'size-[19px] text-[var(--ac)]'
                      }
                      strokeWidth={1.75}
                    />
                  </span>
                  <h3 className="text-[15px] font-bold leading-snug text-[var(--ink)]">{title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">{text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

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
                    Point it at{' '}
                    <em className="font-normal italic text-[var(--ac)]">your project.</em>
                  </h2>
                  <p className="mt-4 max-w-[480px] text-sm leading-7 text-[var(--mut)]">
                    The quickest way to find out whether your setup is covered is to open
                    it. ShadRox detects what it can run and asks before it runs anything.
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
                      href="/features"
                      className="group inline-flex items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-6 py-3 text-sm font-semibold text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--ac)] hover:text-[var(--ac)]"
                    >
                      See every feature
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
                    First run, in three steps
                  </h3>
                  <ol className="mt-5 space-y-4">
                    {firstRun.map((line, i) => (
                      <li key={line} className="flex gap-3.5 text-[13px] leading-6 text-[var(--ink2)]">
                        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-[var(--bg2)] font-mono text-[11px] font-bold text-[var(--ac)]">
                          {i + 1}
                        </span>
                        {line}
                      </li>
                    ))}
                  </ol>
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