'use client'

import { useRef } from 'react'
import { Sparkles, Terminal } from 'lucide-react'

/**
 * A stylized preview of the ShadRox desktop app: file explorer, editor with a
 * blinking caret, AI chat panel, and a terminal status line. Subtle 3D tilt
 * follows the pointer; the shell also floats via CSS (`float-workspace`).
 */
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
          <i className="size-2 rounded-full bg-red-400/80" />
          <i className="size-2 rounded-full bg-amber-300/80" />
          <i className="size-2 rounded-full bg-emerald-400/80" />
        </div>
        <span className="font-mono">shadRox / portfolio</span>
        <span className="ml-auto rounded-md border border-white/10 px-2 py-1 text-zinc-400">Ctrl K</span>
      </div>

      {/* Body: explorer | editor | chat */}
      <div className="grid min-h-[300px] grid-cols-[76px_minmax(0,1fr)] sm:min-h-[360px] sm:grid-cols-[120px_minmax(0,1fr)_180px] lg:min-h-[390px] lg:grid-cols-[138px_minmax(0,1fr)_200px]">
        {/* Explorer */}
        <aside className="overflow-hidden border-r border-white/8 bg-[#0e1016] p-2 text-[9px] font-mono text-zinc-500 sm:p-3 sm:text-[10px]">
          <p className="mb-3 truncate uppercase tracking-[0.12em] text-zinc-600 sm:tracking-[0.18em]">Explorer</p>
          <p className="mb-2 truncate text-zinc-300">⌄ portfolio</p>
          <p className="mb-1 truncate pl-1 text-violet-300 sm:pl-3">⌄ src</p>
          <p className="mb-1 truncate pl-2 text-zinc-400 sm:pl-6">◈ app.tsx</p>
          <p className="mb-1 hidden truncate pl-2 text-zinc-500 sm:block sm:pl-6">◈ globals.css</p>
          <p className="mb-1 hidden truncate pl-1 text-zinc-500 sm:block sm:pl-3">⌄ public</p>
          <p className="mt-3 hidden truncate pl-1 text-zinc-500 sm:block sm:pl-3">◇ package.json</p>
          <p className="hidden truncate pl-1 text-zinc-500 sm:block sm:pl-3">◇ README.md</p>
        </aside>

        {/* Editor */}
        <div className="relative min-w-0 bg-[#101219]">
          <div className="flex h-9 items-center gap-4 border-b border-white/8 px-4 text-[10px] font-mono">
            <span className="border-b border-violet-400 py-2 text-zinc-200">app.tsx</span>
            <span className="text-zinc-600">globals.css</span>
          </div>
          <div className="flex gap-2 overflow-hidden p-3 font-mono text-[9px] leading-5 text-zinc-500 sm:gap-4 sm:p-5 sm:text-[11px] sm:leading-6">
            <div className="select-none text-right text-zinc-700">
              {Array.from({ length: 11 }, (_, i) => i + 1).join('\n')}
            </div>
            <pre className="overflow-hidden whitespace-pre text-zinc-400">
              <span className="text-violet-300">import</span>{' '}
              <span className="text-sky-300">{'{ Sparkles }'}</span>{' '}
              <span className="text-violet-300">from</span>{' '}
              <span className="text-emerald-300">&apos;lucide-react&apos;</span>
              {'\n'}
              {'\n'}
              <span className="text-violet-300">export default function</span>{' '}
              <span className="text-sky-300">App</span>() {'{'}
              {'\n'}  <span className="text-violet-300">return</span> ({'\n'}    &lt;
              <span className="text-sky-300">main</span>{' '}
              <span className="text-amber-200">className</span>=
              <span className="text-emerald-300">&quot;workspace&quot;</span>&gt;
              {'\n'}      &lt;<span className="text-sky-300">Sparkles</span> /&gt;
              {'\n'}      &lt;<span className="text-sky-300">h1</span>&gt;Build something clear.&lt;/
              <span className="text-sky-300">h1</span>&gt;
              {'\n'}    &lt;/<span className="text-sky-300">main</span>&gt;
              {'\n'}  ){'\n'}
              {'}'}
              <span className="caret">&nbsp;</span>
            </pre>
          </div>

          {/* Status line */}
          <div className="absolute bottom-0 left-[76px] right-0 flex items-center gap-2 border-t border-white/8 bg-[#0b0d12] px-2 py-2 font-mono text-[8px] text-zinc-600 sm:left-[120px] sm:right-[180px] sm:px-4 sm:text-[9px] lg:left-[138px] lg:right-[200px]">
            <span className="text-emerald-400 glow-dot">●</span> Ready · local project
          </div>
        </div>

        {/* AI chat */}
        <aside className="hidden border-l border-white/8 bg-[#0e1016] p-3 text-[10px] text-zinc-500 sm:block">
          <div className="mb-3 flex items-center gap-2 text-zinc-300">
            <Sparkles className="size-3 text-violet-300" /> AI chat
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[.035] p-2.5 leading-4">
            Make the hero copy more direct and tighten the spacing.
          </div>
          <div className="mt-3 rounded-lg border border-violet-400/20 bg-violet-400/[.07] p-2.5 leading-4 text-violet-100">
            I&apos;ll update the component and show the proposed diff first.
          </div>
          <div className="mt-5 flex items-center gap-2 border-t border-white/8 pt-3 text-zinc-600">
            <Terminal className="size-3" /> terminal
          </div>
        </aside>
      </div>
    </div>
  )
}
