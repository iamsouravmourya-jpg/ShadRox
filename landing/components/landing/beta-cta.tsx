'use client'

import Link from 'next/link'
import { ArrowRight, Download } from 'lucide-react'
import { APP_VERSION, RELEASES_URL, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { Reveal } from './reveal'

export function BetaCta() {
  return (
    <section id="get-shadrox" className="border-t border-[var(--line)] bg-[var(--bg)] py-20 lg:py-28">
      <div className="container-page">
        <Reveal variant="scale">
          <div
            className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/10 text-center"
            style={{
              background:
                'linear-gradient(160deg, #0b1020 0%, #171a3a 48%, #0b1020 100%)',
              boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.08), 0 40px 90px -40px rgba(15,23,42,0.6)',
            }}
          >
            {/* Aurora accents */}
            <div
              aria-hidden
              className="pointer-events-none absolute -top-32 left-1/2 size-[28rem] -translate-x-1/2 rounded-full blur-[90px]"
              style={{ background: 'radial-gradient(closest-side, color-mix(in srgb, var(--ac) 55%, transparent), transparent)' }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-28 -right-24 size-72 rounded-full blur-[90px]"
              style={{ background: 'radial-gradient(closest-side, color-mix(in srgb, var(--pink) 45%, transparent), transparent)' }}
            />

            <div id="download" className="relative scroll-mt-28 px-6 py-12 sm:px-12 sm:py-14 lg:px-16 lg:py-16">
              <div className="mx-auto mb-6 grid size-12 place-items-center rounded-xl border border-white/15 bg-white/[0.06]">
                <Download className="size-5 text-white" aria-hidden />
              </div>

              <h2 className="mx-auto max-w-[560px] text-[clamp(1.75rem,3.6vw,2.625rem)] font-bold leading-[1.1] tracking-[-0.04em] text-white">
                Download ShadRox for Windows.
              </h2>
              <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-white/75">
                Version {APP_VERSION} for Windows 10 or 11 (64-bit). Free to download. On first
                launch the app asks you to sign in with Google, then you connect your own Gemini,
                Groq, or compatible provider key.
              </p>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a
                  href={WINDOWS_DOWNLOAD_URL}
                  className="group inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-7 py-3 text-sm font-bold text-[#1e1b4b] shadow-[inset_0_-1px_0_rgba(15,23,42,0.12),0_2px_4px_rgba(0,0,0,0.2),0_16px_36px_-12px_rgba(0,0,0,0.55)] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-[inset_0_-1px_0_rgba(15,23,42,0.12),0_3px_6px_rgba(0,0,0,0.22),0_22px_46px_-14px_rgba(0,0,0,0.6)] sm:w-auto"
                >
                  <Download className="size-4" aria-hidden />
                  Download for Windows
                </a>
                <Link
                  href={RELEASES_URL}
                  className="group inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-full border border-white/20 bg-white/[0.04] px-7 py-3 text-sm font-semibold text-white transition-colors duration-300 hover:border-white/40 hover:bg-white/10 sm:w-auto"
                >
                  All releases
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </div>

              <p className="mt-5 text-xs leading-5 text-white/65">
                Windows may warn about an unsigned installer — More → Run anyway.
                The app checks for newer releases when it starts.
              </p>

              <p className="mt-6 text-xs text-white/70">
                Founded &amp; built by{' '}
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
