'use client'

import { useState } from 'react'
import { CircleCheck, Minus, RotateCcw, ShieldAlert, X } from 'lucide-react'

type Stage = 'initial' | 'expanded' | 'done'

/** Numbered annotation that ties the mock dialog to the click-through steps. */
function StepBadge({ n, pulse = false }: { n: number; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-[18px] shrink-0 place-items-center rounded-full bg-[var(--ac)] text-[10px] font-bold text-white shadow-[0_2px_10px_var(--glow)] ${pulse ? 'glow-dot' : ''}`}
    >
      {n}
    </span>
  )
}

/**
 * Illustrative, interactive replica of the Windows SmartScreen prompt an
 * unsigned installer triggers. Purely a rehearsal aid — it never downloads
 * or runs anything. Styled with the landing's theme tokens so it follows
 * dark and light mode.
 */
export function SmartScreenMock({ installerName }: { installerName: string }) {
  const [stage, setStage] = useState<Stage>('initial')

  return (
    <figure className="relative mx-auto w-full max-w-[460px]">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-3 rounded-[30px] blur-2xl"
        style={{ background: 'color-mix(in srgb, var(--ac) 13%, transparent)' }}
      />

      <div
        role="group"
        aria-label="Illustrative SmartScreen dialog — try the click-through"
        className="relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--card)] shadow-[0_24px_60px_var(--shadow)]"
      >
        {/* Title bar */}
        <div
          className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5"
          style={{ background: 'color-mix(in srgb, var(--ac) 9%, var(--card))' }}
        >
          <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-[var(--ink2)]">
            <ShieldAlert className="size-3.5 text-[var(--ac)]" strokeWidth={2} />
            Windows Defender SmartScreen
          </span>
          <span aria-hidden className="flex items-center gap-2.5 text-[var(--mut)]">
            <Minus className="size-3.5" />
            <X className="size-3.5" />
          </span>
        </div>

        {/* Body */}
        <div className="p-5 sm:p-6" aria-live="polite">
          {stage === 'done' ? (
            <div key="done" style={{ animation: 'slide-down 0.35s ease' }}>
              <span
                className="mb-4 grid size-11 place-items-center rounded-full"
                style={{ background: 'color-mix(in srgb, var(--ac) 14%, transparent)' }}
              >
                <CircleCheck className="size-5 text-[var(--ac)]" strokeWidth={1.75} />
              </span>
              <h3 className="text-[16px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                That&apos;s the whole flow.
              </h3>
              <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">
                On your PC, the installer would start now. This replica is only an illustration —
                nothing was downloaded or run here.
              </p>
              <button
                type="button"
                onClick={() => setStage('initial')}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg2)] px-4 py-2 text-xs font-semibold text-[var(--ink2)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
              >
                <RotateCcw className="size-3.5" />
                Replay the dialog
              </button>
            </div>
          ) : (
            <div key={stage} style={{ animation: 'slide-down 0.35s ease' }}>
              <h3 className="text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                Windows protected your PC
              </h3>
              <p className="mt-2 text-[13px] leading-6 text-[var(--mut)]">
                Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running
                this app might put your PC at risk.
              </p>

              {stage === 'initial' ? (
                <button
                  type="button"
                  onClick={() => setStage('expanded')}
                  className="relative mt-4 inline-flex items-center text-[13px] font-semibold text-[var(--ac)] underline underline-offset-4 transition hover:opacity-80"
                >
                  More info
                  <span className="absolute -right-7 -top-2.5">
                    <StepBadge n={1} pulse />
                  </span>
                </button>
              ) : (
                <>
                  <div className="mt-4 space-y-1 rounded-xl border border-[var(--line)] bg-[var(--bg2)] p-3.5 font-mono text-[12px] leading-5 text-[var(--ink2)]">
                    <p className="break-all">App: {installerName}</p>
                    <p className="flex flex-wrap items-center gap-2">
                      Publisher: <b className="font-bold text-[var(--ink)]">Unknown</b>
                      <StepBadge n={2} />
                    </p>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setStage('done')}
                      className="relative inline-flex items-center rounded-lg bg-[linear-gradient(110deg,var(--ac),var(--pink))] px-4 py-2 text-[13px] font-bold text-white shadow-[0_8px_20px_var(--glow)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_26px_var(--glow)]"
                    >
                      Run anyway
                      <span className="absolute -right-2.5 -top-2.5">
                        <StepBadge n={3} pulse />
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setStage('initial')}
                      className="rounded-lg border border-[var(--line)] bg-[var(--bg2)] px-4 py-2 text-[13px] font-semibold text-[var(--ink2)] transition hover:border-[var(--ac)] hover:text-[var(--ac)]"
                    >
                      Don&apos;t run
                    </button>
                  </div>
                  <p className="mt-3 text-[11px] leading-4 text-[var(--mut)]">
                    Unsure? Choose Don&apos;t run, verify the checksum, then come back.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <figcaption className="mt-3 text-center text-[11px] leading-4 text-[var(--mut)]">
        Illustrative replica — simplified layout, not a real Windows dialog. Try the click-through.
      </figcaption>
    </figure>
  )
}
