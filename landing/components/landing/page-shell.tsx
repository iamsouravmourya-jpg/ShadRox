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
    <main id="top" className="relative" tabIndex={-1}>
      <Navbar />
      <header className="container-page pb-8 pt-32 lg:pt-40">
        <Reveal>
          <p className="eyebrow mb-4">
            {eyebrow}
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="max-w-[860px] text-[clamp(2.125rem,5vw,3.75rem)] font-bold leading-[1.06] tracking-[-0.045em] text-[var(--ink)]">
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