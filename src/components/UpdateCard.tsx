/**
 * Update status for the packaged app. Hidden in the browser build, where there
 * is nothing to update from.
 */
import { useEffect, useState } from 'react';
import { getDesktopBridge, type UpdaterStatus } from '../lib/desktop';

function describe(status: UpdaterStatus): string {
  switch (status.state) {
    case 'checking':
      return 'Checking for a new build…';
    case 'available':
      return `ShadRox ${status.version} found — downloading…`;
    case 'downloading':
      return `Downloading update — ${status.percent}%`;
    case 'ready':
      return `ShadRox ${status.version} downloaded. Restart to finish.`;
    case 'error':
      return 'Update check failed. ShadRox will try again later.';
    default:
      return 'You are on the newest beta build.';
  }
}

export function UpdateCard() {
  const bridge = getDesktopBridge();
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'up-to-date' });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!bridge?.onUpdaterStatus) return;
    return bridge.onUpdaterStatus(setStatus);
  }, [bridge]);

  if (!bridge?.checkForUpdates) return null;

  const checkNow = async () => {
    setUnavailable(false);
    setStatus({ state: 'checking' });
    try {
      const result = await bridge.checkForUpdates();
      setUnavailable(!result.available);
    } catch {
      setStatus({ state: 'error', message: 'update check failed' });
    }
  };

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs text-neutral-200 font-medium">Automatic updates</span>
          <span className="block text-[11px] text-neutral-400 mt-1">
            {unavailable
              ? 'Updates install in the packaged desktop app.'
              : describe(status)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void checkNow()}
          className="shrink-0 cursor-pointer rounded-lg border border-white/[0.09] px-2.5 py-1 text-[11px] text-neutral-300 transition-colors hover:border-violet-400/40 hover:text-white"
        >
          Check now
        </button>
      </div>
    </section>
  );
}
