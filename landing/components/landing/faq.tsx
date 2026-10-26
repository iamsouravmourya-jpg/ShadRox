'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

const faqs = [
  {
    q: 'Can I download ShadRox now?',
    a: 'Not yet. The Windows installer button on this page is a non-functional preview. We are preparing the beta build and will share it when it is ready.',
  },
  {
    q: 'How do I request beta access?',
    a: 'Use the beta request button to open an email draft. There is no online signup form or automated waitlist yet.',
  },
  {
    q: 'Does ShadRox store my project in the cloud?',
    a: 'The desktop workspace opens and edits project files locally. There is no ShadRox cloud project sync today. AI requests send the prompt and the included project context to the selected AI provider.',
  },
  {
    q: 'Which AI providers are supported?',
    a: 'The current app supports Gemini and Groq. You provide your own provider key, and your provider may charge for usage. Prompts and the code context you include are sent to that provider.',
  },
  {
    q: 'Can I preview any project?',
    a: 'Static sites and supported Node-based web projects are the current focus. Other backend runtimes are not supported yet, and some sites may block embedded previews.',
  },
  {
    q: 'Do I need an account or subscription?',
    a: 'No ShadRox account or subscription is required for the beta. AI features need your own Gemini or Groq provider key, and provider usage may cost extra.',
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
