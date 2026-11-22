'use client'

import { useEffect, useRef, useState } from 'react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

const stats = [
  {
    value: 0,
    lead: true,
    label: 'project files synced to cloud storage — your workspace stays on your disk',
  },
  { value: 3, label: 'AI provider families: Gemini, Groq, OpenAI-compatible (Ollama & LM Studio)' },
  { value: 5, label: 'autonomous team roles with explicit target validation and contract-aware repair' },
  {
    value: 40,
    label:
      'built-in agent tools across reads, edits, preview inspection, bundled js-debug telemetry and guarded commands',
  },
]

function CountUp({ target }: { target: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [value, setValue] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (target === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target)
      return
    }
    let raf = 0
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        observer.disconnect()
        const t0 = performance.now()
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / 900)
          setValue(Math.round(target * (1 - Math.pow(1 - p, 3))))
          if (p < 1) raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      },
      { threshold: 0.4 },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [target])

  return <span ref={ref}>{value}</span>
}

export function Stats() {
  return (
    <section aria-label="ShadRox by the numbers" className="container-page pb-16 lg:pb-20">
      <Reveal variant="scale">
        <div className="grid gap-px overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          {stats.map(({ value, label, lead }) => (
            <div
              key={label}
              className={cn(
                'flex flex-col gap-2 bg-[var(--card)] p-6 sm:p-7',
                lead
                  ? 'bg-[linear-gradient(135deg,var(--cta-1),var(--cta-2))] text-white'
                  : 'text-[var(--ink)]',
              )}
            >
              <b
                className={cn(
                  'text-[clamp(2rem,3.4vw,2.75rem)] font-bold leading-none tracking-[-0.04em] tabular-nums',
                  lead ? 'text-white' : 'text-gradient',
                )}
              >
                <CountUp target={value} />
              </b>
              <span className={cn('text-[12px] leading-5', lead ? 'text-white' : 'text-[var(--mut)]')}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  )
}