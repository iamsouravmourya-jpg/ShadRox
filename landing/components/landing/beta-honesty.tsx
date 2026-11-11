'use client'

import { Download } from 'lucide-react'
import { WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { Reveal } from './reveal'

const points = [
  'Review every AI diff and keep Git or backups for important work',
  'Google sign-in is required to enter the app',
  'Agent, autonomous run, team, plugin, and automation features are evolving',
  'Preview support depends on your project and installed runtimes',
  'Turns on your own key are neither metered nor capped; the plan and credit-meter screens are previews, and public payments are not enabled',
]

export function BetaHonesty() {
  return (
    <section id="beta" className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-[1180px]">
        <Reveal variant="scale">
          <div className="grid gap-10 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-8 sm:p-10 lg:grid-cols-2 lg:gap-14 lg:p-12">
            <div>
              <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                Beta status
              </p>
              <h2 className="text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                Beta, and <em className="font-normal italic text-[var(--ac)]">honest</em> about it.
              </h2>
              <p className="mt-5 max-w-md text-sm leading-7 text-[var(--mut)]">
                ShadRox is beta software, not a mature replacement for a general-purpose IDE.
                Agent output and model-generated edits can be incorrect, so review changes and
                keep backups for important work.
              </p>
            </div>
            <div>
              <ul className="space-y-3">
                {points.map((p) => (
                  <li key={p} className="flex gap-3 text-sm leading-6 text-[var(--ink2)]">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
              <a
                href={WINDOWS_DOWNLOAD_URL}
                className="mt-7 inline-flex items-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
              >
                <Download className="size-4" />
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