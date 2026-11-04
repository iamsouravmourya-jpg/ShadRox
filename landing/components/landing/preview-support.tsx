'use client'

import { Check, Play } from 'lucide-react'
import { Reveal } from './reveal'

const supported = [
  'Static sites',
  'Vite & Next.js',
  'Nuxt · Astro · SvelteKit',
  'Angular · webpack · Parcel',
  'Node-based web projects',
  'Python · Go · PHP · Java · .NET',
]
const caveats = [
  'Backend runtime must be installed on your machine',
  'Some external sites block embedded previews',
  'Click-to-source works for pages served by ShadRox',
]

export function PreviewSupport() {
  return (
    <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <Reveal variant="scale">
          <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg2)] p-7 sm:p-10 lg:p-14">
            {/* Glow orb */}
            <div
              className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full blur-3xl"
              style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
            />

            <div className="relative grid gap-10 lg:grid-cols-[1fr_.75fr] lg:items-end">
              <div>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                  Preview support
                </p>
                <h2 className="max-w-xl text-[clamp(26px,3.5vw,40px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
                  Preview the web projects{' '}
                  <em className="font-normal italic text-[var(--ac)]">you are working on.</em>
                </h2>
                <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--mut)]">
                  ShadRox can serve static sites and launch detected Node-based web projects with
                  supported package scripts. It detects Python, Go, PHP, Java, and .NET entry
                  points — the runtime itself must be installed on your machine. Opening a project
                  workspace automatically starts its detected preview script and may offer to
                  install missing dependencies.
                </p>

                <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-start">
                  <div className="flex-1">
                    <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
                      Currently supported
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {supported.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/[.07] px-3 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                        >
                          <Check className="size-3" /> {s}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1">
                    <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
                      Good to know
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {caveats.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[11px] text-[var(--mut)]"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-5 py-4 text-sm font-medium text-[var(--ink)]">
                <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-[var(--bg2)]">
                  <Play className="size-4 text-[var(--ac)]" />
                </div>
                Managed run actions, with your approval before anything installs or launches.
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
