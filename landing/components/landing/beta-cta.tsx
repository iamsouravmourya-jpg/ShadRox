'use client'

import { ArrowUpRight, Download } from 'lucide-react'
import { APP_VERSION, RELEASES_URL, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
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
              Download ShadRox for Windows.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-zinc-400">
              Version {APP_VERSION} for Windows 10 or 11 (64-bit). The installer is free to download.
              On first launch the app asks you to sign in with Google, then you connect your own
              Gemini or Groq key.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={WINDOWS_DOWNLOAD_URL}
                className="inline-flex items-center gap-2 rounded-full bg-violet-300 px-6 py-3 text-sm font-semibold text-[#16121f] shadow-[0_0_30px_rgba(196,181,253,.18)] transition hover:bg-violet-200"
              >
                <Download className="size-4" />
                Download for Windows
              </a>
              <a
                href={RELEASES_URL}
                className="group inline-flex items-center rounded-full border border-white/15 px-6 py-3 text-sm font-semibold text-zinc-200 transition hover:border-white/30 hover:text-white"
              >
                All releases
                <ArrowUpRight className="ml-1.5 size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </a>
            </div>
            <p className="mt-4 text-xs text-zinc-500">
              Windows may warn about an unsigned installer. More → Run anyway. New versions
              download and install automatically.
            </p>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
