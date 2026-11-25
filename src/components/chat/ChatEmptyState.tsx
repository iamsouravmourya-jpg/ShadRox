import { Code2, Compass, KeyRound, Rocket, Zap } from 'lucide-react';
import { ShadRoxLogo } from '../Logo';
import { CHAT_STARTERS, type ChatStarter } from './chatUx';

interface ChatEmptyStateProps {
  hasKey: boolean;
  userFirstName?: string | null;
  onOpenSettings: () => void;
  onSelectStarter: (prompt: string) => void;
}

const STARTER_ICON: Record<ChatStarter['id'], typeof Code2> = {
  build: Rocket,
  explain: Code2,
  optimize: Zap,
  plan: Compass
};

export function ChatEmptyState({ hasKey, userFirstName, onOpenSettings, onSelectStarter }: ChatEmptyStateProps) {
  const displayName = userFirstName?.trim() || 'Builder';

  return (
    <div className="relative flex min-h-full flex-col justify-center overflow-hidden px-1.5 py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-56 opacity-90"
        style={{
          background: 'radial-gradient(ellipse at 50% 15%, var(--glow), transparent 72%)'
        }}
      />
      <div className="relative mx-auto w-full max-w-sm space-y-5">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3.5 grid size-14 place-items-center rounded-2xl border border-accent-line bg-surface-2 shadow-[0_0_32px_var(--glow)]">
            <ShadRoxLogo className="h-7 w-7 text-accent" />
          </div>
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">
            Hello, <span className="text-accent">{displayName}</span>{' '}
            <span aria-hidden="true">👋</span>
          </h2>
          <p className="mt-1 text-[12px] text-ink-3">
            What do you want to build today?
          </p>
        </div>

        {!hasKey && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-line bg-accent-soft px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <KeyRound className="h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="text-[11.5px] font-medium text-ink">Bring your own API key</p>
                <p className="text-[10.5px] text-ink-3">Keys stay local — zero ShadRox markup</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="shrink-0 cursor-pointer whitespace-nowrap rounded-lg bg-accent-strong px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-[0_2px_12px_var(--glow)] transition-all hover:brightness-110"
            >
              Add key
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Starter prompts">
          {CHAT_STARTERS.map((starter) => {
            const Icon = STARTER_ICON[starter.id];
            return (
              <button
                key={starter.id}
                type="button"
                title={starter.subtitle}
                onClick={() => onSelectStarter(starter.prompt)}
                className="group flex flex-col items-start gap-1.5 rounded-xl border border-line bg-surface/90 p-2.5 text-left transition-all hover:border-accent-line hover:bg-surface-2 hover:shadow-[0_4px_20px_-8px_var(--glow)] cursor-pointer"
              >
                <span className="inline-flex max-w-full items-center gap-1.5 text-ink-2 group-hover:text-ink">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate text-[11px] font-medium leading-snug">{starter.title}</span>
                </span>
                <span className="line-clamp-1 text-[10px] text-ink-4">
                  {starter.subtitle}
                </span>
              </button>
            );
          })}
        </div>

        <p className="flex items-center justify-center gap-1.5 text-[10.5px] text-ink-4">
          <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-2">@</kbd>
          <span>to mention files or symbols in your prompt</span>
        </p>
      </div>
    </div>
  );
}
