'use client'

import { useRef } from 'react'
import { Eye, Sparkles, Terminal } from 'lucide-react'

export function WorkspaceMockup() {
  const shellRef = useRef<HTMLDivElement | null>(null)

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = shellRef.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const rect = el.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width - 0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5
    el.style.transform = `perspective(1200px) rotateX(${py * -4}deg) rotateY(${px * 5}deg)`
  }

  const handleLeave = () => {
    const el = shellRef.current
    if (el) el.style.transform = ''
  }

  return (
    <div
      ref={shellRef}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className="workspace-shell relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d12] transition-transform duration-300 ease-out"
      style={{ transformStyle: 'preserve-3d' }}
    >
      {/* Title bar */}
      <div className="flex h-10 items-center gap-3 border-b border-white/8 px-3 text-[10px] text-zinc-500 sm:px-4">
        <div className="flex gap-1.5">
          <i className="size-2.5 rounded-full bg-red-400/80" />
          <i className="size-2.5 rounded-full bg-amber-300/80" />
          <i className="size-2.5 rounded-full bg-emerald-400/80" />
        </div>
        <span className="font-mono">ShadRox — my-project</span>
        <span className="ml-auto rounded-md border border-white/10 px-2 py-1 text-zinc-400">Ctrl+K</span>
      </div>

      {/* Body: explorer | editor | chat */}
      <div className="grid min-h-[300px] grid-cols-[76px_minmax(0,1fr)] sm:min-h-[360px] sm:grid-cols-[120px_minmax(0,1fr)_180px] lg:min-h-[390px] lg:grid-cols-[140px_minmax(0,1fr)_210px]">

        {/* Explorer */}
        <aside className="overflow-hidden border-r border-white/8 bg-[#0e1016] p-2 text-[9px] font-mono text-zinc-500 sm:p-3 sm:text-[10px]">
          <p className="mb-3 truncate text-[8px] uppercase tracking-[0.14em] text-zinc-600 sm:tracking-[0.2em]">Explorer</p>
          <p className="mb-2 truncate text-zinc-300">⌄ my-project</p>
          <p className="mb-1 truncate pl-1 text-violet-300 sm:pl-3">⌄ src</p>
          <p className="mb-1 truncate pl-2 bg-violet-400/10 rounded text-violet-200 sm:pl-6">◈ App.tsx</p>
          <p className="mb-1 hidden truncate pl-2 text-zinc-500 sm:block sm:pl-6">◈ globals.css</p>
          <p className="mb-1 hidden truncate pl-1 text-zinc-500 sm:block sm:pl-3">⌄ public</p>
          <p className="mt-3 hidden truncate pl-1 text-zinc-500 sm:block sm:pl-3">◇ package.json</p>
          <p className="hidden truncate rounded pl-1 text-zinc-400 sm:block sm:pl-3">◇ README.md</p>
        </aside>

        {/* Editor */}
        <div className="relative min-w-0 bg-[#101219]">
          <div className="flex h-9 items-center gap-2 border-b border-white/8 px-3 text-[10px] font-mono sm:gap-4 sm:px-4">
            <span className="truncate border-b border-violet-400 py-2 text-zinc-200">App.tsx</span>
            <span className="hidden text-zinc-600 sm:inline">README.md</span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-violet-300/20 bg-violet-300/[.07] px-1.5 py-1 text-violet-200">
              <Eye className="size-3" /> Preview
            </span>
          </div>
          {/* Code lines */}
          <div className="space-y-1.5 overflow-hidden px-4 py-4 font-mono text-[10px] leading-5 text-zinc-400 sm:px-5 sm:py-5 sm:text-[11px]">
            <p><span className="text-[#6b6880] select-none mr-3">1</span><span className="text-[#c4a7ff]">import</span> {'{ useState }'} <span className="text-[#c4a7ff]">from</span> <span className="text-[#86efac]">&quot;react&quot;</span></p>
            <p><span className="text-[#6b6880] select-none mr-3">2</span></p>
            <p><span className="text-[#6b6880] select-none mr-3">3</span><span className="text-[#c4a7ff]">export function</span> <span className="text-[#7dd3fc]">App</span>{'() {'}</p>
            <p><span className="text-[#6b6880] select-none mr-3">4</span>{'  '}<span className="text-[#c4a7ff]">const</span> [ready, setReady] = <span className="text-[#7dd3fc]">useState</span>(<span className="text-[#fda4af]">false</span>)</p>
            <p><span className="text-[#6b6880] select-none mr-3">5</span>{'  '}<span className="text-[#6b6880]">{'// ⌘K — edit with AI, right here'}</span></p>
            <p><span className="text-[#6b6880] select-none mr-3">6</span>{'  '}<span className="text-[#c4a7ff]">return</span> {'('}</p>
            <p><span className="text-[#6b6880] select-none mr-3">7</span>{'    '}&lt;<span className="text-[#7dd3fc]">Workspace</span> ready={'{ready}'} /&gt;</p>
            <p><span className="text-[#6b6880] select-none mr-3">8</span>{'  )'}</p>
            <p><span className="text-[#6b6880] select-none mr-3">9</span>{'}'}</p>
          </div>

          {/* Status line */}
          <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 border-t border-white/8 bg-[linear-gradient(90deg,#6d4aff,#ec4899)] px-3 py-1.5 font-mono text-[9px] text-white sm:left-0 sm:right-[180px] lg:right-[210px]">
            <span>⎇ main</span>
            <span className="opacity-60">·</span>
            <span>0 errors</span>
            <span className="opacity-60">·</span>
            <span>TypeScript</span>
            <span className="opacity-60">·</span>
            <span>Preview :5173</span>
          </div>
        </div>

        {/* AI chat */}
        <aside className="hidden border-l border-white/8 bg-[#0e1016] p-3 text-[10px] text-zinc-500 sm:block">
          <div className="mb-3 flex items-center gap-2 text-zinc-300">
            <Sparkles className="size-3 text-violet-300" />
            <span>AI chat</span>
          </div>
          <div className="justify-self-end ml-auto max-w-[90%] rounded-xl bg-[#6d4aff] px-3 py-2 text-[10px] leading-4 text-white mb-2">
            Add a loading state
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[.03] px-3 py-2 leading-4 text-zinc-400 mb-2">
            Reading App.tsx<span className="caret ml-0.5 h-3 inline-block align-middle" />
          </div>
          <div className="rounded-xl border border-violet-400/20 bg-violet-400/[.07] px-3 py-2 text-[9px] font-mono leading-4 text-violet-100">
            <div className="bg-red-500/10 text-red-300 px-1 rounded mb-0.5">{'- ready={ready}'}</div>
            <div className="bg-emerald-500/10 text-emerald-300 px-1 rounded">{'+ loading={!ready}'}</div>
          </div>
          <div className="mt-4 flex items-center gap-2 border-t border-white/8 pt-3 text-zinc-600">
            <Terminal className="size-3" /> terminal
          </div>
        </aside>
      </div>
    </div>
  )
}
