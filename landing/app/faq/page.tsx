import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowUpRight, Download, LifeBuoy } from 'lucide-react'
import { PageShell } from '@/components/landing/page-shell'
import { Faq } from '@/components/landing/faq'
import { Reveal } from '@/components/landing/reveal'
import { GITHUB_REPO } from '@/lib/download'

export const metadata: Metadata = {
  title: 'FAQ — ShadRox',
  description:
    'Straight answers about the ShadRox beta: downloading the Windows installer, Google sign-in, where your AI key is stored, what an AI request sends, agent guardrails, updates, previews and billing.',
  alternates: { canonical: '/faq' },
}

export default function FaqPage() {
  return (
    <PageShell
      eyebrow="FAQ"
      title="Straight answers,"
      accent="no fine print."
      sub="Downloading, signing in, AI keys, what a request actually sends, agent guardrails, updates, previews and billing — answered plainly, with the beta limits left in."
    >
      <Faq />

      {/* ── Still stuck? ── */}
      <section className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-16 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <Reveal variant="scale">
            <div className="feature-card rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
              <div className="flex flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--bg2)]">
                    <LifeBuoy className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
                  </span>
                  <div className="max-w-sm">
                    <h2 className="text-[19px] font-bold tracking-[-0.02em] text-[var(--ink)]">
                      Still stuck?
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--mut)]">
                      If the app does something these answers do not cover, open an issue on GitHub.
                      Bugs and questions both go to the same tracker.
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-col gap-3 sm:items-end">
                  <a
                    href={`${GITHUB_REPO}/issues`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-6 py-3 text-sm font-bold text-white shadow-[0_10px_28px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_var(--glow)]"
                  >
                    Report an issue
                    <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </a>
                  <Link
                    href="/download"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-6 py-3 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                  >
                    <Download className="size-4" />
                    Get the latest build
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  )
}