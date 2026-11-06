'use client'

import { ArrowUpRight, Download } from 'lucide-react'
import { APP_VERSION, RELEASES_URL, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { Reveal } from './reveal'

export function BetaCta() {
  return (
    <section id="beta" className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <Reveal variant="scale">
          <div
            className="relative mx-auto max-w-3xl overflow-hidden rounded-3xl p-8 text-center sm:p-12"
            style={{
              background: 'linear-gradient(155deg, #2a3142 0%, #6d7382 42%, #6a4de0 74%, #3ec8ea 100%)',
            }}
          >
            {/* Orb decorations */}
            <div
              className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full blur-3xl"
              style={{ background: 'rgba(255,255,255,0.14)' }}
            />
            <div
              className="pointer-events-none absolute -bottom-20 -right-20 size-56 rounded-full blur-3xl"
              style={{ background: 'rgba(255,255,255,0.1)' }}
            />

            <div id="download" className="relative scroll-mt-24">
              <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-white/20 shadow-[0_0_30px_rgba(255,255,255,0.3)]">
                <Download className="size-5 text-white" />
              </div>

              <h2 className="text-3xl font-bold tracking-[-0.04em] text-white sm:text-4xl">
                Download ShadRox for Windows.
              </h2>
              <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-white/80">
                Version {APP_VERSION} for Windows 10 or 11 (64-bit). Free to download. On first
                launch the app asks you to sign in with Google, then you connect your own Gemini,
                Groq, or compatible provider key.
              </p>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a
                  href={WINDOWS_DOWNLOAD_URL}
                  className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-white px-7 py-3.5 text-sm font-bold text-[#3a1fa8] shadow-[0_12px_40px_rgba(0,0,0,0.25)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)]"
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 -translate-x-full bg-[linear-gradient(105deg,transparent_30%,rgba(109,74,255,0.15)_50%,transparent_70%)] transition-transform duration-700 group-hover:translate-x-full"
                  />
                  <Download className="size-4" />
                  Download for Windows
                </a>
                <a
                  href={RELEASES_URL}
                  className="group inline-flex items-center gap-1.5 rounded-full border border-white/25 px-7 py-3.5 text-sm font-semibold text-white transition hover:border-white/50 hover:bg-white/10"
                >
                  All releases
                  <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </a>
              </div>

              <p className="mt-5 text-xs text-white/60">
                Windows may warn about an unsigned installer — More → Run anyway.
                New versions download and install automatically.
              </p>

              <p className="mt-6 text-xs text-white/70">
                Built in the open by{' '}
                <strong className="font-bold text-white">Sourav Maurya</strong>,
                a 19-year-old developer from Delhi, India 🇮🇳
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
