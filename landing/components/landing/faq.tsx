'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

const faqs = [
  {
    q: 'Can I download ShadRox now?',
    a: 'Yes. The Download for Windows button installs the latest beta (currently 0.0.1) on Windows 10 or 11, 64-bit. You do not need an account, form, or approval to download the installer. Windows may show a SmartScreen warning because the build is not code-signed yet: choose More and then Run anyway.',
  },
  {
    q: 'Do I need a ShadRox account?',
    a: 'Yes. On first launch the app asks you to continue with Google. It opens your browser, you pick a Google account, and the app receives a session in return. ShadRox stores only your account row: email, name, avatar URL, app version, and platform. There is no password to create and no subscription.',
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a newer release when it starts and downloads it in the background. The update installs when you restart or quit the app, so testers never have to re-download the installer. The download link on this page always points at the latest release.',
  },
  {
    q: 'Does ShadRox store my project in the cloud?',
    a: 'No. The desktop workspace opens and edits project files on your computer. There is no ShadRox cloud project sync. When you ask the AI for help, the prompt and the project context you include are sent to the Gemini or Groq provider you selected.',
  },
  {
    q: 'Where is my AI provider key stored?',
    a: 'Your Gemini or Groq key is saved only on your device in an encrypted local store, and requests go from your machine to the provider. ShadRox servers never receive your provider key. Your provider may charge for usage.',
  },
  {
    q: 'Which AI providers are supported?',
    a: 'The current app supports Gemini and Groq with your own key. Model availability and limits depend on your provider account.',
  },
  {
    q: 'Can I preview any project?',
    a: 'Static sites and supported Node-based web projects are the current focus. Other backend runtimes are not supported yet, and some sites may block embedded previews.',
  },
]

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <section id="faq" className="border-t border-white/8 bg-[#0d0f13] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-3xl">
        <Reveal className="mb-10 text-center">
          <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-violet-300">Good to know</p>
          <h2 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
            Questions, answered.
          </h2>
        </Reveal>

        <div className="divide-y divide-white/10">
          {faqs.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} delay={i * 60}>
                <div className="py-5">
                  <button
                    onClick={() => setOpen(isOpen ? null : i)}
                    className="flex w-full cursor-pointer list-none items-center justify-between gap-4 text-left text-sm font-medium text-zinc-200 transition hover:text-white"
                    aria-expanded={isOpen}
                  >
                    <span>{item.q}</span>
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 text-zinc-500 transition-transform duration-300',
                        isOpen && 'rotate-180 text-violet-300',
                      )}
                    />
                  </button>
                  <div className={cn('faq-panel mt-1', isOpen && 'open')}>
                    <div className="faq-inner">
                      <p className="max-w-2xl pt-3 pr-8 text-sm leading-6 text-zinc-500">{item.a}</p>
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
