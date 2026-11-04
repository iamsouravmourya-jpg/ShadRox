'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/lib/download'

const faqs = [
  {
    q: 'Can I download ShadRox now?',
    a: `Yes. The Download for Windows button installs the latest beta (v${APP_VERSION}) on Windows 10 or 11, 64-bit. You do not need a form or approval. Windows may show a SmartScreen warning because the build is not code-signed yet — choose More and then Run anyway.`,
  },
  {
    q: 'Do I need a ShadRox account?',
    a: 'Yes. On first launch the app asks you to continue with Google. It opens your browser, you pick a Google account, and the app receives a session. ShadRox stores only your email, name, avatar URL, app version, and platform. There is no password to create and no subscription.',
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a newer release when it starts and downloads it in the background. The update installs when you restart or quit the app — you never have to re-download the installer. The download link on this page always points at the latest release.',
  },
  {
    q: 'Does ShadRox store my project in the cloud?',
    a: 'No. The desktop workspace opens and edits project files on your computer. There is no ShadRox cloud project sync. When you ask the AI for help, the prompt and the project context you include are sent to the Gemini or Groq provider you selected.',
  },
  {
    q: 'Where is my AI provider key stored?',
    a: 'Your key is saved only on your device in an encrypted local store. Requests go from your machine directly to the provider. ShadRox servers never receive your provider key. Your provider may charge for usage.',
  },
  {
    q: 'Which AI providers are supported?',
    a: 'The current app supports Gemini, Groq, and custom OpenAI-compatible endpoints — including Ollama and LM Studio running locally. Model availability and limits depend on your provider account.',
  },
  {
    q: 'Can I preview any project?',
    a: 'Static sites, supported Node-based web projects, and detected Python, Go, PHP, Java, and .NET backends are supported. The runtime must be installed on your machine. Some external sites may also block embedded previews.',
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
    a: 'ShadRox is a solo project built by Sourav Maurya, a 19-year-old full-stack developer and AI engineer based in Delhi, India. There is no company behind it — the app, the website, and the GitHub repo are all maintained by one person, in the open.',
  },
]

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)

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
          {faqs.map((item, i) => {
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
