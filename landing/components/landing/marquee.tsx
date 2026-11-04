'use client'

import {
  FolderTree, MessageSquare, Eye, TerminalSquare,
  Sparkles, GitBranch, FileCode2, Boxes, History,
  Command, Replace, KeyRound,
} from 'lucide-react'

const items = [
  { icon: FolderTree,     label: 'Local project files' },
  { icon: FileCode2,      label: 'CodeMirror 6 editor' },
  { icon: MessageSquare,  label: 'AI chat & queue' },
  { icon: Eye,            label: 'In-app preview' },
  { icon: TerminalSquare, label: 'Project terminal' },
  { icon: Sparkles,       label: 'Gemini & Groq' },
  { icon: GitBranch,      label: 'Git source control' },
  { icon: Command,        label: 'Command palette' },
  { icon: KeyRound,       label: 'BYOK · Local keys' },
  { icon: Boxes,          label: 'Node-based web projects' },
  { icon: Replace,        label: 'Workspace search & replace' },
  { icon: History,        label: 'Workspace checkpoints' },
]

export function Marquee() {
  const track = [...items, ...items]

  return (
    <section aria-hidden className="relative overflow-hidden border-y border-[var(--line)] py-6 bg-[var(--bg2)]">
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24"
        style={{ background: 'linear-gradient(to right, var(--bg2), transparent)' }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24"
        style={{ background: 'linear-gradient(to left, var(--bg2), transparent)' }}
      />
      <div className="marquee-track gap-8 pr-8">
        {track.map(({ icon: Icon, label }, i) => (
          <div
            key={`${label}-${i}`}
            className="flex shrink-0 items-center gap-2.5 text-sm text-[var(--mut)]"
          >
            <Icon className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
            <span className="whitespace-nowrap font-medium tracking-tight">{label}</span>
            <span className="ml-3 text-[var(--line)]">/</span>
          </div>
        ))}
      </div>
    </section>
  )
}
