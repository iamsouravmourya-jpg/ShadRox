'use client'

import { GitCompareArrows, ShieldCheck, Sparkles } from 'lucide-react'
import { APP_VERSION } from '@/lib/download'
import { Reveal } from './reveal'

const notes = [
  {
    icon: Sparkles,
    kicker: '01. Unified agent',
    title: 'One autonomous agent, auto-routed',
    text: 'No mode switcher to manage. ShadRox classifies every turn and routes it automatically — a greeting sends a tiny prompt with zero tools, while a build request unlocks reads, edits, preview, Git, and guarded commands. Inline <svg> generation is built in.',
  },
  {
    icon: ShieldCheck,
    kicker: '02. Security',
    title: 'Enterprise hardening & NTFS safety',
    text: 'Custom AI endpoints verify DNS A/AAAA records against SSRF rebinding, popup windows run strictly sandboxed, .env secrets are excluded from packaging, and Windows NTFS rewinds plus process trees clean up reliably.',
  },
  {
    icon: GitCompareArrows,
    kicker: '03. Source control',
    title: 'Git Push / Pull / Sync + 1-click restore',
    text: 'Review inline diffs, then Push, Pull, or Sync without leaving the app. AI Studio-style checkpoints add a one-click ↺ Restore that rewinds files and your local Git position when a turn goes sideways.',
  },
]

export function WhatsNew() {
  return (
    <section id="new" className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-24">
      <div className="container-page">
        <Reveal>
          <p className="eyebrow mb-3 text-center">
            Release v{APP_VERSION}
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(1.875rem,3.8vw,3.25rem)] font-bold leading-[1.08] tracking-[-0.04em] text-[var(--ink)]">
            New in v{APP_VERSION} —{' '}
            <em className="font-normal italic text-[var(--ac)]">sharper under pressure.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-12 max-w-[640px] text-center text-base leading-7 text-[var(--mut)]">
            One auto-routed autonomous agent, ultra-lean BYOK token usage, hardened desktop
            security, and one-click checkpoints with Git Push / Pull / Sync built in.
          </p>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-3">
          {notes.map(({ icon: Icon, kicker, title, text }, i) => (
            <Reveal key={title} delay={i * 100} className="h-full">
              <article className="feature-card flex h-full flex-col rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-7">
                <div className="flex items-center justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <Icon className="size-5 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="font-mono text-[11px] font-semibold text-[var(--mut)]">
                    {kicker}
                  </span>
                </div>
                <h3 className="mt-5 text-[16px] font-bold leading-snug tracking-[-0.02em] text-[var(--ink)]">
                  {title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--mut)]">{text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200}>
          <div className="mx-auto mt-8 flex max-w-[780px] flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-5 py-4 text-center text-[13px] leading-6 text-[var(--mut)]">
            <span>
              Risk-tiered shell guard with plain-language risk notices. Still free, still BYOK.
            </span>
            <a
              href="/releases"
              className="font-semibold text-[var(--ac)] underline-offset-2 hover:underline whitespace-nowrap"
            >
              Read full v{APP_VERSION} release notes →
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  )
}