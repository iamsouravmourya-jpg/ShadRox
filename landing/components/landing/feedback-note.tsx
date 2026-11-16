'use client'

import { MessagesSquare } from 'lucide-react'
import { Reveal } from './reveal'

export function FeedbackNote() {
  return (
    <section id="feedback" className="border-t border-[var(--line)] bg-[var(--bg2)] py-10 lg:py-12">
      <div className="container-page">
        <Reveal>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--card)]">
              <MessagesSquare className="size-4 text-[var(--ac)]" strokeWidth={1.75} aria-hidden />
            </span>
            <div className="min-w-0 max-w-[760px]">
              <h2 className="text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                Feedback goes straight to the maker.
              </h2>
              <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--mut)]">
                The Feedback button sends only the message you type — marked as a bug or a feature
                — with the date, to a private Google Sheet. No email, no account details, no code
                or file names, no diagnostics.
              </p>
              <p className="mt-2 text-xs leading-5 text-[var(--mut)]">
                No ShadRox server sits in this path.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
