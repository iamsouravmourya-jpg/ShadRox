import type { ReactNode } from 'react'
import { Navbar } from './navbar'
import { Footer } from './footer'
import { Reveal } from './reveal'

type PageShellProps = {
  eyebrow: string
  title: string
  accent?: string
  sub?: string
  children: ReactNode
}

export function PageShell({ eyebrow, title, accent, sub, children }: PageShellProps) {
  return (
    <main id="top" className="relative">
      <Navbar />
      <header className="mx-auto max-w-[1180px] px-5 pb-6 pt-32 lg:px-8 lg:pt-40">
        <Reveal>
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
            {eyebrow}
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="max-w-[860px] text-balance text-[clamp(34px,5vw,60px)] font-bold tracking-[-0.045em] leading-[1.06] text-[var(--ink)]">
            {title}
            {accent && (
              <>
                {' '}
                <em className="font-normal italic text-[var(--ac)]">{accent}</em>
              </>
            )}
          </h1>
        </Reveal>
        {sub && (
          <Reveal delay={160}>
            <p className="mt-5 max-w-[680px] text-pretty text-base leading-7 text-[var(--mut)]">
              {sub}
            </p>
          </Reveal>
        )}
      </header>
      {children}
      <Footer />
    </main>
  )
}