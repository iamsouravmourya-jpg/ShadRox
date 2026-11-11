'use client'

import type { MouseEvent } from 'react'
import {
  FileCode2, SearchCode, Command, Replace,
  AtSign, ListChecks, Plug, BookOpen,
  Terminal, GitBranch, History, RefreshCw,
  GitPullRequest, Puzzle,
  Sparkles, SquareTerminal, Rocket, TriangleAlert, Info,
} from 'lucide-react'
import { Reveal } from '@/components/landing/reveal'

type Capability = {
  icon: typeof FileCode2
  title: string
  text: string
  chips: string[]
  beta?: boolean
  note?: string
}

type Group = {
  id: string
  index: string
  label: string
  icon: typeof FileCode2
  headline: string
  tagline: string
  note?: string
  items: Capability[]
}

const groups: Group[] = [
  {
    id: 'edit',
    index: '01',
    label: 'Edit',
    icon: FileCode2,
    headline: 'Write and navigate.',
    tagline: 'The editor stays at the centre of the window. Everything else arranges itself around the file you are in.',
    items: [
      {
        icon: FileCode2,
        title: 'Editor & Markdown',
        text: 'CodeMirror 6 with split editor groups, plus pinned and reorderable tabs so the files you live in stay where you put them.',
        chips: ['CodeMirror 6', 'split groups', 'pinned tabs'],
      },
      {
        icon: SearchCode,
        title: 'Code navigation',
        text: 'TypeScript diagnostics, go-to-definition and find references — follow a symbol through the project instead of guessing where it lives.',
        chips: ['diagnostics', 'definition', 'references'],
      },
      {
        icon: Command,
        title: 'Command palette · Ctrl+K',
        text: 'Fuzzy-find files and commands from one palette. Select any code and press Ctrl+K to ask for an inline AI edit on just that selection.',
        chips: ['Ctrl+K', 'fuzzy find', 'AI on selection'],
      },
      {
        icon: Replace,
        title: 'Search & replace',
        text: 'Search across files on disk and open buffers, review the result list first, then replace the occurrences you actually meant.',
        chips: ['files + buffers', 'review first'],
      },
    ],
  },
  {
    id: 'ai',
    index: '02',
    label: 'AI',
    icon: Sparkles,
    headline: 'Context you choose.',
    tagline: 'Bring your own provider key and attach exactly what a request needs — a file, a folder, the current problems, or your uncommitted work.',
    note: 'Your prompt and the project context included with that request are sent to the AI provider you selected.',
    items: [
      {
        icon: AtSign,
        title: '@-mention context',
        text: 'Type @ to pull real project context into the request: a single file, a whole folder, the diagnostics panel, or your Git changes.',
        chips: ['@api/auth.ts', '@folder', '@problems', '@git-changes'],
      },
      {
        icon: ListChecks,
        title: 'Multi-step runs & teams',
        text: 'Plan a goal into tasks and verify each milestone. Agent teams split the same goal across roles with file ownership per brief.',
        chips: ['plan → tasks', 'verify milestones'],
        beta: true,
      },
      {
        icon: Plug,
        title: 'MCP servers',
        text: 'Connect Model Context Protocol servers to give the assistant external tools. Every tool call waits for your approval before it runs.',
        chips: ['Model Context Protocol', 'approval-gated'],
      },
      {
        icon: BookOpen,
        title: 'Rules & skills',
        text: 'Teach the assistant your conventions once. Rule files load from the project, and reusable skills carry a workflow between sessions.',
        chips: ['SHADROX.md', 'AGENTS.md', '.cursorrules', 'skills'],
      },
    ],
  },
  {
    id: 'run',
    index: '03',
    label: 'Run',
    icon: SquareTerminal,
    headline: 'Run it, then rewind.',
    tagline: 'A real shell in the project folder, real Git, and a way back when an experiment goes sideways.',
    items: [
      {
        icon: Terminal,
        title: 'Integrated terminal',
        text: 'An interactive shell rooted in your workspace, with sessions and splits. PowerShell and bash report live cwd and exit codes back to the panel.',
        chips: ['PowerShell', 'bash', 'live cwd', 'exit codes'],
      },
      {
        icon: GitBranch,
        title: 'Source control',
        text: 'Stage diffs, switch branches and write the commit message with AI help — without leaving the window the code is in.',
        chips: ['stage diffs', 'branches', 'AI commit message'],
      },
      {
        icon: History,
        title: 'Rewindable checkpoints',
        text: 'Restore earlier workspace files and your local Git position to the state a checkpoint captured.',
        chips: ['files', 'local Git position'],
        note: 'Installed packages, running terminals and remote effects are not undone.',
      },
      {
        icon: RefreshCw,
        title: 'Auto-updates',
        text: 'ShadRox checks for a newer release when it starts and installs the update when you restart the app.',
        chips: ['checks on start', 'installs on restart'],
      },
    ],
  },
  {
    id: 'ship',
    index: '04',
    label: 'Ship',
    icon: Rocket,
    headline: 'Get it out the door.',
    tagline: 'Push the work and automate the repeat parts without switching to another app.',
    items: [
      {
        icon: GitPullRequest,
        title: 'GitHub integration',
        text: 'Validate a GitHub token inside the app and push your commits straight from the workspace — no separate Git client needed for the everyday path.',
        chips: ['validate token', 'push from the app'],
      },
      {
        icon: Puzzle,
        title: 'Plugins & automations',
        text: 'Workspace plugins extend what ShadRox can do, and automations fire on a schedule or from a webhook so recurring jobs run without you.',
        chips: ['workspace plugins', 'scheduled', 'webhook triggers'],
        beta: true,
      },
    ],
  },
]

