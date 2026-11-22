import { ArrowLeft, Bug, Loader2, Settings, Terminal } from 'lucide-react';
import { ShadRoxLogo } from '../Logo';
import { ThemeToggle } from '../ThemeToggle';
import type { UpdaterStatus } from '../../lib/desktop';

export interface WorkspaceHeaderProps {
  workspaceName?: string;
  workspaceKind?: 'folder' | 'file';
  headerFileLabel: string;
  dirtyCount: number;
  isBusy: boolean;
  updaterStatus: UpdaterStatus | null;
  canWriteToDisk: boolean;
  autoSave: boolean;
  onToggleAutoSave: () => void;
  terminalAvailable: boolean;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  onBackToHub: () => void;
  onOpenFeedback: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
}

export function WorkspaceHeader({
  workspaceName,
  workspaceKind,
  headerFileLabel,
  dirtyCount,
  isBusy,
  updaterStatus,
  canWriteToDisk,
  autoSave,
  onToggleAutoSave,
  terminalAvailable,
  isTerminalOpen,
  onToggleTerminal,
  onBackToHub,
  onOpenFeedback,
  isSettingsOpen,
  onToggleSettings
}: WorkspaceHeaderProps) {
  return (
    <header className="titlebar window-controls-inset h-12 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-line bg-surface/90 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          type="button"
          onClick={onBackToHub}
          title="Back to Workspace Hub"
          aria-label="Back to Workspace Hub"
          className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-overlay-2 transition-colors cursor-pointer shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="flex items-center gap-2 min-w-0">
          <ShadRoxLogo className="w-4 h-4 shrink-0 text-accent" />
          <span className="text-xs font-semibold tracking-[-0.02em] text-ink truncate">
            {workspaceName ?? 'ShadRox'}
          </span>
        </span>
        <span className="hidden md:inline font-mono text-[10px] text-ink-4 tabular-nums shrink-0">
          v0.1.4
        </span>
        <span
          className="hidden sm:inline text-[10px] font-mono uppercase tracking-wider text-ink-4 tabular-nums shrink-0"
          title={workspaceKind === 'folder' ? 'Files in the opened folder' : 'Files in this workspace'}
        >
          {headerFileLabel}
        </span>
        {dirtyCount > 0 && (
          <span
            className="hidden sm:inline font-mono text-[10px] font-medium text-warn tabular-nums shrink-0"
            title="Unsaved changes"
          >
            · {dirtyCount} unsaved
          </span>
        )}
        {isBusy && <Loader2 className="w-3 h-3 animate-spin text-accent shrink-0" />}
        {(updaterStatus?.state === 'available' || updaterStatus?.state === 'ready') && (
          <span className="hidden sm:inline font-mono text-[10px] font-medium text-cool shrink-0">
            · Update {updaterStatus.state === 'ready' ? 'ready' : 'available'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {canWriteToDisk && (
          <button
            type="button"
            onClick={onToggleAutoSave}
            title="Auto-save to disk on edit"
            className={`whitespace-nowrap shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wide transition-colors cursor-pointer ${
              autoSave
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line-2 text-ink-3 hover:text-ink'
            }`}
          >
            Auto-save {autoSave ? 'on' : 'off'}
          </button>
        )}

        {terminalAvailable && (
          <button
            type="button"
            onClick={onToggleTerminal}
            aria-pressed={isTerminalOpen}
            className={`whitespace-nowrap shrink-0 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
              isTerminalOpen
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line-2 text-ink-3 hover:text-ink'
            }`}
            title={isTerminalOpen ? 'Close interactive terminal' : 'Open interactive terminal'}
          >
            <Terminal className="w-3 h-3" />
            Terminal
          </button>
        )}
        <ThemeToggle />
        <button
          type="button"
          onClick={onOpenFeedback}
          title="Report a bug or request a feature"
          className="whitespace-nowrap shrink-0 flex items-center gap-1.5 rounded-full border border-line-2 px-2.5 py-1 text-[11px] text-ink-3 transition-colors hover:border-accent-line hover:text-accent cursor-pointer"
        >
          <Bug className="w-3 h-3" />
          Feedback
        </button>
        <button
          type="button"
          onClick={onToggleSettings}
          title={isSettingsOpen ? 'Close settings (Esc)' : 'Settings'}
          aria-label="Settings"
          className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-overlay-2 transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
