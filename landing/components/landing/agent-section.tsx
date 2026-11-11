'use client'

import { useRef, useState } from 'react'
import { Reveal } from './reveal'
import { cn } from '@/lib/utils'

type Panel = {
  tab: string
  title: string
  accent: string
  text: string
  bullets: string[]
  steps: { mark: string; title: string; sub: string }[]
}

const panels: Panel[] = [
  {
    tab: 'Agent loop',
    title: 'Reads first.',
    accent: 'Then proposes.',
    text: 'The agent reads your project — files, search, diagnostics, Git — and proposes changes as diffs you accept or reject. Requests can include a compact repo map so it understands the codebase before touching anything.',
    bullets: [
      'Read-only tools: list, read, search, diagnostics, Git, outlines',
      'Five tool rounds by default, with up to six calls per round',
      'Edits go through a patch → review → apply pipeline; unsafe edits wait for your accept',
      'Cut-off or malformed edit blocks fail loudly and get one repair retry — never silently dropped',
      'File notes state the real outcome, remembered across restarts',
    ],
    steps: [
      { mark: '1', title: 'Read the files', sub: 'list_dir · read_file · search' },
      { mark: '2', title: 'Check diagnostics & Git', sub: 'know what is broken first' },
      { mark: '3', title: 'Propose a patch', sub: 'never an arbitrary write' },
      { mark: '4', title: 'You review & accept', sub: 'always your call' },
    ],
  },
  {
    tab: 'Autonomous runs',
    title: 'Plan. Patch.',
    accent: 'Verify. Repair.',
    text: 'Big goals become a task DAG of milestones. Each is verified with diagnostics, and failures get a repair brief. Still beta — review the results.',
    bullets: [
      'Verified with diagnostics and an optional approved command',
      'Configurable repair attempts per milestone',
      'Unrecoverable failure rolls back to the checkpoint',
    ],
    steps: [
      { mark: 'G', title: 'Goal', sub: 'what you asked for' },
      { mark: 'P', title: 'Plan (task DAG)', sub: 'milestones with dependencies' },
      { mark: 'V', title: 'Verify', sub: 'diagnostics + approved command' },
      { mark: 'R', title: 'Repair or rollback', sub: 'bounded by maxAttempts' },
    ],
  },
  {
    tab: 'Agent teams',
    title: 'A small team,',
    accent: 'with boundaries.',
    text: "A Coordinator splits the goal and assigns specialists. Each brief carries file ownership so agents stay out of each other's way.",
    bullets: [
      'Shared bounded tool loop and guarded patch path',
      'The Tests role will not weaken tests to make them pass',
      'Reviewer reads and reports — changes nothing',
    ],
    steps: [
      { mark: 'C', title: 'Coordinator', sub: 'plans and assigns, never edits' },
      { mark: 'F', title: 'Frontend', sub: 'components, styling, client state' },
      { mark: 'B', title: 'Backend', sub: 'APIs, data access, services' },
      { mark: 'T', title: 'Tests · Reviewer', sub: 'fixtures and checks · read-only review' },
    ],
  },
  {
    tab: 'MCP & rules',
    title: 'Your tools.',
    accent: 'Your rules.',
    text: 'Connect Model Context Protocol servers with approval for every external tool call, and teach the agent your conventions once via rule files.',
    bullets: [
      'User-configured MCP servers, approval-gated',
      'Rules and skills load automatically from your project',
      'Supports .cursorrules, AGENTS.md, SHADROX.md',
    ],
    steps: [
      { mark: 'MD', title: 'SHADROX.md', sub: 'your project conventions' },
      { mark: 'M', title: 'MCP Servers', sub: 'approval-gated external tools' },
      { mark: 'S', title: 'Skills', sub: '.shadrox/skills/*.md' },
      { mark: 'R', title: 'Rules', sub: '.shadrox/rules/*.md' },
    ],
  },
]

export function AgentSection() {
  const [active, setActive] = useState(0)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const panel = panels[active]

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = e.key === 'ArrowRight'
      ? (index + 1) % panels.length
      : (index - 1 + panels.length) % panels.length
    setActive(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <section id="agent" className="border-t border-[var(--line)] bg-[var(--bg)] px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--ac)]">
            The agent
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[820px] text-center text-[clamp(30px,4.5vw,52px)] font-bold tracking-[-0.04em] leading-[1.08] text-[var(--ink)]">
            An AI that <em className="font-normal italic text-[var(--ac)]">shows its work.</em>
          </h2>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mb-10 max-w-[600px] text-center text-base leading-7 text-[var(--mut)]">
            Bounded, reviewable and honest about its limits.
          </p>
        </Reveal>

        <Reveal delay={200}>
          <div
            role="tablist"
            aria-label="Agent capabilities"
            className="mx-auto mb-10 flex w-fit max-w-full flex-wrap justify-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card)] p-1.5"
          >
            {panels.map((p, i) => (
              <button
                key={p.tab}
                ref={(el) => { tabRefs.current[i] = el }}
                role="tab"
                id={`agent-tab-${i}`}
                aria-selected={active === i}
                aria-controls={`agent-panel-${i}`}
                tabIndex={active === i ? 0 : -1}
                onClick={() => setActive(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  'rounded-full px-4 py-2 text-[13px] font-semibold transition-all duration-300',
                  active === i
                    ? 'bg-[linear-gradient(110deg,var(--ac),var(--pink))] text-white shadow-[0_6px_18px_var(--glow)]'
                    : 'text-[var(--mut)] hover:bg-[var(--bg2)] hover:text-[var(--ink)]',
                )}
              >
                {p.tab}
              </button>
            ))}
          </div>
        </Reveal>

        <div
          key={active}
          role="tabpanel"
          id={`agent-panel-${active}`}
          aria-labelledby={`agent-tab-${active}`}
          className="grid gap-10 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-7 sm:p-10 lg:grid-cols-2 lg:gap-14"
          style={{ animation: 'slide-down .45s cubic-bezier(.22,1,.36,1)' }}
        >
          <div>
            <h3 className="mb-4 text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.03em] leading-[1.15] text-[var(--ink)]">
              {panel.title}{' '}
              <em className="font-normal italic text-[var(--ac)]">{panel.accent}</em>
            </h3>
            <p className="mb-6 text-sm leading-7 text-[var(--mut)]">{panel.text}</p>
            <ul className="space-y-3">
              {panel.bullets.map((b) => (
                <li key={b} className="flex gap-3 text-sm leading-6 text-[var(--ink2)]">
                  <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--ac)]" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col justify-center gap-3">
            {panel.steps.map(({ mark, title, sub }, i) => (
              <div
                key={title}
                className="flex items-center gap-4 rounded-2xl border border-[var(--line)] bg-[var(--bg2)] px-5 py-4 transition-all duration-300 hover:translate-x-1.5 hover:border-[var(--ac)]"
                style={{ animation: `slide-down .5s cubic-bezier(.22,1,.36,1) ${i * 90}ms backwards` }}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,var(--ac),var(--pink))] font-mono text-[11px] font-bold text-white">
                  {mark}
                </span>
                <div>
                  <b className="block text-sm font-bold text-[var(--ink)]">{title}</b>
                  <small className="font-mono text-[11px] text-[var(--mut)]">{sub}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}