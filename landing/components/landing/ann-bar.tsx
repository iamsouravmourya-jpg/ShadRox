'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { APP_VERSION } from '@/lib/download'

export function AnnBar() {
  const [open, setOpen] = useState(true)
  if (!open) return null

  return (
    <div className="relative flex items-center justify-center gap-3 bg-[linear-gradient(100deg,var(--cta-1),var(--cta-2))] px-12 py-2 text-center text-[12px] font-semibold leading-snug text-white sm:px-14">
      <p className="min-w-0">
        ShadRox v{APP_VERSION} — bundled zero-config Node debugger, offline junk &amp; dead-code
        scanner, and context-aware autonomous repair.{' '}
        <a
          href="/releases"
          className="underline decoration-white/45 underline-offset-2 transition-colors hover:decoration-white"
        >
          Release notes →
        </a>
      </p>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Dismiss announcement"
        className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}