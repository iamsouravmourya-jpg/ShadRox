import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cycleThemeMode, getThemeMode, subscribeTheme } from '../lib/theme';

const LABEL = { light: 'Day theme', dark: 'Night theme' } as const;

/**
 * One button, two states: day ↔ night. The icon shows the current choice and
 * the tooltip says what clicking will do.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const mode = useSyncExternalStore(subscribeTheme, getThemeMode, () => 'dark' as const);
  const Icon = mode === 'light' ? Sun : Moon;
  const next = mode === 'light' ? 'dark' : 'light';

  return (
    <button
      type="button"
      onClick={cycleThemeMode}
      title={`${LABEL[mode]} — click for ${LABEL[next].toLowerCase()}`}
      aria-label={`Theme: ${LABEL[mode]}. Switch to ${LABEL[next].toLowerCase()}.`}
      className={`inline-flex size-8 items-center justify-center rounded-full border border-line bg-overlay text-ink-3 transition-colors hover:border-accent-line hover:text-accent cursor-pointer ${className}`}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}
