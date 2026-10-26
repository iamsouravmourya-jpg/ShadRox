'use client'

import { useState } from 'react'
import { ArrowRight, Download, Menu, X } from 'lucide-react'
import { useScrolled } from '@/hooks/use-scrolled'
import { cn } from '@/lib/utils'

const links = [
  { label: 'Features', href: '#features' },
  { label: 'How it works', href: '#flow' },
  { label: 'Privacy', href: '#privacy' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Download', href: '#download' },
]

export function Logo() {
  return (
    <a href="#top" className="group flex items-center gap-2.5" aria-label="ShadRox home">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-8 transition-transform group-hover:scale-105"
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
      <span className="text-[15px] font-semibold tracking-[-0.03em]">ShadRox</span>
    </a>
  )
}

export function Navbar() {
  const scrolled = useScrolled(12)
  const [open, setOpen] = useState(false)

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-500',
        scrolled ? 'border-b border-white/10 bg-[#090a0d]/80 backdrop-blur-xl' : 'border-b border-transparent',
      )}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 lg:px-8">
        <Logo />

        <div className="hidden items-center gap-8 text-sm text-zinc-400 md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="nav-link transition hover:text-white">
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <a
            href="#beta"
            className="hidden text-sm text-zinc-300 transition hover:text-white sm:block"
          >
            Request beta access
          </a>
          <a
            href="#download"
            className="group relative overflow-hidden rounded-full bg-white px-4 py-2 text-xs font-semibold text-black transition hover:bg-violet-100"
          >
            <span className="relative z-10">Download</span>
            <Download className="ml-1 inline size-3" />
          </a>
          <button
            className="rounded-md p-2 text-zinc-300 transition hover:bg-white/5 md:hidden"
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
          'overflow-hidden border-t border-white/10 bg-[#090a0d]/95 backdrop-blur-xl transition-all duration-400 md:hidden',
          open ? 'max-h-72 opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <div className="mx-5 flex flex-col gap-1 py-4 text-sm text-zinc-400">
          {links.map((l, i) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 transition hover:bg-white/5 hover:text-white"
              style={{ transitionDelay: open ? `${i * 40}ms` : '0ms' }}
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </header>
  )
}
