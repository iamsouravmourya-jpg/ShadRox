'use client'

import { FolderOpen, Sparkles, Eye, Terminal, FileCode2, GitBranch } from 'lucide-react'
import { Reveal } from './reveal'

const features = [
  {
    icon: FolderOpen,
    number: '01',
    title: 'Your project stays on your machine',
    text: 'Open a folder, browse files as you need them, and save edits straight back to the project on disk.',
  },
  {
    icon: FileCode2,
    number: '02',
    title: 'Code, then preview Markdown',
    text: 'Edit in CodeMirror, split your editor, and switch any .md file between source and a readable preview.',
  },
  {
    icon: Sparkles,
    number: '03',
    title: 'AI help, with you in control',
    text: 'Use Gemini, Groq, or a compatible endpoint with your own key. Queue follow-ups and review proposed code changes before applying them.',
  },
  {
    icon: Eye,
    number: '04',
    title: 'Preview supported web projects',
    text: 'View static sites, detected Node.js projects, and Python, Go, PHP, Java, or .NET backends in-app. ShadRox asks before managed install or run actions.',
  },
  {
    icon: Terminal,
    number: '05',
    title: 'Terminal and Git tools',
    text: "Run commands in your project and review Git changes, diffs, branches, staging, and commits in the same workspace.",
  },
  {
    icon: GitBranch,
    number: '06',
    title: 'Checkpoints for safer iteration',
    text: 'Inspect assistant checkpoints and restore earlier workspace content when you need to back out a change.',
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
