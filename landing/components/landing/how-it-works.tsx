'use client'

import { FolderOpen, MousePointerClick, Play } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  {
    icon: FolderOpen,
    title: 'Open a folder',
    text: 'Choose a project folder from your computer.',
  },
  {
    icon: MousePointerClick,
    title: 'Explore and build',
    text: 'Browse files, edit code, and ask the connected AI provider for help when you want it.',
  },
  {
    icon: Play,
    title: 'Run and preview',
    text: 'Start a supported project or open a static site. ShadRox asks before it installs missing dependencies or launches a detected preview script.',
  },
]

export function HowItWorks() {
  return (
    <section id="flow" className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
      <div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr] lg:gap-24">
        <Reveal>
          <div>
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-violet-300">The flow</p>
            <h2 className="max-w-sm text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
              Open a project and get into the flow.
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-6 text-zinc-500">
              Three steps from an empty workspace to a running preview.
            </p>
          </div>
        </Reveal>

        <div className="relative">
          {/* vertical connecting line */}
          <div className="absolute left-[15px] top-3 bottom-3 w-px bg-gradient-to-b from-violet-400/60 via-violet-400/20 to-transparent" />
          <div className="divide-y divide-white/10">
            {steps.map(({ icon: Icon, title, text }, index) => (
              <Reveal key={title} delay={index * 120}>
                <div className="relative flex gap-5 py-7 first:pt-0">
                  <span className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full border border-violet-300/30 bg-[#0d0f13] font-mono text-xs text-violet-200">
                    0{index + 1}
                  </span>
                  <div className="pt-0.5">
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="size-4 text-violet-300/80" />
                      <h3 className="font-medium text-white">{title}</h3>
                    </div>
                    <p className="max-w-md text-sm leading-6 text-zinc-500">{text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
