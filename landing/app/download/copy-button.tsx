'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

type CopyButtonProps = {
  value: string
  label?: string
}

/**
 * Small clipboard helper used for the SHA-512 hash and the PowerShell command.
 * Falls back to a hidden textarea + execCommand when the async Clipboard API
 * is unavailable (e.g. insecure context), so it still works in a static export.
 */
export function CopyButton({ value, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        throw new Error('Clipboard API unavailable')
      }
    } catch {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* best-effort fallback */
      }
      document.body.removeChild(ta)
    }

    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `${label} — copied` : label}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink2)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
    >
      {copied ? <Check className="size-3.5 text-[var(--ac)]" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  )
}