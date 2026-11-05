'use client'

import { Logo } from './navbar'

const cols = [
  {
    title: 'Product',
    links: [
      { label: 'Features',    href: '#features' },
      { label: 'How it works', href: '#flow' },
      { label: 'Privacy',     href: '#privacy' },
      { label: 'Preview support', href: '#features' },
    ],
  },
  {
    title: 'Download',
    links: [
      { label: 'Windows (v0.0.6)', href: 'https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.6-Setup.exe' },
      { label: 'All releases',    href: 'https://github.com/iamsouravmourya-jpg/ShadRox/releases' },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'FAQ',           href: '#faq' },
      { label: 'Report an issue', href: 'https://github.com/iamsouravmourya-jpg/ShadRox/issues' },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'shadrox.cyou',   href: 'https://www.shadrox.cyou' },
      { label: 'About the maker', href: 'https://www.linkedin.com/in/sourav-maurya-45b272377' },
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
            <p className="mt-4 text-xs text-[var(--mut)]">
              Built solo by{' '}
              <a
                href="https://www.linkedin.com/in/sourav-maurya-45b272377"
                className="underline hover:text-[var(--ac)] transition"
              >
                Sourav Maurya
              </a>
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
                    <a
                      href={l.href}
                      className="text-sm text-[var(--mut)] transition hover:text-[var(--ac)] hover:translate-x-1 inline-block"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-14 flex flex-col gap-3 border-t border-[var(--line)] pt-7 text-xs text-[var(--mut)] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Sourav Maurya. All rights reserved. Proprietary software, source published for viewing only.</span>
          <span className="shrink-0">Built with Electron, React, CodeMirror &amp; Supabase · Made in India 🇮🇳</span>
        </div>
      </div>
    </footer>
  )
}
