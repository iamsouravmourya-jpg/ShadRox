'use client'

import { Download } from 'lucide-react'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { Reveal } from './reveal'
import { WorkspaceMockup } from './workspace-mockup'

export function Hero() {
  return (
    <section className="relative mx-auto max-w-[1180px] px-5 pb-20 pt-28 lg:px-8 lg:pb-28 lg:pt-36">
      {/* Orbs — clipped below lg so they can't widen the mobile layout viewport */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden lg:overflow-visible">
        <div
          className="pointer-events-none absolute -left-40 top-0 size-[560px] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(109,74,255,0.16), transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute -right-32 top-20 size-[460px] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(236,72,153,0.12), transparent 70%)' }}
        />
      </div>

      <div className="relative mx-auto max-w-3xl text-center">
        {/* Eyebrow pill */}
        <Reveal>
          <div className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--mut)] shadow-sm">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Desktop beta · Windows · v{APP_VERSION}
          </div>
        </Reveal>

        {/* Headline */}
        <Reveal delay={80}>
          <h1 className="text-balance text-5xl font-bold tracking-[-0.055em] text-[var(--ink)] sm:text-6xl lg:text-[88px] leading-[1.02]">
            Your project, code,{' '}
            <br className="hidden sm:block" />
            AI and preview{' '}
            <span className="text-gradient">in one workspace.</span>
          </h1>
        </Reveal>

        {/* Supporting copy — from README */}
        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-7 text-[var(--mut)] sm:text-[19px]">
            Open a project folder and work with its files, code editor, AI chat, live previews,
            Git tools and terminal together in one desktop app. Your project stays on your
            computer; AI only gets the prompt and context you choose to send.
          </p>
        </Reveal>

        {/* CTAs */}
        <Reveal delay={240}>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={WINDOWS_DOWNLOAD_URL}
              className="group relative w-full overflow-hidden rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-7 py-3.5 text-sm font-bold text-white shadow-[0_12px_36px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_48px_var(--glow)] sm:w-auto"
            >
              {/* shimmer */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 -translate-x-full bg-[linear-gradient(105deg,transparent_30%,rgba(255,255,255,0.4)_50%,transparent_70%)] transition-transform duration-700 group-hover:translate-x-full"
              />
              <span className="relative z-10 flex items-center justify-center gap-2">
                <Download className="size-4" />
                Download for Windows
              </span>
            </a>
            <a
              href="#flow"
              className="w-full rounded-full border border-[var(--line)] bg-[var(--card)] px-7 py-3.5 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)] sm:w-auto"
            >
              See how it works
            </a>
          </div>
          <p className="mt-4 text-[12px] text-[var(--mut)]">
            Windows 10 / 11 · 64-bit · Bring your own key · Auto-updates
          </p>
        </Reveal>
      </div>

      {/* Workspace Mockup */}
      <Reveal variant="scale" delay={120} className="relative mt-16 lg:mt-20">
        {/* Floating labels */}
        <div className="pointer-events-none absolute left-[6%] top-[20%] hidden items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)]/90 px-3.5 py-2 text-[12px] font-semibold text-[var(--ink)] shadow-lg backdrop-blur-sm md:flex" style={{animation:'float-soft 5s ease-in-out infinite'}}>
          <span>⌘K</span> Inline AI edit
        </div>
        <div className="pointer-events-none absolute right-[5%] top-[50%] hidden items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)]/90 px-3.5 py-2 text-[12px] font-semibold text-[var(--ink)] shadow-lg backdrop-blur-sm md:flex" style={{animation:'float-soft 5s ease-in-out infinite', animationDelay:'-2s'}}>
          👁️ Live preview
        </div>
        <div className="pointer-events-none absolute left-[14%] bottom-[1%] hidden items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)]/90 px-3.5 py-2 text-[12px] font-semibold text-[var(--ink)] shadow-lg backdrop-blur-sm md:flex" style={{animation:'float-soft 5s ease-in-out infinite', animationDelay:'-3.5s'}}>
          🔀 Git built in
        </div>

        <WorkspaceMockup />

        {/* Bottom trust badges */}
        <div className="absolute -bottom-5 left-1/2 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)]/90 px-5 py-2 text-[11px] text-[var(--mut)] shadow backdrop-blur sm:flex">
          <span className="size-2 rounded-full bg-emerald-500" />
          Local files
          <span className="text-[var(--line)]">·</span>
          Provider-powered AI
          <span className="text-[var(--line)]">·</span>
          Google sign-in
        </div>
      </Reveal>

      <p className="mt-10 text-center text-[12px] text-[var(--mut)]">
        Beta software · Features and availability may change.
      </p>
    </section>
  )
}
