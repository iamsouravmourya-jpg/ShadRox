'use client'

import { Check, Cloud, FolderTree, KeyRound, Monitor, Sparkles } from 'lucide-react'
import { Reveal } from './reveal'

export function Privacy() {
  return (
    <section id="privacy" className="border-y border-white/8 bg-[#0d0f13] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <div>
            <div className="mb-5 flex size-10 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-300/10">
              <Monitor className="size-5 text-violet-300" />
            </div>
            <h2 className="max-w-lg text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
              Local project workflow, clear AI data flow.
            </h2>
            <div className="mt-6 rounded-2xl border border-white/8 bg-[#11131a] p-6 text-sm leading-7 text-zinc-400 lg:p-8">
              <p>
                Your project folder is opened and edited on your computer. When you send a message to
                AI, the prompt and the project context included with that request are sent to the Gemini
                or Groq provider you selected.
              </p>
              <p className="mt-5 text-zinc-300">
                You can use your own provider key. Keys entered in the app stay on your device in an
                encrypted local store and are never sent to ShadRox. Signing in with Google creates a
                ShadRox account that holds only your email, name, avatar URL, app version, and
                platform. Project files stay on your disk.
              </p>
              <div className="mt-6 flex items-center gap-2 border-t border-white/8 pt-5 text-xs font-medium text-violet-200">
                <Check className="size-4" /> Local files. Provider-powered AI. Minimum account data.
              </div>
            </div>
          </div>
        </Reveal>

        {/* Data-flow diagram */}
        <Reveal variant="scale" delay={120}>
          <div className="flex h-full flex-col justify-center rounded-2xl border border-white/8 bg-[#0b0d12] p-7 lg:p-9">
            <p className="mb-7 text-center text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-600">
              How a request travels
            </p>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              {/* Your device */}
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="grid size-14 place-items-center rounded-2xl border border-violet-300/20 bg-violet-300/[.07]">
                  <FolderTree className="size-6 text-violet-300" />
                </div>
                <p className="text-xs font-medium text-zinc-200">Your computer</p>
                <p className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <KeyRound className="size-3" /> key encrypted on device
                </p>
              </div>

              {/* Animated flow line */}
              <div className="flex flex-col items-center px-1">
                <svg width="64" height="24" viewBox="0 0 64 24" fill="none" className="text-violet-300/70">
                  <line
                    x1="2" y1="12" x2="62" y2="12"
                    stroke="currentColor" strokeWidth="1.5"
                    className="flow-line"
                  />
                  <path d="M54 7 L62 12 L54 17" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <span className="mt-1 text-[9px] font-mono text-zinc-600">prompt + context</span>
              </div>

              {/* Provider */}
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="grid size-14 place-items-center rounded-2xl border border-sky-300/20 bg-sky-300/[.07]">
                  <Cloud className="size-6 text-sky-300" />
                </div>
                <p className="text-xs font-medium text-zinc-200">AI provider</p>
                <p className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <Sparkles className="size-3" /> Gemini or Groq
                </p>
              </div>
            </div>

            <ul className="mt-8 space-y-2.5 text-xs text-zinc-500">
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
                Project files are edited locally on your disk.
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
                Only the prompt and the context you include go to the provider.
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
                Signing in stores only your email, name, and basic app info.
              </li>
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
