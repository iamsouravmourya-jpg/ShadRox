'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'
import { faqs } from '@/lib/faqs'

export function Faq({ limit }: { limit?: number }) {
  const [open, setOpen] = useState<number | null>(0)
  const items = limit ? faqs.slice(0, limit) : faqs

  return (
    <section id="faq" className="border-t border-[var(--line)] bg-[var(--bg2)] py-20 lg:py-28">
      <div className="container-page max-w-3xl">
        <Reveal className="mb-12 text-center">
          <p className="eyebrow mb-4">
            Good to know
          </p>
          <h2 className="text-[clamp(1.75rem,3.4vw,2.875rem)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
            Questions, <em className="font-normal italic text-[var(--ac)]">answered.</em>
          </h2>
        </Reveal>

        <div className="divide-y divide-[var(--line)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--card)]">
          {items.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} delay={i * 50}>
                <div className={cn(
                  'px-5 py-1.5 transition-colors duration-200 sm:px-6',
                  isOpen && 'bg-[var(--bg2)]',
                )}>
                  <h3>
                    <button
                      type="button"
                      id={`faq-q-${i}`}
                      onClick={() => setOpen(isOpen ? null : i)}
                      className="flex min-h-[52px] w-full cursor-pointer items-center justify-between gap-4 py-3 text-left text-[15px] font-semibold leading-snug tracking-[-0.01em] text-[var(--ink)] transition-colors hover:text-[var(--ac)]"
                      aria-expanded={isOpen}
                      aria-controls={`faq-a-${i}`}
                    >
                      <span>{item.q}</span>
                      <ChevronDown
                        className={cn(
                          'size-4 shrink-0 text-[var(--mut)] transition-transform duration-300',
                          isOpen && 'rotate-180 text-[var(--ac)]',
                        )}
                        aria-hidden
                      />
                    </button>
                  </h3>
                  <div
                    id={`faq-a-${i}`}
                    role="region"
                    aria-labelledby={`faq-q-${i}`}
                    aria-hidden={!isOpen}
                    className={cn('faq-panel', isOpen && 'open')}
                  >
                    <div className="faq-inner">
                      <p className="max-w-2xl pb-4 pr-8 text-[13.5px] leading-6 text-[var(--mut)]">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}