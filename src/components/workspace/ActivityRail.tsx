import { FolderTree, GitBranch, LogOut, MonitorPlay, Search, UserRound } from 'lucide-react';

export interface ActivityRailProps {
  isPreviewOpen: boolean;
  isSearchPanelOpen: boolean;
  isScmPanelOpen: boolean;
  isAccountMenuOpen: boolean;
  user: { email: string | null; avatarUrl?: string | null } | null;
  onSelectWorkspaceView: () => void;
  onSelectPreviewView: () => void;
  onToggleSearchPanel: () => void;
  onToggleScmPanel: () => void;
  onToggleAccountMenu: () => void;
  onCloseAccountMenu: () => void;
  onSignOut: () => void;
}

export function ActivityRail({
  isPreviewOpen,
  isSearchPanelOpen,
  isScmPanelOpen,
  isAccountMenuOpen,
  user,
  onSelectWorkspaceView,
  onSelectPreviewView,
  onToggleSearchPanel,
  onToggleScmPanel,
  onToggleAccountMenu,
  onCloseAccountMenu,
  onSignOut
}: ActivityRailProps) {
  return (
    <nav className="relative order-first flex w-full shrink-0 items-center gap-1.5 border-b border-line bg-base-2/95 px-2 py-1.5 md:h-auto md:w-12 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-2.5">
      <button
        type="button"
        onClick={onSelectWorkspaceView}
        aria-pressed={!isPreviewOpen && !isSearchPanelOpen && !isScmPanelOpen}
        title="Open the code workspace"
        className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all cursor-pointer ${
          !isPreviewOpen && !isSearchPanelOpen && !isScmPanelOpen
            ? 'border-accent-line bg-accent-soft text-accent shadow-[0_0_16px_var(--glow)]'
            : 'border-transparent text-ink-4 hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <FolderTree className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        onClick={onSelectPreviewView}
        aria-pressed={isPreviewOpen}
        title="Show preview"
        className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all cursor-pointer ${
          isPreviewOpen
            ? 'border-accent-line bg-accent-soft text-accent shadow-[0_0_16px_var(--glow)]'
            : 'border-transparent text-ink-4 hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <MonitorPlay className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        onClick={onToggleSearchPanel}
        aria-pressed={isSearchPanelOpen}
        title={isSearchPanelOpen ? 'Close search' : 'Search in files'}
        className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all cursor-pointer ${
          isSearchPanelOpen
            ? 'border-accent-line bg-accent-soft text-accent shadow-[0_0_16px_var(--glow)]'
            : 'border-transparent text-ink-4 hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <Search className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        onClick={onToggleScmPanel}
        aria-pressed={isScmPanelOpen}
        title={isScmPanelOpen ? 'Close source control' : 'Source control'}
        className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all cursor-pointer ${
          isScmPanelOpen
            ? 'border-accent-line bg-accent-soft text-accent shadow-[0_0_16px_var(--glow)]'
            : 'border-transparent text-ink-4 hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <GitBranch className="h-[18px] w-[18px]" />
      </button>

      <div className="relative ml-auto md:ml-0 md:mt-auto">
        <button
          type="button"
          onClick={onToggleAccountMenu}
          aria-pressed={isAccountMenuOpen}
          title={user?.email ?? 'Account'}
          className={`flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border transition-colors cursor-pointer ${
            isAccountMenuOpen
              ? 'border-accent-line'
              : 'border-line hover:border-line-2'
          }`}
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
          ) : user?.email ? (
            <span className="text-xs font-semibold text-accent">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <UserRound className="h-[18px] w-[18px] text-ink-3" />
          )}
        </button>

        {isAccountMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={onCloseAccountMenu}
              aria-hidden="true"
            />
            <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-line-2 bg-base-2 shadow-2xl md:bottom-0 md:left-full md:mb-0 md:ml-2">
              <div className="flex items-center gap-2.5 border-b border-line px-3 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-overlay">
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                  ) : user?.email ? (
                    <span className="text-xs font-semibold text-accent">
                      {user.email.slice(0, 1).toUpperCase()}
                    </span>
                  ) : (
                    <UserRound className="h-4 w-4 text-ink-3" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink">
                    {user?.email ?? 'Not signed in'}
                  </p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-4">
                    Free · bring your own key
                  </p>
                </div>
              </div>
              {user && (
                <button
                  type="button"
                  onClick={() => {
                    onCloseAccountMenu();
                    onSignOut();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-ink-3 transition-colors hover:bg-overlay-2 hover:text-ink cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Log out
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
