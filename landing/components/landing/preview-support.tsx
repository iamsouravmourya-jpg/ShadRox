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
    <section className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-28">
      <div className="container-page">
        <Reveal variant="scale">
          <div className="relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-6 sm:p-10 lg:p-12">
            {/* Glow orb */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full blur-3xl"
              style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
            />

            <div className="relative grid gap-10 lg:grid-cols-[1.1fr_.9fr] lg:items-end lg:gap-14">
              <div>
                <p className="eyebrow mb-4">
                  Preview support
                </p>
                <h2 className="max-w-xl text-[clamp(1.625rem,3.2vw,2.5rem)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                  Preview the web projects{' '}
                  <em className="font-normal italic text-[var(--ac)]">you are working on.</em>
                </h2>
                <p className="mt-4 max-w-xl text-[13.5px] leading-6 text-[var(--mut)]">
                  ShadRox can serve static sites and launch detected Node-based web projects with
                  supported package scripts. It detects Python, Go, PHP, Java, and .NET entry
                  points — the runtime itself must be installed on your machine. Opening a project
                  workspace automatically starts its detected preview script and may offer to
                  install missing dependencies.
                </p>

                <div className="mt-8 grid gap-6 sm:grid-cols-2">
                  <div>
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">
                      Currently supported
                    </p>
                    <ul className="space-y-1.5 border-t border-[var(--line)] pt-3">
                      {supported.map((s) => (
                        <li
                          key={s}
                          className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--ink2)]"
                        >
                          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--mut)]">
                      Good to know
                    </p>
                    <ul className="space-y-1.5 border-t border-[var(--line)] pt-3">
                      {caveats.map((s) => (
                        <li
                          key={s}
                          className="text-[12.5px] leading-5 text-[var(--mut)]"
                        >
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--card)] px-5 py-4 text-[13.5px] font-medium leading-6 text-[var(--ink)] shadow-[0_1px_2px_var(--shadow)]">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--bg2)]">
                  <Play className="size-4 text-[var(--ac)]" aria-hidden />
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
