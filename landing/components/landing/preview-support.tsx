'use client'

import { Check, Play } from 'lucide-react'
import { Reveal } from './reveal'

const supported = ['Static sites', 'Vite & Next.js', 'Node-based web projects', 'Python · Go · PHP · Java · .NET backends']
const caveats = ['The backend runtime must be installed on your machine', 'External sites that block embedded previews', 'Click-to-source works for pages served by ShadRox']

export function PreviewSupport() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
      <Reveal variant="scale">
        <div className="relative overflow-hidden rounded-2xl border border-violet-300/20 bg-[radial-gradient(circle_at_top_right,rgba(167,139,250,.15),transparent_40%),#11131a] p-7 sm:p-10 lg:p-14">
          <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-violet-500/10 blur-3xl" />
          <div className="relative grid gap-10 lg:grid-cols-[1fr_.8fr] lg:items-end">
            <div>
              <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-violet-300">
                Preview support
              </p>
              <h2 className="max-w-xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
                Preview the web projects you are working on.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-zinc-400">
                ShadRox can serve static sites, launch detected Node-based web projects with supported
                package scripts, and run detected Python, Go, PHP, Java, and .NET backends through the
                runtime installed on your machine. Some apps also restrict embedding in previews.
              </p>

              <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-300/80">
                    Currently supported
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {supported.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/[.06] px-2.5 py-1 text-[11px] text-emerald-100"
                      >
                        <Check className="size-3" /> {s}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex-1">
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                    Good to know
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {caveats.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center rounded-full border border-white/8 bg-white/[.03] px-2.5 py-1 text-[11px] text-zinc-500"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[.03] px-4 py-3 text-sm text-zinc-300">
              <Play className="size-4 text-violet-300" /> Managed run actions, with your approval.
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
