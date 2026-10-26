'use client'

import { ArrowRight, Download, Mail } from 'lucide-react'
import { Reveal } from './reveal'

export function BetaCta() {
  return (
    <section id="beta" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-20 lg:px-8 lg:py-28">
      <Reveal variant="scale">
        <div className="relative mx-auto max-w-3xl overflow-hidden rounded-3xl border border-violet-300/20 bg-[radial-gradient(circle_at_50%_0%,rgba(167,139,250,.2),transparent_60%),#11131a] p-7 text-center sm:p-12">
          <div className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full bg-violet-500/20 blur-3xl glow-dot" />
          <div id="download" className="relative scroll-mt-24">
            <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-violet-300 text-[#16121f] shadow-[0_0_30px_rgba(196,181,253,.35)]">
              <Download className="size-5" />
            </div>
            <h2 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
              The Windows installer is coming soon.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-zinc-400">
              This is a preview button—not a live download. We are preparing the beta installer and
              will share it with testers when it is ready.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                type="button"
                disabled
                className="inline-flex cursor-not-allowed items-center gap-2 rounded-full border border-white/10 bg-white/[.06] px-6 py-3 text-sm font-semibold text-zinc-500"
              >
                <Download className="size-4" />
                Download for Windows
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">Coming soon</span>
              </button>
              <a
                href="mailto:hello@shadrox.app?subject=ShadRox%20beta%20access&body=Hi%2C%20I%27d%20like%20to%20request%20access%20to%20the%20ShadRox%20beta."
                className="group inline-flex items-center rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-violet-100"
              >
                <Mail className="mr-2 size-4" />
                Request beta access
                <ArrowRight className="ml-1.5 size-4 transition-transform group-hover:translate-x-0.5" />
              </a>
            </div>
            <p className="mt-4 text-xs text-zinc-500">Beta requests open an email draft. There is no online signup form yet.</p>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
