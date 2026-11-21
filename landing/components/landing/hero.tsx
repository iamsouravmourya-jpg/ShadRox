'use client'

import { ArrowRight, Download } from 'lucide-react'
import { APP_VERSION, WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { WorkspaceMockup } from './workspace-mockup'

const trust = ['Local files on disk', 'BYOK · Gemini, Groq, Ollama', 'Bundled debugger', 'Google sign-in']

export function Hero() {
  return (
    <section className="container-page relative pb-16 pt-32 sm:pt-36 lg:pb-24 lg:pt-40">
      {/* Aurora washes — clipped so they never widen the mobile viewport */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px] overflow-hidden">
        <div
          className="absolute left-1/2 top-[-18rem] h-[38rem] w-[62rem] -translate-x-1/2 rounded-full blur-[110px]"
          style={{ background: 'radial-gradient(closest-side, color-mix(in srgb, var(--ac) 16%, transparent), transparent)' }}
        />
        <div
          className="absolute right-[-14rem] top-24 size-[30rem] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(closest-side, color-mix(in srgb, var(--pink) 10%, transparent), transparent)' }}
        />
      </div>

      <div className="mx-auto max-w-[860px] text-center">
        {/* Clean unboxed typographic release kicker — no pill or pulsing dot */}
        <div className="hero-rise" style={{ '--rise-delay': '0ms' } as React.CSSProperties}>
          <p className="inline-flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ac)]">
            <span>Desktop beta</span>
            <span aria-hidden className="text-[var(--line)]">/</span>
            <span>Windows 10 &amp; 11</span>
            <span aria-hidden className="text-[var(--line)]">/</span>
            <span className="tabular-nums">v{APP_VERSION}</span>
          </p>
        </div>

        {/* Headline */}
        <h1
          className="hero-rise mt-6 text-[clamp(2.4rem,7.4vw,5.25rem)] font-bold leading-[1.02] tracking-[-0.045em] text-[var(--ink)]"
          style={{ '--rise-delay': '80ms' } as React.CSSProperties}
        >
          <span className="block">Your project, code, AI and preview</span>
          <span className="text-gradient block">in one workspace.</span>
        </h1>

        {/* Supporting copy */}
        <p
          className="hero-rise mx-auto mt-6 max-w-[620px] text-pretty text-[15px] leading-7 text-[var(--mut)] sm:text-[17px]"
          style={{ '--rise-delay': '160ms' } as React.CSSProperties}
        >
          Open a project folder and work with its files, code editor, autonomous AI agents, bundled
          Node debugger, offline dead-code scanner, live preview, Git tools, and terminal in one
          desktop app. Your code stays on your computer.
        </p>

        {/* CTAs */}
        <div
          className="hero-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          style={{ '--rise-delay': '240ms' } as React.CSSProperties}
        >
          <a href={WINDOWS_DOWNLOAD_URL} className="cta-primary group w-full whitespace-nowrap shrink-0 sm:w-auto">
            <Download className="size-4" aria-hidden />
            Download for Windows
          </a>
          <a href="#new" className="cta-ghost group w-full whitespace-nowrap shrink-0 sm:w-auto">
            See what&apos;s new in v{APP_VERSION}
            <ArrowRight
              className="size-4 text-[var(--mut)] transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-[var(--ink)]"
              aria-hidden
            />
          </a>
        </div>

        <p
          className="hero-rise mt-5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[12px] font-medium text-[var(--mut)]"
          style={{ '--rise-delay': '320ms' } as React.CSSProperties}
        >
          <span>64-bit Windows installer</span>
          <span aria-hidden className="text-[var(--line)]">·</span>
          <span>Bring your own key</span>
          <span aria-hidden className="text-[var(--line)]">·</span>
          <span>AGPL-3.0 open source</span>
        </p>
      </div>

      {/* Product mockup */}
      <div
        className="hero-rise relative mt-14 lg:mt-20"
        style={{ '--rise-delay': '380ms' } as React.CSSProperties}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-10 top-8 -z-10 h-full rounded-[32px] blur-3xl"
          style={{ background: 'radial-gradient(ellipse at center, color-mix(in srgb, var(--ac) 18%, transparent), transparent 70%)' }}
        />
        <div className="rounded-[22px] border border-[var(--line)] bg-[var(--bg2)] p-1.5 shadow-[0_1px_2px_var(--shadow),0_40px_100px_-40px_rgba(15,23,42,0.45)] ring-1 ring-white/5 sm:p-2">
          <WorkspaceMockup />
        </div>

        {/* Quiet unboxed metadata strip */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12px] text-[var(--mut)]">
          {trust.map((item, i) => (
            <span key={item} className="inline-flex items-center gap-4">
              {item}
              {i < trust.length - 1 && <span aria-hidden className="text-[var(--line)]">·</span>}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-8 text-center text-[12px] text-[var(--mut)]">
        Beta software · Review AI diffs before accepting and keep Git backups for important work.
      </p>
    </section>
  )
}
