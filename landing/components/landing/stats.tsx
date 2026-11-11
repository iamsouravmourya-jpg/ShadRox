'use client'

import { useEffect, useRef, useState } from 'react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

const stats = [
  {
    value: 0,
    lead: true,
    label: 'project files kept in cloud storage — the app opens the folder on your disk',
  },
  { value: 3, label: 'AI provider types: Gemini, Groq, OpenAI-compatible' },
  { value: 5, label: 'agent roles in a multi-step team run' },
  {
    value: 14,
    label:
      'built-in agent tools in the bounded loop — reads, search, one guarded shell command, a confirmed terminal answer and a paused-debugger snapshot',
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
    <section aria-label="ShadRox by the numbers" className="mx-auto max-w-[1180px] px-5 pb-16 lg:px-8">
      <Reveal variant="scale">
        <div className="grid overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] sm:grid-cols-2 lg:grid-cols-4">
          {stats.map(({ value, label, lead }, i) => (
            <div
              key={label}
              className={cn(
                'flex flex-col gap-2 p-6 sm:p-7',
                i > 0 && 'border-t border-[var(--line)] sm:border-t-0 sm:border-l',
                i === 2 && 'sm:border-t lg:border-t-0',
                lead
                  ? 'bg-[linear-gradient(135deg,var(--ac),var(--pink))] text-white sm:rounded-l-3xl'
                  : 'text-[var(--ink)]',
              )}
            >
              <b
                className={cn(
                  'font-mono text-4xl font-bold tracking-tight lg:text-[44px]',
                  lead ? 'text-white' : 'text-gradient',
                )}
              >
                <CountUp target={value} />
              </b>
              <span className={cn('text-[12px] leading-5', lead ? 'text-white/85' : 'text-[var(--mut)]')}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  )
}