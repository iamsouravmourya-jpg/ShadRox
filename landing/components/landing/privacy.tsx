'use client'

import { Check, Cloud, FolderTree, KeyRound, Monitor, Sparkles } from 'lucide-react'
import { Reveal } from './reveal'

const guarantees = [
  {
    icon: FolderTree,
    title: 'Project files stay on your disk',
    text: 'ShadRox edits files locally. There is no ShadRox cloud project sync.',
  },
  {
    icon: KeyRound,
    title: 'Keys encrypted on your device',
    text: 'Your Gemini, Groq, or compatible key lives in OS-backed encrypted storage. Requests go from your machine directly to the provider — ShadRox servers never receive the key.',
  },
  {
    icon: Monitor,
    title: 'Only prompt + context go to AI',
    text: 'When you ask AI for help, the prompt and the context you choose are sent to the provider you selected. Nothing else is uploaded.',
  },
  {
    icon: Sparkles,
    title: 'Minimum account data',
    text: 'Google sign-in stores only email, name, avatar URL, app version, and platform. No passwords, no subscription attached at sign-in.',
  },
]

export function Privacy() {
  return (
    <section id="privacy" className="border-y border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-20 items-start">

          {/* Left — copy + data flow */}
          <Reveal>
            <div>
              <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                Privacy
              </p>
              <h2 className="max-w-lg text-[clamp(28px,3.8vw,46px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
                Local project workflow,{' '}
                <em className="font-normal italic text-[var(--ac)]">clear AI data flow.</em>
              </h2>
              <p className="mt-5 max-w-xl text-sm leading-7 text-[var(--mut)]">
                Your project folder is opened and edited on your computer. When you send a message
                to AI, the prompt and the project context included with that request are sent to
                the provider you selected. Do not shorten this to "your code never leaves your
                device" — that would be inaccurate when AI features are used.
              </p>

              {/* Data flow diagram */}
              <div className="mt-8 flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5">
                <div className="flex flex-col items-center gap-1.5 text-center text-xs min-w-[80px]">
                  <div className="grid size-12 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <FolderTree className="size-5 text-[var(--ac)]" />
                  </div>
                  <p className="font-semibold text-[var(--ink)] text-[11px]">Your computer</p>
                  <p className="text-[10px] text-[var(--mut)] leading-3">files · key · rules</p>
                </div>

                {/* Animated arrow */}
                <div className="flex flex-1 flex-col items-center gap-1 px-2">
                  <svg width="100%" height="20" viewBox="0 0 80 20" fill="none" className="text-[var(--ac)] overflow-visible">
                    <line x1="2" y1="10" x2="72" y2="10" stroke="currentColor" strokeWidth="1.5" className="flow-line" strokeDasharray="6 6" />
                    <path d="M66 5L74 10L66 15" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span className="text-[9px] font-mono text-[var(--mut)] whitespace-nowrap">prompt + context</span>
                </div>

                <div className="flex flex-col items-center gap-1.5 text-center text-xs min-w-[80px]">
                  <div className="grid size-12 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <Cloud className="size-5 text-[var(--ac2)]" />
                  </div>
                  <p className="font-semibold text-[var(--ink)] text-[11px]">AI provider</p>
                  <p className="text-[10px] text-[var(--mut)] leading-3">Gemini · Groq · custom</p>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Right — guarantee cards */}
          <Reveal variant="scale" delay={120}>
            <div className="grid gap-4">
              {guarantees.map(({ icon: Icon, title, text }, i) => (
                <div
                  key={title}
                  className="flex gap-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5 transition-all duration-300 hover:translate-x-1.5 hover:border-[var(--ac)] hover:shadow-[4px_0_20px_var(--glow)]"
                  style={{ transitionDelay: `${i * 60}ms` }}
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--bg2)]">
                    <Icon className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
                  </div>
                  <div>
                    <h4 className="mb-1 text-sm font-bold text-[var(--ink)]">{title}</h4>
                    <p className="text-[13px] leading-5 text-[var(--mut)]">{text}</p>
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] px-5 py-3.5 text-sm font-semibold text-[var(--ink)]">
                <Check className="size-4 text-emerald-500 shrink-0" />
                Local files · Provider-powered AI · Minimum account data
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
