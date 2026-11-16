'use client'

import { LayoutDashboard, SunMedium, MessageSquare } from 'lucide-react'
import { APP_VERSION } from '@/lib/download'
import { Reveal } from './reveal'

const notes = [
  {
    icon: LayoutDashboard,
    title: 'One workspace, less noise',
    text: 'A rebuilt hub for opening folders and files, and a composer with exactly three run modes — Ask, Plan and Agent — so the boundary of what the next turn may touch is always visible.',
  },
  {
    icon: SunMedium,
    title: 'Day and night, nothing else',
    text: 'One toggle switches between the light and dark themes. Until you pick a side the app follows your OS; after that your choice is remembered.',
  },
  {
    icon: MessageSquare,
    title: 'Feedback that reaches the maker',
    text: 'The top-bar Feedback button sends only the message you type — marked as a bug or a feature — with the date, straight to a private Google Sheet. No account details, no diagnostics.',
  },
]

export function WhatsNew() {
  return (
    <section id="new" className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-24">
      <div className="container-page">
        <Reveal>
          <p className="eyebrow mb-3 text-center">
            Release notes
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(1.875rem,3.8vw,3.25rem)] font-bold leading-[1.08] tracking-[-0.04em] text-[var(--ink)]">
            New in v{APP_VERSION} —{' '}
            <em className="font-normal italic text-[var(--ac)]">calmer by default.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-12 max-w-[620px] text-center text-base leading-7 text-[var(--mut)]">
            A rebuilt workspace, three honest run modes, day and night themes, and a feedback
            path that carries only your message — still free, still BYOK.
          </p>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-3">
          {notes.map(({ icon: Icon, title, text }, i) => (
            <Reveal key={title} delay={i * 100} className="h-full">
              <article className="feature-card flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                <span className="grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                  <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                </span>
                <h3 className="mt-5 text-[16px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                  {title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--mut)]">{text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200}>
          <p className="mx-auto mt-8 max-w-[760px] rounded-2xl border border-[var(--line)] bg-[var(--card)] px-5 py-4 text-center text-[13px] leading-6 text-[var(--mut)]">
            Every shell command asks first, with a plain-language risk notice. Free during beta —
            bring your own key.{' '}
            <a
              href={`https://github.com/iamsouravmourya-jpg/ShadRox/releases/tag/v${APP_VERSION}`}
              className="font-semibold text-[var(--ac)] underline-offset-2 hover:underline"
            >
              Full release notes →
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  )
}