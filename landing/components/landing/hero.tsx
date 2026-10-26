'use client'

import { Check, Download } from 'lucide-react'
import { Reveal } from './reveal'
import { WorkspaceMockup } from './workspace-mockup'

export function Hero() {
  return (
    <section className="relative mx-auto max-w-6xl px-5 pb-20 pt-28 lg:px-8 lg:pb-28 lg:pt-36">
      {/* ambient glow */}
      <div className="pointer-events-none absolute -left-40 top-0 size-[520px] rounded-full bg-violet-500/10 blur-[120px] glow-dot" />
      <div className="pointer-events-none absolute -right-32 top-40 size-[380px] rounded-full bg-sky-500/10 blur-[120px]" />

      <div className="relative mx-auto max-w-3xl text-center">
        <Reveal>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-300/[.06] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-300/70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-violet-300 shadow-[0_0_10px_#c4b5fd]" />
            </span>
            Desktop beta · Windows installer coming soon
          </div>
        </Reveal>

        <Reveal delay={80}>
          <h1 className="text-balance text-5xl font-semibold tracking-[-0.06em] text-white sm:text-6xl lg:text-7xl">
            Your project, code, AI, and preview{' '}
            <span className="text-gradient">in one workspace.</span>
          </h1>
        </Reveal>

        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-7 text-zinc-400 sm:text-lg">
            Open a project folder and work with its files, code editor, Gemini or Groq AI chat, supported
            web previews, and terminal together in a desktop app. Your project stays local; AI only gets
            the prompt and code context you choose to send.
          </p>
        </Reveal>

        <Reveal delay={240}>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#download"
              className="group relative w-full overflow-hidden rounded-full bg-violet-300 px-6 py-3 text-sm font-semibold text-[#16121f] shadow-[0_0_30px_rgba(196,181,253,.18)] transition hover:bg-violet-200 sm:w-auto"
            >
              <span className="relative z-10 flex items-center justify-center">
                <Download className="mr-2 size-4" />
                Download for Windows
                <span className="ml-2 rounded-full bg-black/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>
              </span>
            </a>
            <a
              href="#beta"
              className="w-full rounded-full border border-white/15 px-6 py-3 text-sm font-medium text-zinc-300 transition hover:border-white/30 hover:text-white sm:w-auto"
            >
              Request beta access
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-600">The installer is not available yet. Join the beta to follow progress.</p>
        </Reveal>
      </div>

      {/* Mockup */}
      <Reveal variant="scale" delay={120} className="relative mt-16 lg:mt-20">
        <WorkspaceMockup />
        <div className="absolute -bottom-4 left-1/2 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[#11131a]/90 px-4 py-2 text-[10px] text-zinc-400 shadow-xl backdrop-blur sm:flex">
          <Check className="size-3 text-emerald-300" /> Local files
          <span className="text-zinc-700">•</span> Provider-powered AI
          <span className="text-zinc-700">•</span> No account required
        </div>
      </Reveal>
      <p className="mt-8 text-center text-xs text-zinc-600">
        Product concept preview · Features and availability may change during beta.
      </p>
    </section>
  )
}
