import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowUpRight,
  Atom,
  Briefcase,
  CodeXml,
  Cpu,
  Database,
  Download,
  FolderGit,
  Globe,
  IndianRupee,
  Info,
  KeyRound,
  MapPin,
  ScrollText,
  SquareTerminal,
  Zap,
} from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { APP_VERSION, GITHUB_REPO, WINDOWS_DOWNLOAD_URL } from '@/lib/download'

export const metadata: Metadata = {
  title: 'About the maker — ShadRox',
  description:
    'ShadRox is a solo project by Sourav Maurya, a 19-year-old full-stack developer and AI engineer from Delhi, India. Why it exists, what it is built with, and an honest account of the beta.',
  alternates: { canonical: '/about' },
}

const eyebrow = 'text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]'
const chip =
  'rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink2)]'
const badge =
  'inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-3 py-1 text-[11px] font-semibold text-[var(--ink2)]'

const GITHUB_PROFILE = 'https://github.com/iamsouravmourya-jpg'
const LINKEDIN_PROFILE = 'https://www.linkedin.com/in/sourav-maurya-45b272377'
const SITE_URL = 'https://www.shadrox.cyou'

const makerLinks: { icon: typeof Globe; label: string; href: string }[] = [
  { icon: CodeXml, label: 'GitHub', href: GITHUB_PROFILE },
  { icon: FolderGit, label: 'ShadRox repo', href: GITHUB_REPO },
  { icon: Briefcase, label: 'LinkedIn', href: LINKEDIN_PROFILE },
  { icon: Globe, label: 'shadrox.cyou', href: SITE_URL },
]

const before = ['editor', 'terminal', 'browser preview', 'separate AI tool']
const inside = ['files', 'editor', 'AI chat', 'preview', 'Git tools', 'terminal']

const stack: { icon: typeof Cpu; name: string; detail: string }[] = [
  { icon: Cpu, name: 'Electron', detail: 'v44' },
  { icon: Atom, name: 'React', detail: 'v19' },
  { icon: CodeXml, name: 'CodeMirror', detail: 'v6' },
  { icon: SquareTerminal, name: 'xterm.js', detail: 'terminal' },
  { icon: Zap, name: 'Vite', detail: 'v8' },
  { icon: Database, name: 'Supabase', detail: 'Google sign-in' },
]

const facts: { label: string; value: string; mono?: boolean }[] = [
  { label: 'Maker', value: 'Sourav Maurya' },
  { label: 'Based in', value: 'Delhi, India' },
  { label: 'Team', value: 'One person — no company' },
  { label: 'Platform', value: 'Windows 10 / 11, 64-bit' },
  { label: 'Current version', value: `v${APP_VERSION}`, mono: true },
  { label: 'Stage', value: 'Beta' },
  { label: 'AI access', value: 'Bring your own key' },
]

const notes: { icon: typeof Info; title: string; text: string; link?: { label: string; href: string } }[] = [
  {
    icon: Info,
    title: 'Beta software',
    text: 'ShadRox is beta, not a mature replacement for a general-purpose IDE. Agent output and model-generated edits can be incorrect, so review changes and keep backups of important work.',
  },
  {
    icon: ScrollText,
    title: 'Proprietary, source in the open',
    text: 'ShadRox is proprietary software. The source is published on GitHub for viewing only — not as an open-source project.',
    link: { label: 'View the repo', href: GITHUB_REPO },
  },
  {
    icon: KeyRound,
    title: 'Bring your own key',
    text: 'Use Gemini, Groq or any OpenAI-compatible endpoint, including local gateways such as Ollama and LM Studio. Turns on your own key are neither metered nor capped — your provider bills you directly.',
  },
  {
    icon: IndianRupee,
    title: 'Locked beta prices',
    text: 'The ₹699 Starter and ₹1,299 Heavy catalogue plans are locked beta prices only. Checkout and shared-key access are not enabled, and prices may change before launch.',
  },
]

