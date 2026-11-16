'use client'

import { Check, Cloud, FolderTree, KeyRound, Monitor, ShieldCheck, Sparkles } from 'lucide-react'
import { Reveal } from './reveal'

const guarantees: {
  icon: typeof FolderTree
  title: string
  text: string
}[] = [
  {
    icon: FolderTree,
    title: 'Project files stay on your disk',
    text: 'ShadRox edits files locally. There is no ShadRox cloud project sync — the app opens the folder you pick.',
  },
  {
    icon: KeyRound,
    title: 'Keys encrypted on your device',
    text: 'Your Gemini, Groq, or compatible key lives in OS-backed encrypted storage. Requests go from your machine directly to the provider — ShadRox servers never receive the key.',
  },
  {
    icon: Monitor,
    title: 'Only prompt + context go to AI',
    text: 'When you ask AI for help, the prompt and the context you choose are sent to the provider you selected. Point it at Ollama or LM Studio and the prompt stays on your PC.',
  },
  {
    icon: ShieldCheck,
    title: 'Guarded commands, default-deny',
    text: 'Every shell command — even npm test or git status — opens a native approval dialog with a plain-language risk notice, and the workspace is re-checked between approval and execution.',
  },
  {
    icon: Sparkles,
    title: 'Reviewable changes',
    text: 'Edits arrive as diffs. Unsafe patches are held for review instead of written in place, and file notes report the real apply outcome.',
  },
]

export function Privacy() {
  return (
    <section id="privacy" className="border-y border-[var(--line)] bg-[var(--bg)] py-20 lg:py-28">
      <div className="container-page">
        <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-20">

          {/* Left — copy + data flow */}
          <Reveal>
            <div>
              <p className="eyebrow mb-4">
                Privacy
              </p>
              <h2 className="max-w-lg text-[clamp(1.75rem,3.4vw,2.75rem)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
                Local project workflow,{' '}
                <em className="font-normal italic text-[var(--ac)]">clear AI data flow.</em>
              </h2>
              <p className="mt-5 max-w-xl text-sm leading-7 text-[var(--mut)]">
                Your project folder is opened and edited on your computer. When you send a message
                to AI, the prompt and the project context included with that request are sent to
                the provider you selected — and your key never touches ShadRox servers.
              </p>

              {/* Data flow diagram */}
              <div className="mt-8 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--card)] p-5">
                <div className="flex min-w-[80px] flex-col items-center gap-1.5 text-center">
                  <div className="grid size-12 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <FolderTree className="size-5 text-[var(--ac)]" aria-hidden />
                  </div>
                  <p className="text-[11px] font-semibold text-[var(--ink)]">Your computer</p>
                  <p className="text-[10px] leading-3 text-[var(--mut)]">files · key · rules</p>
                </div>

                {/* Animated arrow */}
                <div className="flex flex-1 flex-col items-center gap-1 px-1">
                  <svg width="100%" height="20" viewBox="0 0 80 20" fill="none" className="overflow-visible text-[var(--ac)]" aria-hidden>
                    <line x1="2" y1="10" x2="72" y2="10" stroke="currentColor" strokeWidth="1.5" className="flow-line" strokeDasharray="6 6" />
                    <path d="M66 5L74 10L66 15" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span className="whitespace-nowrap font-mono text-[10px] text-[var(--mut)]">prompt + context</span>
                </div>

                <div className="flex min-w-[80px] flex-col items-center gap-1.5 text-center">
                  <div className="grid size-12 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg2)]">
                    <Cloud className="size-5 text-[var(--ac2)]" aria-hidden />
                  </div>
                  <p className="text-[11px] font-semibold text-[var(--ink)]">AI provider</p>
                  <p className="text-[10px] leading-3 text-[var(--mut)]">Gemini · Groq · custom</p>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Right — guarantee cards */}
          <Reveal variant="scale" delay={120}>
            <div className="grid gap-3">
              {guarantees.map(({ icon: Icon, title, text }) => (
                <div
                  key={title}
                  className="flex gap-4 rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 transition-colors duration-300 hover:border-[var(--ac)]"
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--bg2)]">
                    <Icon className="size-4 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-bold text-[var(--ink)]">{title}</h3>
                    <p className="text-[13px] leading-5 text-[var(--mut)]">{text}</p>
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg2)] px-5 py-3.5 text-sm font-semibold text-[var(--ink)]">
                <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
                Local files · Provider-powered AI · Guarded commands
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
