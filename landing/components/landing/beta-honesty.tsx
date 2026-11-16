'use client'

import { Download } from 'lucide-react'
import { WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { Reveal } from './reveal'

const points = [
  'Review every AI diff and keep Git or backups for important work',
  'Google sign-in is required to enter the app',
  'Agent, autonomous run, team, plugin, and automation features are evolving',
  'Preview support depends on your project and installed runtimes',
  'Turns on your own key are neither metered nor capped; ShadRox has no plan, no checkout and no payments — your provider bills you directly',
]

export function BetaHonesty() {
  return (
    <section id="beta" className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-24">
      <div className="container-page">
        <Reveal variant="scale">
          <div className="grid gap-10 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-7 sm:p-10 lg:grid-cols-2 lg:gap-14 lg:p-12">
            <div>
              <p className="eyebrow mb-4">
                Beta status
              </p>
              <h2 className="text-[clamp(1.625rem,3.2vw,2.5rem)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                Beta, and <em className="font-normal italic text-[var(--ac)]">honest</em> about it.
              </h2>
              <p className="mt-5 max-w-md text-sm leading-7 text-[var(--mut)]">
                ShadRox is beta software, not a mature replacement for a general-purpose IDE.
                Agent output and model-generated edits can be incorrect, so review changes and
                keep backups for important work.
              </p>
            </div>
            <div>
              <ul className="space-y-3.5">
                {points.map((p) => (
                  <li key={p} className="flex gap-3 text-[13.5px] leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
              <a
                href={WINDOWS_DOWNLOAD_URL}
                className="cta-primary mt-7"
              >
                <Download className="size-4" aria-hidden />
                Download for Windows
              </a>
              <p className="mt-3 text-xs leading-5 text-[var(--mut)]">
                Windows shows a SmartScreen warning for unsigned builds — More → Run anyway.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}