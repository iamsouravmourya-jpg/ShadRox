'use client'

import { Logo } from './navbar'

export function Footer() {
  return (
    <footer className="border-t border-white/8 px-5 py-10 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <Logo />
          <p className="max-w-xs text-zinc-600">
            ShadRox is built solo by Sourav Maurya — a 19-year-old full-stack developer and AI
            engineer in Delhi, India.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <a href="#download" className="transition hover:text-zinc-300">Download</a>
          <a href="#privacy" className="transition hover:text-zinc-300">Privacy &amp; data flow</a>
          <a href="#faq" className="transition hover:text-zinc-300">FAQ</a>
        </div>
        <span>© 2026 ShadRox</span>
      </div>
    </footer>
  )
}
