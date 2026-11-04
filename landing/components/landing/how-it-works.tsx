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
    <section id="flow" className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <div className="grid gap-16 lg:grid-cols-[.7fr_1.3fr] lg:gap-28">
          {/* Left heading */}
          <Reveal>
            <div>
              <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                The flow
              </p>
              <h2 className="max-w-xs text-[clamp(28px,3.5vw,42px)] font-bold tracking-[-0.04em] leading-[1.12] text-[var(--ink)]">
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
              className="absolute left-[15px] top-3 bottom-3 w-px"
              style={{
                background: 'linear-gradient(to bottom, var(--ac), rgba(109,74,255,0.15), transparent)',
              }}
            />
            <div className="divide-y divide-[var(--line)]">
              {steps.map(({ icon: Icon, num, title, text }, i) => (
                <Reveal key={title} delay={i * 100}>
                  <div className="group relative flex gap-5 py-7 first:pt-0">
                    <span className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full border border-[var(--line)] bg-[var(--card)] font-mono text-xs font-bold text-[var(--ac)] transition-all duration-300 group-hover:border-[var(--ac)] group-hover:bg-[var(--acsoft,rgba(109,74,255,0.10))] group-hover:shadow-[0_0_16px_var(--glow)]">
                      {num}
                    </span>
                    <div className="pt-0.5">
                      <div className="mb-2 flex items-center gap-2">
                        <Icon className="size-4 text-[var(--ac)] opacity-80" strokeWidth={1.75} />
                        <h3 className="font-bold text-[var(--ink)]">{title}</h3>
                      </div>
                      <p className="max-w-md text-sm leading-6 text-[var(--mut)]">{text}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
