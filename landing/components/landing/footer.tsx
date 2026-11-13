'use client'

import Link from 'next/link'
import { APP_VERSION, GITHUB_REPO, RELEASES_URL } from '@/lib/download'
import { Logo } from './navbar'

const cols = [
  {
    title: 'Product',
    links: [
      { label: 'Features',        href: '/features' },
      { label: 'AI agent',        href: '/agent' },
      { label: 'How it works',    href: '/how-it-works' },
      { label: 'Preview support', href: '/preview-support' },
      { label: 'Privacy',         href: '/privacy' },
    ],
  },
  {
    title: 'Download',
    links: [
      { label: `Windows (v${APP_VERSION})`, href: '/download' },
      { label: 'All releases',              href: '/releases' },
      { label: `v${APP_VERSION} release notes`, href: `${GITHUB_REPO}/releases/tag/v${APP_VERSION}`, external: true },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'FAQ',             href: '/faq' },
      { label: 'Report an issue', href: `${GITHUB_REPO}/issues`, external: true },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'About the maker', href: '/about' },
      { label: 'GitHub repo',     href: GITHUB_REPO, external: true },
      { label: 'shadrox.cyou',    href: 'https://www.shadrox.cyou', external: true },
    ],
  },
]

export function Footer() {
  return (
    <footer className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8">
      <div className="mx-auto max-w-[1180px]">
        {/* Grid */}
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(4,1fr)]">
          {/* Brand */}
          <div>
            <Logo />
            <p className="mt-4 max-w-[280px] text-sm leading-6 text-[var(--mut)]">
              A native desktop workspace for working on local projects. Editor, AI chat,
              preview, Git tools and terminal — in one app.
            </p>
            <p className="mt-4 text-xs leading-5 text-[var(--mut)]">
              Built solo by{' '}
              <Link
                href="/about"
                className="underline underline-offset-2 transition hover:text-[var(--ac)]"
              >
                Sourav Maurya
              </Link>
              {' '}— a 19-year-old developer &amp; AI engineer from Delhi, India 🇮🇳
            </p>
          </div>

          {/* Link columns */}
          {cols.map((col) => (
            <div key={col.title}>
              <h5 className="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ink)]">
                {col.title}
              </h5>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {'external' in l && l.external ? (
                      <a
                        href={l.href}
                        className="inline-block text-sm text-[var(--mut)] transition hover:translate-x-1 hover:text-[var(--ac)]"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="inline-block text-sm text-[var(--mut)] transition hover:translate-x-1 hover:text-[var(--ac)]"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-14 flex flex-col gap-3 border-t border-[var(--line)] pt-7 text-xs text-[var(--mut)] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Sourav Maurya. Open source under the AGPL-3.0 license.</span>
          <span className="shrink-0">Built with Electron, React, CodeMirror &amp; Supabase · Made in India 🇮🇳</span>
        </div>
      </div>
    </footer>
  )
}