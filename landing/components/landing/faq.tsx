'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/lib/download'

const faqs = [
  {
    q: 'Can I download ShadRox now?',
    a: `Yes. The latest beta installer (v${APP_VERSION}) is for Windows 10 or 11, 64-bit. The Windows build is unsigned, so SmartScreen may show a warning — verify the download source before choosing More → Run anyway.`,
  },
  {
    q: 'Do I need an account?',
    a: 'Yes. Google sign-in through Supabase is required to enter the desktop app. Account profile fields include email, name, avatar, app version, and platform. There is no password to create.',
  },
  {
    q: 'Does ShadRox store my project in the cloud?',
    a: 'No. Project files are opened and edited on your computer. ShadRox does not sync project folders to a cloud workspace.',
  },
  {
    q: 'What is sent when I use AI?',
    a: 'Only the prompt and project context you choose are sent to the AI provider configured for that request. AI providers process that data under their own data-handling terms.',
  },
  {
    q: 'Which AI providers are supported?',
    a: 'Google Gemini, Groq, and custom OpenAI-compatible endpoints, including compatible local gateways such as Ollama and LM Studio. Model availability and charges depend on your provider.',
  },
  {
    q: 'Where is my AI key stored?',
    a: 'The desktop app stores provider keys in OS-backed encrypted storage. AI requests go from your machine to the configured provider; the key is not sent to ShadRox.',
  },
  {
    q: 'Can the agent make changes on its own?',
    a: 'Not silently. Inspection tools are read-only. The agent can run one shell command at a time in your opened folder and gets its real exit code back, but every command — including npm test, pytest, tsc --noEmit and Git status/diff — opens a native approval dialog with a plain-language risk notice first. File edits go through a guarded patch and review flow; unsafe changes are held for review. Deleting a path needs an explicit confirm plus a follow-up read that proves it is gone. Agent and autonomous workflows are beta, so inspect results and keep backups.',
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a newer release about 15 seconds after start and every 6 hours after that, and shows a badge when an update is ready. Nothing is downloaded or installed automatically — you download the installer from the release page and run it when you choose.',
  },
  {
    q: 'Does ShadRox cost anything?',
    a: 'No. ShadRox is free and runs on bring-your-own-key. There is no plan to buy, no checkout and no charge from ShadRox; your own provider key carries every request and your provider bills you directly.',
  },
  {
    q: 'Can I preview any project?',
    a: 'ShadRox supports Markdown, static sites, detected Node web projects, and detected Python, Go, PHP, Java, and .NET backends. The project runtime must be installed, and not every configuration is supported.',
  },
  {
    q: 'Can I preview a README or Markdown file?',
    a: 'Yes. Select any .md or .markdown file and use the Preview button beside its name. Switch back to Source to edit it.',
  },
  {
    q: 'Can I send a follow-up message while the AI is working?',
    a: 'Yes. Follow-up messages are held in a small queue and sent after the current turn finishes, rather than interrupting it.',
  },
  {
    q: 'Who is behind ShadRox?',
    a: 'ShadRox is a solo project built by Sourav Maurya, a 19-year-old full-stack developer and AI engineer based in Delhi, India. There is no company behind it — the app, the website, and the GitHub repo are all maintained by one person.',
  },
]

export function Faq({ limit }: { limit?: number }) {
  const [open, setOpen] = useState<number | null>(0)
  const items = limit ? faqs.slice(0, limit) : faqs

  return (
    <section id="faq" className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-3xl">
        <Reveal className="mb-12 text-center">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
            Good to know
          </p>
          <h2 className="text-[clamp(28px,3.8vw,46px)] font-bold tracking-[-0.04em] leading-[1.1] text-[var(--ink)]">
            Questions, <em className="font-normal italic text-[var(--ac)]">answered.</em>
          </h2>
        </Reveal>

        <div className="divide-y divide-[var(--line)] rounded-3xl border border-[var(--line)] bg-[var(--card)] overflow-hidden">
          {items.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} delay={i * 50}>
                <div className={cn(
                  'px-6 py-5 transition-colors duration-200',
                  isOpen && 'bg-[var(--bg2)]',
                )}>
                  <button
                    onClick={() => setOpen(isOpen ? null : i)}
                    className="flex w-full cursor-pointer items-center justify-between gap-4 text-left text-sm font-semibold text-[var(--ink)] transition hover:text-[var(--ac)]"
                    aria-expanded={isOpen}
                  >
                    <span>{item.q}</span>
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 text-[var(--mut)] transition-transform duration-300',
                        isOpen && 'rotate-180 text-[var(--ac)]',
                      )}
                    />
                  </button>
                  <div className={cn('faq-panel mt-1', isOpen && 'open')}>
                    <div className="faq-inner">
                      <p className="max-w-2xl pt-3 pr-8 text-sm leading-6 text-[var(--mut)]">
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
