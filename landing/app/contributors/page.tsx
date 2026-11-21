import type { Metadata } from 'next'
import { ArrowUpRight, Briefcase, Crown, GitBranch, HeartHandshake, MessageSquareWarning, Sparkles } from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Reveal } from '@/components/landing/reveal'
import { contributors } from '@/lib/contributors'
import { GITHUB_REPO } from '@/lib/download'

export const metadata: Metadata = {
  title: 'ShadRox — Contributors & supporters',
  description:
    'The people who genuinely helped ShadRox — beta testers, bug reporters and supporters. A public thank-you wall with names, LinkedIn profiles and what each person did.',
  alternates: { canonical: '/contributors' },
}

const eyebrow = 'text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]'

const COMPANY_LINKEDIN = 'https://www.linkedin.com/company/shadrox'

const FOUNDER = {
  name: 'Sourav Maurya',
  linkedin: 'https://www.linkedin.com/company/shadrox',
  github: 'https://github.com/iamsouravmourya-jpg',
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

const ways = [
  {
    icon: MessageSquareWarning,
    title: 'Break the beta',
    text: 'Install ShadRox, use it on your real projects and report what fails. Every honest bug report makes the app better.',
    link: { label: 'Report an issue', href: `${GITHUB_REPO}/issues` },
  },
  {
    icon: Sparkles,
    title: 'Spread the word',
    text: 'Tell a developer friend, share the site, or post about ShadRox on LinkedIn. Genuine word of mouth is how a solo project grows.',
    link: { label: 'ShadRox on LinkedIn', href: COMPANY_LINKEDIN },
  },
  {
    icon: HeartHandshake,
    title: 'Help someone use it',
    text: 'Answer a question, write a tutorial, or help another tester get set up. Teaching counts as helping.',
    link: { label: 'Read the FAQ', href: '/faq' },
  },
]

export default function ContributorsPage() {
  return (
    <PageShell
      eyebrow="Thank you"
      title="Built solo,"
      accent="helped by many."
      sub="ShadRox is one person's project, but not one person's effort. Everyone who genuinely helps — testing, reporting, spreading the word — gets a permanent spot on this wall."
    >
      {/* ── The wall ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>The wall</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[720px] text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
              People who <em className="font-normal italic text-[var(--ac)]">showed up.</em>
            </h2>
          </Reveal>

          {/* ── Founder spotlight — first name on the wall, always ── */}
          <Reveal delay={120} variant="scale">
            <div className="relative mt-12 overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div
                aria-hidden
                className="pointer-events-none absolute -left-24 -top-28 size-72 rounded-full blur-3xl"
                style={{ background: 'var(--glow)' }}
              />
              <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center">
                <span
                  aria-hidden
                  className="grid size-20 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,var(--ac),var(--pink))] text-2xl font-bold text-white shadow-[0_10px_28px_var(--glow)]"
                >
                  {initials(FOUNDER.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ac)]">
                    <Crown className="size-3.5" strokeWidth={2} />
                    The one who built it
                  </p>
                  <h3 className="mt-3 text-xl font-bold tracking-[-0.02em] text-[var(--ink)]">
                    {FOUNDER.name}
                  </h3>
                  <p className="mt-1.5 max-w-[560px] text-sm leading-6 text-[var(--mut)]">
                    Wrote the first line, designed every screen, and still ships the fixes.
                    Everyone below helped — this one made the thing they helped with.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
                    <a
                      href={FOUNDER.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-center gap-2 text-[13px] font-bold text-[var(--ac)] transition hover:gap-3"
                    >
                      <Briefcase className="size-4" strokeWidth={1.75} />
                      LinkedIn
                      <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                    <a
                      href={FOUNDER.github}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-center gap-2 text-[13px] font-bold text-[var(--ac)] transition hover:gap-3"
                    >
                      <GitBranch className="size-4" strokeWidth={1.75} />
                      GitHub
                      <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {contributors.length > 0 ? (
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {contributors.map((person, i) => (
                <Reveal key={person.name} as="article" delay={(i % 3) * 90} variant="scale" className="h-full">
                  <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
                    <span
                      aria-hidden
                      className="grid size-14 place-items-center rounded-full bg-[linear-gradient(135deg,var(--ac),var(--pink))] text-lg font-bold text-white shadow-[0_10px_28px_var(--glow)]"
                    >
                      {initials(person.name)}
                    </span>
                    <h3 className="mt-5 text-[17px] font-bold tracking-[-0.02em] text-[var(--ink)]">
                      {person.name}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[var(--mut)]">{person.note}</p>
                    <a
                      href={person.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group mt-auto inline-flex items-center gap-2 pt-5 text-[13px] font-bold text-[var(--ac)] transition hover:gap-3"
                    >
                      <Briefcase className="size-4" strokeWidth={1.75} />
                      LinkedIn
                      <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  </div>
                </Reveal>
              ))}
            </div>
          ) : (
            <Reveal delay={140} variant="scale">
              <div className="relative mt-8 overflow-hidden rounded-3xl border border-dashed border-[var(--line)] bg-[var(--card)] p-8 text-center sm:p-12">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl"
                  style={{ background: 'var(--glow)' }}
                />
                <p className="relative text-balance text-xl font-bold tracking-[-0.02em] text-[var(--ink)] sm:text-2xl">
                  The first name is up. This wall is waiting for the next one.
                </p>
                <p className="relative mx-auto mt-3 max-w-md text-sm leading-7 text-[var(--mut)]">
                  No paid credits, no fake logos — only people who actually helped. Help ShadRox
                  genuinely and your name, LinkedIn and your contribution go up here.
                </p>
              </div>
            </Reveal>
          )}
        </div>
      </section>

      {/* ── How to earn a spot ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <p className={`mb-4 ${eyebrow}`}>Earn a spot</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="max-w-[720px] text-balance text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
              Three ways to <em className="font-normal italic text-[var(--ac)]">genuinely help.</em>
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ways.map(({ icon: Icon, title, text, link }, i) => (
              <Reveal key={title} as="article" delay={(i % 3) * 90} variant="scale" className="h-full">
                <div className="feature-card flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
                  <span className="mb-5 grid size-11 place-items-center rounded-2xl bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <h3 className="text-[17px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                    {title}
                  </h3>
                  <p className="mt-2.5 text-sm leading-6 text-[var(--mut)]">{text}</p>
                  <a
                    href={link.href}
                    {...(link.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    className="group mt-auto inline-flex items-center gap-1.5 pt-5 text-[13px] font-bold text-[var(--ac)] transition hover:gap-2.5"
                  >
                    {link.label}
                    <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </a>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <p className="mt-10 max-w-[640px] text-xs leading-6 text-[var(--mut)]">
              Spots are added by the maintainer, by hand, when the help is real. Names and LinkedIn
              profiles are published only with the person&apos;s okay.
            </p>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}