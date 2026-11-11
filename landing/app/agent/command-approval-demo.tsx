'use client'

import { useId, useState } from 'react'
import { CircleCheck, ShieldCheck, Terminal, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const EXAMPLES = [
  'npm test',
  'git status',
  'npm test -- --watch',
  'git diff | head',
  'npm install',
]

type Verdict = { state: 'idle' | 'allow' | 'ask'; reason: string }

function classify(raw: string, allowed: readonly string[]): Verdict {
  const cmd = raw.trim()
  if (!cmd) return { state: 'idle', reason: '' }
  if (allowed.includes(cmd)) {
    return { state: 'allow', reason: 'Exact match with an allowed verify form.' }
  }
  if (/[|&;<>`]|\$\(/.test(cmd)) {
    return { state: 'ask', reason: 'A shell operator breaks the match — approval required.' }
  }
  if (allowed.some((a) => cmd.startsWith(`${a} `))) {
    return { state: 'ask', reason: 'One extra argument breaks the exact match — approval required.' }
  }
  return { state: 'ask', reason: 'Not an allowed verify form — approval required.' }
}

/**
 * A faithful, interactive demo of the default-deny matcher:
 * type a command and see whether it would run freely or open the
 * native approval dialog in the app. The exact allowlist is passed
 * in from the server page so both renderings share one source.
 */
export function CommandApprovalDemo({ allowed }: { allowed: readonly string[] }) {
  const inputId = useId()
  const [value, setValue] = useState('')
  const verdict = classify(value, allowed)

  return (
    <div className="flex h-full flex-col rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 sm:p-8">
      <div className="mb-4 flex items-center gap-2">
        <Terminal className="size-4 text-[var(--ac)]" strokeWidth={1.75} />
        <h3 className="text-sm font-bold text-[var(--ink)]">Try the matcher</h3>
        <span className="ml-auto rounded-md border border-[var(--line)] bg-[var(--bg2)] px-2 py-0.5 font-mono text-[11px] text-[var(--mut)]">
          live demo
        </span>
      </div>

      {/* Terminal-style input */}
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg2)] p-4">
        <div className="mb-3 flex items-center gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-[var(--line)]" />
          <span className="size-2.5 rounded-full bg-[var(--line)]" />
          <span className="size-2.5 rounded-full bg-[var(--line)]" />
        </div>
        <label htmlFor={inputId} className="sr-only">
          Type a shell command to test the approval matcher
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--card)] px-3 py-2.5 transition focus-within:border-[var(--ac)] focus-within:shadow-[0_0_0_3px_var(--glow)]">
          <span className="font-mono text-sm font-bold text-[var(--ac)]" aria-hidden>
            $
          </span>
          <input
            id={inputId}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="type a command…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent font-mono text-sm text-[var(--ink)] caret-[var(--ac)] outline-none placeholder:text-[var(--mut)]"
          />
          {value && (
            <button
              type="button"
              onClick={() => setValue('')}
              aria-label="Clear command"
              className="grid size-6 shrink-0 place-items-center rounded-md text-[var(--mut)] transition hover:bg-[var(--bg2)] hover:text-[var(--ink)]"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Verdict */}
        <div aria-live="polite" className="mt-3 min-h-[76px]">
          {verdict.state === 'idle' && (
            <p className="px-1 pt-1 text-xs leading-5 text-[var(--mut)]">
              Type a command — or pick an example below — to see whether it would run
              without a prompt or open the approval dialog.
            </p>
          )}
          {verdict.state === 'allow' && (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-bold text-emerald-700 dark:text-emerald-400">
                <CircleCheck className="size-4 shrink-0" strokeWidth={2} />
                Runs without a prompt
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--ink2)]">{verdict.reason}</p>
            </div>
          )}
          {verdict.state === 'ask' && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-bold text-amber-700 dark:text-amber-400">
                <ShieldCheck className="size-4 shrink-0" strokeWidth={2} />
                Opens the approval dialog
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--ink2)]">
                {verdict.reason} The workspace is re-checked between approval and execution.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Example commands */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--mut)]">
          Try
        </span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setValue(ex)}
            className={cn(
              'rounded-md border px-2 py-0.5 font-mono text-[11px] transition',
              value.trim() === ex
                ? 'border-[var(--ac)] bg-[var(--bg2)] text-[var(--ac)]'
                : 'border-[var(--line)] bg-[var(--bg2)] text-[var(--ink2)] hover:border-[var(--ac)] hover:text-[var(--ac)]',
            )}
          >
            {ex}
          </button>
        ))}
      </div>

      <p className="mt-auto pt-4 text-[11px] leading-4 text-[var(--mut)]">
        A faithful demo of the exact-match rule. In the app, the approval dialog is native —
        and deleting a path always needs an explicit confirm plus a follow-up read.
      </p>
    </div>
  )
}