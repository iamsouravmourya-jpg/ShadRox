import { ArrowUpRight, Bug, Code2, Compass, KeyRound, Layers } from 'lucide-react';
import { ShadRoxLogo } from '../Logo';
import { CHAT_STARTERS, type ChatStarter } from './chatUx';

interface ChatEmptyStateProps {
  hasKey: boolean;
  onOpenSettings: () => void;
  onSelectStarter: (prompt: string) => void;
}

const STARTER_ICON: Record<ChatStarter['id'], typeof Code2> = {
  explain: Code2,
  fix: Bug,
  plan: Compass,
  refactor: Layers
};

export function ChatEmptyState({ hasKey, onOpenSettings, onSelectStarter }: ChatEmptyStateProps) {
  return (
    <div className="flex min-h-full flex-col justify-center px-2 py-6">
      <div className="mx-auto w-full max-w-sm space-y-5">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-surface shadow-[var(--shadow-panel)]">
            <ShadRoxLogo className="h-5 w-5" />
          </div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">
            ShadRox Assistant
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
            Ask directly, or switch to multi-step edits and autonomous runs when a change spans files.
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
              className="shrink-0 cursor-pointer whitespace-nowrap rounded-lg bg-accent-strong px-2.5 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Add key
            </button>
          </div>
        )}

        <div className="space-y-1.5" role="group" aria-label="Starter prompts">
          <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
            Start with a prompt
          </p>
          {CHAT_STARTERS.map((starter) => {
            const Icon = STARTER_ICON[starter.id];
            return (
              <button
                key={starter.id}
                type="button"
                onClick={() => onSelectStarter(starter.prompt)}
                className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-accent-line hover:bg-surface-2"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-base text-ink-3 transition-colors group-hover:border-accent-line group-hover:text-accent">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-ink">
                    {starter.title}
                  </span>
                  <span className="block truncate text-[10.5px] text-ink-4">
                    {starter.subtitle}
                  </span>
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-5 transition-colors group-hover:text-accent" />
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
