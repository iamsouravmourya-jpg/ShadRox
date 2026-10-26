'use client'

import { FolderTree, MessageSquare, Eye, TerminalSquare, Sparkles, GitBranch, FileCode2, Boxes } from 'lucide-react'

const items = [
  { icon: FolderTree, label: 'Local project files' },
  { icon: FileCode2, label: 'Code editor' },
  { icon: MessageSquare, label: 'AI chat' },
  { icon: Eye, label: 'In-app preview' },
  { icon: TerminalSquare, label: 'Project terminal' },
  { icon: Sparkles, label: 'Gemini & Groq' },
  { icon: GitBranch, label: 'Your own provider key' },
  { icon: Boxes, label: 'Node-based web projects' },
]

export function Marquee() {
  // Duplicated track for a seamless infinite scroll.
  const track = [...items, ...items]

  return (
    <section aria-hidden className="relative overflow-hidden border-y border-white/8 py-6">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-[#090a0d] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-[#090a0d] to-transparent" />
      <div className="marquee-track gap-8 pr-8">
        {track.map(({ icon: Icon, label }, i) => (
          <div
            key={`${label}-${i}`}
            className="flex shrink-0 items-center gap-2.5 text-sm text-zinc-500"
          >
            <Icon className="size-4 text-violet-300/80" />
            <span className="whitespace-nowrap font-medium tracking-tight">{label}</span>
            <span className="ml-2 text-zinc-700">/</span>
          </div>
        ))}
      </div>
    </section>
  )
}
