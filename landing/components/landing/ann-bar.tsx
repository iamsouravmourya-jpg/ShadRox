'use client'

import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { APP_VERSION } from '@/lib/download'

export function AnnBar() {
  const [open, setOpen] = useState(true)
  if (!open) return null

  return (
    <div className="relative flex items-center justify-center gap-2 bg-[linear-gradient(90deg,var(--ac),var(--pink))] px-8 py-2 text-center text-[12px] font-semibold leading-snug text-white sm:px-10">
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        ShadRox v{APP_VERSION} rebuilt — honest edit reports + a calmer chat.{' '}
        <a
          href={`https://github.com/iamsouravmourya-jpg/ShadRox/releases/tag/v${APP_VERSION}`}
          className="underline underline-offset-2 transition hover:opacity-80"
        >
          Release notes →
        </a>
      </p>
      <button
        onClick={() => setOpen(false)}
        aria-label="Dismiss announcement"
        className="absolute right-3 grid size-5 place-items-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}