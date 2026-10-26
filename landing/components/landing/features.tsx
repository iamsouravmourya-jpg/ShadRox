'use client'

import { FolderOpen, Sparkles, Eye, Terminal } from 'lucide-react'
import { Reveal } from './reveal'

const features = [
  {
    icon: FolderOpen,
    number: '01',
    title: 'Open and edit local projects',
    text: 'Open a folder, browse files as you need them, and write approved edits straight back to your project on disk.',
  },
  {
    icon: Sparkles,
    number: '02',
    title: 'AI help, on your terms',
    text: 'Use Gemini or Groq with your own provider key. Ask for code, planning, or complex help, then review proposed changes before applying them.',
  },
  {
    icon: Eye,
    number: '03',
    title: 'Preview supported web projects',
    text: 'Run static sites and supported Node.js projects in an in-app preview. ShadRox asks before starting a project or installing its dependencies.',
  },
  {
    icon: Terminal,
    number: '04',
    title: 'A terminal beside your code',
    text: "Use an interactive terminal in the project folder. Commands run with your computer account's permissions, so only run commands you trust.",
  },
]

export function Features() {
  return (
    <section id="features" className="border-t border-white/8 bg-[#0d0f13] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-6xl">
        <Reveal className="mb-12 max-w-xl">
          <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-violet-300">The workspace</p>
          <h2 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
            Everything around the code, together.
          </h2>
        </Reveal>

        <div className="feature-track grid gap-px overflow-hidden rounded-2xl border border-white/8 bg-white/8 md:grid-cols-2">
          {features.map(({ icon: Icon, number, title, text }, i) => (
            <Reveal
              key={number}
              delay={i * 90}
              as="article"
              className="feature-card min-w-[280px] border-b border-r border-white/8 bg-[#0d0f13] p-7 last:border-b-0 hover:bg-[#12151b] lg:p-9 md:[&:nth-child(2n)]:border-r-0"
            >
              <div className="mb-16 flex items-center justify-between">
                <span className="relative grid size-10 place-items-center rounded-xl border border-violet-300/20 bg-violet-300/[.07]">
                  <Icon className="size-5 text-violet-300" />
                </span>
                <span className="font-mono text-xs text-zinc-600">{number}</span>
              </div>
              <h3 className="max-w-sm text-lg font-medium text-white">{title}</h3>
              <p className="mt-3 max-w-sm text-sm leading-6 text-zinc-500">{text}</p>
            </Reveal>
          ))}
        </div>
        <p className="mt-4 text-center text-[10px] uppercase tracking-[0.2em] text-zinc-600 md:hidden">
          Swipe to explore
        </p>
      </div>
    </section>
  )
}
