import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';

/** Reused drawer tokens so every new settings section looks native. */
export const inputClass =
  'w-full rounded-xl border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-xs font-mono text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-violet-300/40';

export const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-violet-300 px-3 py-2 text-xs font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-40';

export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-300/25 bg-violet-500/[.08] px-3 py-2 text-xs text-violet-100 transition-colors hover:bg-violet-500/[.14] disabled:cursor-not-allowed disabled:opacity-40';

export const ghostButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.09] px-3 py-2 text-xs text-neutral-300 transition-colors hover:border-white/[0.15] hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

export const dangerIconButtonClass =
  'inline-flex items-center justify-center rounded-lg border border-white/[0.09] p-1.5 text-neutral-500 transition-colors hover:border-red-500/40 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">{children}</h3>;
}

const NOTICE_TONE = {
  ok: 'border-violet-300/25 bg-violet-500/[.07] text-violet-300',
  error: 'border-red-900/60 bg-red-950/20 text-red-400',
  info: 'border-white/[0.09] bg-white/[0.02] text-neutral-400'
} as const;

export function Notice({
  tone = 'info',
  children
}: {
  tone?: keyof typeof NOTICE_TONE;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${NOTICE_TONE[tone]}`}
    >
      {tone === 'ok' && <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      {tone === 'error' && <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.02] p-4">
      <p className="text-xs font-medium text-neutral-200">{title}</p>
      <div className="mt-1 text-[11px] leading-relaxed text-neutral-500">{children}</div>
    </div>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
        enabled
          ? 'border-violet-300/25 bg-violet-500/10 text-violet-300'
          : 'border-white/[0.09] bg-white/[0.03] text-neutral-500'
      }`}
    >
      {enabled ? 'enabled' : 'disabled'}
    </span>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? 'Unknown error');
}

/** One argument per line; blank lines are dropped. */
export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One editable KEY/VALUE pair. Values start blank: saved secrets are never shown. */
export interface PairRow {
  key: string;
  value: string;
}

export function pairRows(pairs?: Record<string, string>): PairRow[] {
  return Object.keys(pairs ?? {}).map((key) => ({ key, value: '' }));
}

/** A blank value keeps the stored value for that key, so editing keeps secrets. */
export function pairsFromRows(rows: PairRow[], stored?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    result[key] =
      row.value.trim() === '' && stored?.[key] !== undefined ? stored[key] : row.value;
  }
  return result;
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
