'use client'

import { History, Camera, KeyRound } from 'lucide-react'
import { APP_VERSION } from '@/lib/download'
import { Reveal } from './reveal'

const notes = [
  {
    icon: History,
    title: 'Runs that survive a restart',
    text: 'Autonomous runs keep a durable journal. Pause, cancel or resume them — with token and time budgets that stop a run before it runs away.',
  },
  {
    icon: Camera,
    title: 'Proof, not promises',
    text: 'Acceptance checks capture screenshot, DOM and console evidence: a baseline before the change and a verified state after, so "it works" has receipts.',
  },
  {
    icon: KeyRound,
    title: 'Free + BYOK, nothing hidden',
    text: 'No plans, no checkout, no meter. Bring your own provider key — and every shell command still asks you first, with a plain-language risk notice.',
  },
]

export function WhatsNew() {
  return (
    <section id="new" className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-20 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--ac)]">
            Release notes
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(30px,4.5vw,52px)] font-bold tracking-[-0.04em] leading-[1.08] text-[var(--ink)]">
            New in v{APP_VERSION} —{' '}
            <em className="font-normal italic text-[var(--ac)]">runs that last.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-12 max-w-[620px] text-center text-base leading-7 text-[var(--mut)]">
            Long agent runs now survive restarts, carry screenshot-level proof, and stay inside
            budgets — and ShadRox is free + BYOK only.
          </p>
        </Reveal>

        <div className="grid gap-[18px] md:grid-cols-3">
          {notes.map(({ icon: Icon, title, text }, i) => (
            <Reveal key={title} delay={i * 100}>
              <article className="feature-card h-full rounded-[26px] border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                <span className="mb-5 grid size-[46px] place-items-center rounded-[14px] bg-[var(--bg2)]">
                  <Icon className="size-[22px] text-[var(--ac)]" strokeWidth={1.75} />
                </span>
                <h3 className="mb-2 text-[17px] font-bold leading-snug text-[var(--ink)]">{title}</h3>
                <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200}>
          <p className="mx-auto mt-8 max-w-[720px] rounded-2xl border border-[var(--line)] bg-[var(--card)] px-5 py-3.5 text-center text-[13px] leading-6 text-[var(--mut)]">
            Every shell command asks first, with a plain-language risk notice. Free during beta —
            bring your own key.{' '}
            <a
              href={`https://github.com/iamsouravmourya-jpg/ShadRox/releases/tag/v${APP_VERSION}`}
              className="font-semibold text-[var(--ac)] underline-offset-2 transition hover:underline"
            >
              Full release notes →
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  )
}