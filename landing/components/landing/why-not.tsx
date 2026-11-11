'use client'

import { Reveal } from './reveal'

const comparisons = [
  {
    title: 'Aider · Cline',
    text: 'Aider drives from a terminal and Cline is a plugin inside another editor — strong agents, but the workspace lives somewhere else. ShadRox keeps the same bounded, review-and-accept loop and adds the explorer, preview, Git tools and terminal in one app.',
  },
  {
    title: 'Cloud AI editors',
    text: 'Requests go from your machine to the provider you configure — not through a ShadRox server, and your key is never sent to one. Point it at Ollama or LM Studio and the prompt stays on your PC.',
  },
  {
    title: 'Editor + plugin stacks',
    text: 'One native app instead of six extensions. Open a folder and the explorer, chat, preview and shell are already wired together.',
  },
]

export function WhyNot() {
  return (
    <section id="why" className="border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--ac)]">
            Why not just…
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[860px] text-center text-[clamp(30px,4.5vw,52px)] font-bold tracking-[-0.04em] leading-[1.08] text-[var(--ink)]">
            Aider and Cline are <em className="font-normal italic text-[var(--ac)]">powerful.</em>
            <br className="hidden sm:block" /> Neither one is the whole workspace.
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-12 max-w-[640px] text-center text-base leading-7 text-[var(--mut)]">
            Same review-and-accept discipline and bring-your-own-key pricing — plus the editor,
            live preview, Git UI and terminal in the same window.
          </p>
        </Reveal>

        <div className="mx-auto grid max-w-[820px] gap-4">
          {comparisons.map(({ title, text }, i) => (
            <Reveal key={title} delay={i * 100}>
              <div className="flex gap-5 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 transition-all duration-300 hover:translate-x-1.5 hover:border-[var(--ac)] hover:shadow-[4px_0_20px_var(--glow)] sm:p-7">
                <span
                  aria-hidden
                  className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--bg2)] font-mono text-[11px] font-bold uppercase text-[var(--ac)]"
                >
                  vs
                </span>
                <div>
                  <h3 className="mb-1.5 text-[15px] font-bold text-[var(--ink)]">{title}</h3>
                  <p className="text-sm leading-6 text-[var(--mut)]">{text}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}