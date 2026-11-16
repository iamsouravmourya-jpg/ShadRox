'use client'

import { LogIn, FolderOpen, MousePointerClick, Play } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  {
    icon: LogIn,
    num: '01',
    title: 'Sign in with Google',
    text: 'The first screen asks you to continue with Google. Your browser handles the sign-in and returns you to the app. ShadRox stores only your email, name, avatar URL, app version, and platform.',
  },
  {
    icon: FolderOpen,
    num: '02',
    title: 'Open a folder',
    text: 'Choose any project folder from your computer. ShadRox builds a compact repo map, loads your rule files, and sets up the workspace — no cloud sync, no upload.',
  },
  {
    icon: MousePointerClick,
    num: '03',
    title: 'Explore and build',
    text: 'Browse files, edit code, review AI-proposed diffs before applying, and queue a follow-up message while the current AI turn is still running.',
  },
  {
    icon: Play,
    num: '04',
    title: 'Run and preview',
    text: 'Start a supported project or open a static site directly in the app. ShadRox asks before installing missing dependencies or launching a detected preview script.',
  },
]

export function HowItWorks() {
  return (
    <section id="flow" className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-28">
      <div className="container-page">
        <div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr] lg:gap-20">
          {/* Left heading */}
          <Reveal>
            <div className="lg:sticky lg:top-32">
              <p className="eyebrow mb-4">
                The flow
              </p>
              <h2 className="max-w-xs text-[clamp(1.75rem,3.2vw,2.75rem)] font-bold leading-[1.12] tracking-[-0.04em] text-[var(--ink)]">
                Open a project and{' '}
                <em className="font-normal italic text-[var(--ac)]">get into the flow.</em>
              </h2>
              <p className="mt-5 max-w-xs text-sm leading-6 text-[var(--mut)]">
                Four steps from install to a running preview, with no cloud project setup required.
              </p>
            </div>
          </Reveal>

          {/* Steps */}
          <div className="relative">
            {/* vertical connecting line */}
            <div
              aria-hidden
              className="absolute bottom-6 left-[17px] top-3 w-px"
              style={{
                background: 'linear-gradient(to bottom, color-mix(in srgb, var(--ac) 55%, transparent), color-mix(in srgb, var(--ac) 12%, transparent), transparent)',
              }}
            />
            <ol className="divide-y divide-[var(--line)]">
              {steps.map(({ icon: Icon, num, title, text }, i) => (
                <Reveal as="li" key={title} delay={i * 100}>
                  <div className={`group relative flex gap-5 pb-7 ${i > 0 ? 'pt-7' : ''}`}>
                    <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-full border border-[var(--line)] bg-[var(--card)] font-mono text-[11px] font-bold text-[var(--ac)] transition-colors duration-300 group-hover:border-[var(--ac)] group-hover:bg-[var(--bg3)]">
                      {num}
                    </span>
                    <div className="pt-0.5">
                      <div className="mb-2 flex items-center gap-2">
                        <Icon className="size-4 shrink-0 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">{title}</h3>
                      </div>
                      <p className="max-w-md text-[13.5px] leading-6 text-[var(--mut)]">{text}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