const chipClass =
  'font-mono text-[11px] rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 text-[var(--mut)]'

const betaClass =
  'inline-flex shrink-0 items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400'

function trackGlow(e: MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--x', `${e.clientX - rect.left}px`)
  e.currentTarget.style.setProperty('--y', `${e.clientY - rect.top}px`)
}

export function CapabilitySheet() {
  return (
    <section
      id="capability-sheet"
      className="scroll-mt-28 border-t border-[var(--line)] bg-[var(--bg2)] px-5 py-16 lg:px-8 lg:py-20"
    >
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
            Capability sheet
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h2 className="mx-auto mb-4 max-w-[760px] text-center text-[clamp(28px,4vw,46px)] font-bold leading-[1.1] tracking-[-0.04em] text-[var(--ink)]">
            The specifics,{' '}
            <em className="font-normal italic text-[var(--ac)]">grouped by the job.</em>
          </h2>
        </Reveal>
        <Reveal delay={150}>
          <p className="mx-auto max-w-[620px] text-center text-base leading-7 text-[var(--mut)]">
            Four groups — edit, AI, run and ship — with the details that actually
            decide whether a workspace fits the way you work.
          </p>
        </Reveal>
        <Reveal delay={220}>
          <div className="mx-auto mt-7 flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-4 py-2 text-[11px] leading-5 text-[var(--mut)]">
            <span className={betaClass}>Beta</span>
            marks features that are still evolving — review what they produce.
          </div>
        </Reveal>

        <div className="mt-14 space-y-14 lg:mt-16 lg:space-y-16">
          {groups.map((group, gi) => {
            const GroupIcon = group.icon
            const wide = group.items.length === 2
            return (
              <div key={group.id} id={group.id} className="scroll-mt-28">
                <Reveal delay={40}>
                  <div className="mb-6 flex flex-col gap-5 border-b border-[var(--line)] pb-6 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
                    <div className="flex items-center gap-4">
                      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[linear-gradient(135deg,var(--ac),var(--pink))] text-white shadow-[0_10px_26px_var(--glow)]">
                        <GroupIcon className="size-[22px]" strokeWidth={1.75} />
                      </span>
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ac)]">
                          <span className="font-mono">{group.index}</span> · {group.label}
                        </p>
                        <h3 className="mt-1.5 text-[clamp(21px,2.6vw,28px)] font-bold leading-tight tracking-[-0.035em] text-[var(--ink)]">
                          {group.headline}
                        </h3>
                      </div>
                    </div>
                    <p className="max-w-[420px] text-sm leading-6 text-[var(--mut)] lg:text-right">
                      {group.tagline}
                    </p>
                  </div>
                </Reveal>

                {group.note && (
                  <Reveal delay={80}>
                    <p className="mb-5 flex items-start gap-2.5 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3 text-[12px] leading-5 text-[var(--mut)]">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--ac)]" strokeWidth={2} />
                      {group.note}
                    </p>
                  </Reveal>
                )}

                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  {group.items.map((item, i) => {
                    const Icon = item.icon
                    return (
                      <Reveal
                        key={item.title}
                        as="article"
                        delay={(i % 4) * 80 + gi * 20}
                        className={wide ? 'lg:col-span-2' : undefined}
                      >
                        <div
                          onMouseMove={trackGlow}
                          className="feature-card group relative flex h-full flex-col overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6"
                        >
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                            style={{
                              background:
                                'radial-gradient(340px circle at var(--x,50%) var(--y,50%), var(--glow), transparent 62%)',
                            }}
                          />
                          <div className="relative flex h-full flex-col">
                            <div className="mb-4 flex items-start justify-between gap-3">
                              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--bg2)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:-rotate-6 motion-safe:group-hover:scale-110">
                                <Icon className="size-[19px] text-[var(--ac)]" strokeWidth={1.75} />
                              </span>
                              {item.beta && <span className={betaClass}>Beta</span>}
                            </div>

                            <h4 className="text-[15px] font-bold leading-snug text-[var(--ink)]">
                              {item.title}
                            </h4>
                            <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">
                              {item.text}
                            </p>

                            {item.note && (
                              <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
                                <TriangleAlert className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
                                {item.note}
                              </p>
                            )}

                            <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
                              {item.chips.map((chip) => (
                                <span key={chip} className={chipClass}>
                                  {chip}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </Reveal>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}