export default function AboutPage() {
  return (
    <PageShell
      eyebrow="The maker"
      title="Built solo,"
      accent="in the open."
      sub="ShadRox is one person's project: a native Windows workspace for local projects, written and maintained by Sourav Maurya from Delhi, India. No company, no team page — just the app, this site and the repo."
    >
      {/* ── Maker + story ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid items-start gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:gap-10">
            {/* Maker card */}
            <Reveal variant="scale">
              <div className="feature-card relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -left-20 -top-24 size-56 rounded-full blur-3xl"
                  style={{ background: 'var(--glow)' }}
                />
                <div className="relative">
                  <span
                    aria-hidden
                    className="grid size-20 place-items-center rounded-full bg-[linear-gradient(135deg,var(--ac),var(--pink))] text-2xl font-bold tracking-[-0.02em] text-white shadow-[0_10px_28px_var(--glow)]"
                  >
                    SM
                  </span>

                  <h2 className="mt-6 text-2xl font-bold tracking-[-0.03em] text-[var(--ink)]">
                    Sourav Maurya
                  </h2>
                  <p className="mt-1.5 text-sm leading-6 text-[var(--mut)]">
                    Full-stack developer &amp; AI engineer
                  </p>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <span className={badge}>19 years old</span>
                    <span className={badge}>
                      <MapPin className="size-3 text-[var(--ac)]" strokeWidth={2} />
                      Delhi, India
                    </span>
                    <span className={badge}>Solo maintainer</span>
                  </div>

                  <p className="mt-6 border-t border-[var(--line)] pt-6 text-[13px] leading-6 text-[var(--mut)]">
                    Maintains the desktop app, this website and the GitHub repo — one person,
                    end to end.
                  </p>

                  <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                    {makerLinks.map(({ icon: Icon, label, href }) => (
                      <a
                        key={label}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-center gap-2.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-4 py-2.5 text-[13px] font-semibold text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--ac)] hover:text-[var(--ac)]"
                      >
                        <Icon className="size-4 shrink-0 text-[var(--ac)]" strokeWidth={1.75} />
                        <span className="truncate">{label}</span>
                        <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-[var(--mut)] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[var(--ac)]" />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>

            {/* Story */}
            <Reveal delay={100}>
              <div className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8 lg:p-10">
                <p className={`mb-4 ${eyebrow}`}>Why it exists</p>
                <h2 className="max-w-md text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                  One window instead of{' '}
                  <em className="font-normal italic text-[var(--ac)]">four.</em>
                </h2>

                <div className="mt-6 space-y-4 text-sm leading-7 text-[var(--mut)]">
                  <p>
                    Working on a local project meant keeping an editor, a terminal, a browser
                    preview and a separate AI tool open at once — and moving between them for every
                    small change. ShadRox puts files, editor, AI chat, preview, Git tools and
                    terminal into one native Windows app, so writing, running and reviewing stay in
                    the same place.
                  </p>
                  <p>
                    The agent is bounded: it reads first, proposes changes as diffs, and waits for
                    you to review and accept them. Commands are approval-gated, and unsafe patches
                    are held instead of written in place.
                  </p>
                  <p>
                    There is no company behind ShadRox. It is built in the open: the source is
                    published on GitHub for viewing, installers ship from the releases page, and
                    anything that behaves differently from these pages belongs in the issue
                    tracker.
                  </p>
                </div>

                {/* Before → now */}
                <div className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-5">
                  <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--mut)]">
                    Before
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {before.map((b) => (
                      <code key={b} className={chip}>
                        {b}
                      </code>
                    ))}
                  </div>

                  <div className="my-4 flex items-center gap-3" aria-hidden>
                    <span className="h-px flex-1 bg-[var(--line)]" />
                    <ArrowRight className="size-4 shrink-0 text-[var(--ac)]" />
                    <span className="h-px flex-1 bg-[var(--line)]" />
                  </div>

                  <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--mut)]">
                    One app
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {inside.map((s) => (
                      <code
                        key={s}
                        className="rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--ac)]"
                      >
                        {s}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Stack + facts ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>Under the hood</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[720px] text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
              The stack, and the{' '}
              <em className="font-normal italic text-[var(--ac)]">plain facts.</em>
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            {/* Stack */}
            <Reveal variant="scale">
              <div className="feature-card h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                <h3 className="text-[19px] font-bold tracking-[-0.02em] text-[var(--ink)]">
                  Built with
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--mut)]">
                  The pieces behind the Windows app, from the desktop shell to the editor, the
                  terminal and Google sign-in.
                </p>

                <div className="mt-7 grid gap-3 sm:grid-cols-2">
                  {stack.map(({ icon: Icon, name, detail }) => (
                    <div
                      key={name}
                      className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] px-4 py-3.5 transition-colors duration-300 hover:border-[var(--ac)]"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--card)]">
                        <Icon className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0">
                        <b className="block truncate text-sm font-bold text-[var(--ink)]">{name}</b>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--mut)]">
                          {detail}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>

            {/* Facts */}
            <Reveal delay={100} variant="scale">
              <div className="feature-card h-full rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                <h3 className="text-[19px] font-bold tracking-[-0.02em] text-[var(--ink)]">
                  At a glance
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--mut)]">
                  Who makes it, where it runs and what state it is in.
                </p>

                <dl className="mt-7">
                  {facts.map(({ label, value, mono }) => (
                    <div
                      key={label}
                      className="flex items-baseline justify-between gap-5 border-b border-[var(--line)] py-3.5 last:border-b-0 last:pb-0"
                    >
                      <dt className="shrink-0 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--mut)]">
                        {label}
                      </dt>
                      <dd
                        className={
                          mono
                            ? 'text-right font-mono text-[13px] font-semibold text-[var(--ac)]'
                            : 'text-right text-sm font-semibold text-[var(--ink)]'
                        }
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Honest notes ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>Honest notes</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[720px] text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
              What ShadRox <em className="font-normal italic text-[var(--ac)]">is not.</em>
            </h2>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-5 max-w-[640px] text-pretty text-sm leading-7 text-[var(--mut)]">
              A solo beta has limits. These are the ones worth knowing before you install it.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {notes.map(({ icon: Icon, title, text, link }, i) => (
              <Reveal key={title} as="article" delay={(i % 2) * 90} variant="scale" className="h-full">
                <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                  <span className="mb-5 grid size-11 place-items-center rounded-2xl bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="text-[17px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="mt-2.5 text-sm leading-6 text-[var(--mut)]">{text}</p>
                  {link && (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group mt-auto inline-flex items-center gap-1.5 pt-5 text-[13px] font-bold text-[var(--ac)] transition hover:gap-2.5"
                    >
                      {link.label}
                      <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
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
                    Built solo.{' '}
                    <em className="font-normal italic text-[var(--ac)]">Yours to try.</em>
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