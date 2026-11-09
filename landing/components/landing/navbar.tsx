'use client'

import { useState } from 'react'
import { Download, Menu, X } from 'lucide-react'
import { useScrolled } from '@/hooks/use-scrolled'
import { WINDOWS_DOWNLOAD_URL } from '@/lib/download'
import { useTheme } from './theme-provider'
import { cn } from '@/lib/utils'

const links = [
  { label: 'Features',    href: '#features' },
  { label: 'How it works', href: '#flow' },
  { label: 'Privacy',     href: '#privacy' },
  { label: 'FAQ',         href: '#faq' },
  { label: 'Download',    href: '#download' },
]

export function Logo() {
  return (
    <a href="#top" className="group flex items-center gap-2.5" aria-label="ShadRox home">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-8 flex-shrink-0 transition-transform duration-300 group-hover:scale-105"
        aria-hidden="true"
      >
        <path
          d="M6 7L16 3L26 7V16C26 22.5 16 29 16 29C16 29 6 22.5 6 16V7Z"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 11H13.5C12.1193 11 11 12.1193 11 13.5C11 14.8807 12.1193 16 13.5 16H18.5C19.8807 16 21 17.1193 21 18.5C21 19.8807 19.8807 21 18.5 21H11"
          stroke="#10b981"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="11" cy="11" r="1.5" fill="#34d399" />
        <circle cx="21" cy="21" r="1.5" fill="#34d399" />
      </svg>
      <span className="text-[15px] font-bold tracking-[-0.03em] text-[var(--ink)]">ShadRox</span>
    </a>
  )
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const [spinning, setSpinning] = useState(false)

  function handleClick() {
    setSpinning(true)
    toggle()
    setTimeout(() => setSpinning(false), 400)
  }

  return (
    <button
      onClick={handleClick}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'grid size-9 place-items-center rounded-full border transition-all duration-300',
        'border-[var(--line)] bg-[var(--card)] text-[var(--ink)]',
        'hover:border-[var(--ac)] hover:text-[var(--ac)]',
        spinning && 'theme-spin',
      )}
    >
      {theme === 'dark' ? (
        /* Sun */
        <svg viewBox="0 0 20 20" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.8">
          <circle cx="10" cy="10" r="3.5"/>
          <line x1="10" y1="1.5" x2="10" y2="3.5"/>
          <line x1="10" y1="16.5" x2="10" y2="18.5"/>
          <line x1="1.5" y1="10" x2="3.5" y2="10"/>
          <line x1="16.5" y1="10" x2="18.5" y2="10"/>
          <line x1="4.1" y1="4.1" x2="5.5" y2="5.5"/>
          <line x1="14.5" y1="14.5" x2="15.9" y2="15.9"/>
          <line x1="15.9" y1="4.1" x2="14.5" y2="5.5"/>
          <line x1="5.5" y1="14.5" x2="4.1" y2="15.9"/>
        </svg>
      ) : (
        /* Moon */
        <svg viewBox="0 0 20 20" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.8">
          <path d="M17 13a7 7 0 11-10-9.7A5.5 5.5 0 0017 13z"/>
        </svg>
      )}
    </button>
  )
}

export function Navbar() {
  const scrolled = useScrolled(12)
  const [open, setOpen] = useState(false)

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-400',
        scrolled
          ? 'border-b border-[var(--line)] bg-[var(--bg)]/90 backdrop-blur-xl shadow-sm'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <nav className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-4 lg:px-8">
        <Logo />

        {/* Desktop links */}
        <div className="hidden items-center gap-0.5 text-sm text-[var(--mut)] md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="nav-link rounded-full px-3.5 py-2 font-medium transition hover:bg-[var(--bg2)] hover:text-[var(--ink)]"
            >
              {l.label}
            </a>
          ))}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <a
            href={WINDOWS_DOWNLOAD_URL}
            className="hidden items-center gap-1.5 overflow-hidden rounded-full bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-4 py-2 text-xs font-bold text-white shadow-[0_8px_24px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_32px_var(--glow)] sm:flex"
          >
            <Download className="size-3.5" />
            Download
          </a>
          <button
            className="grid size-9 place-items-center rounded-md border border-[var(--line)] bg-[var(--card)] text-[var(--ink)] transition hover:bg-[var(--bg2)] md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      <div
        className={cn(
          'overflow-hidden border-t border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur-xl transition-all duration-300 md:hidden',
          open ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <div className="mx-5 flex flex-col gap-1 py-4 text-sm text-[var(--mut)]">
          {links.map((l, i) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-xl px-3.5 py-2.5 font-medium transition hover:bg-[var(--bg2)] hover:text-[var(--ink)]"
              style={{ transitionDelay: open ? `${i * 35}ms` : '0ms' }}
            >
              {l.label}
            </a>
          ))}
          <a
            href={WINDOWS_DOWNLOAD_URL}
            onClick={() => setOpen(false)}
            className="mt-2 flex items-center gap-2 rounded-xl bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-4 py-3 text-sm font-bold text-white"
          >
            <Download className="size-4" /> Download for Windows
          </a>
        </div>
      </div>
    </header>
  )
}
