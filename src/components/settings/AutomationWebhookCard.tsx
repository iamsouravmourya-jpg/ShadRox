import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play, RefreshCw, Square } from 'lucide-react';
import {
  getDesktopBridge,
  type AutomationWebhookStatus
} from '../../lib/desktop';
import type { AutomationDefinition } from '../../lib/automations';
import {
  Card,
  Notice,
  SectionTitle,
  errorMessage,
  ghostButtonClass,
  secondaryButtonClass
} from './shared';

export interface AutomationWebhookCardProps {
  workspaceId?: string | null;
  definitions: AutomationDefinition[];
  /** A workspace that has not opted in must not expose a live endpoint. */
  enabled?: boolean;
}

export function AutomationWebhookCard({ workspaceId, definitions, enabled = false }: AutomationWebhookCardProps) {
  const [status, setStatus] = useState<AutomationWebhookStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const webhookDefs = useMemo(
    () => definitions.filter((definition) => definition.enabled && definition.trigger.type === 'webhook'),
    [definitions]
  );

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try {
      setStatus(await desktop.automationWebhookStatus(workspaceId));
      setStatusError(null);
    } catch (cause) {
      setStatusError(errorMessage(cause));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async () => {
    if (!workspaceId) return;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setBusy(true);
    setStatusError(null);
    try {
      await desktop.startAutomationWebhook(workspaceId);
      await refresh();
    } catch (cause) {
      setStatusError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setBusy(true);
    setStatusError(null);
    try {
      await desktop.stopAutomationWebhook();
      await refresh();
    } catch (cause) {
      setStatusError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied; the URL stays selectable either way.
    }
  };

  // Revoking consent must also tear down a listener started here; the App's
  // own listener is stopped by its config-changed reload.
  useEffect(() => {
    if (enabled || !status?.running) return;
    void stop();
  }, [enabled, status?.running]);

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>Webhook listener</SectionTitle>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh webhook status"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {statusError && <Notice tone="error">{statusError}</Notice>}

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            status?.running ? 'bg-violet-300 shadow-[0_0_8px_#c4b5fd]' : 'bg-neutral-600'
          }`}
        />
        <span className="text-neutral-300">
          {status?.running ? `Running on port ${status.port}` : 'Stopped'}
        </span>
        {status?.error && <span className="min-w-0 truncate text-red-400">{status.error}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {status?.running ? (
          <button type="button" className={ghostButtonClass} onClick={() => void stop()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            Stop
          </button>
        ) : (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void start()}
            disabled={busy || !workspaceId || !enabled}
            title={enabled ? undefined : 'Enable automations for this workspace first'}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Start
          </button>
        )}
        <span className="text-[10px] text-neutral-500">
          {enabled ? 'Loopback only — binds 127.0.0.1.' : 'Paused until automations are enabled.'}
        </span>
      </div>

      {status?.running && (
        <div className="space-y-1">
          {webhookDefs.length === 0 ? (
            <p className="text-[10px] text-neutral-500">
              No enabled webhook automations — add a trigger with type "webhook" and a path.
            </p>
          ) : (
            webhookDefs.map((definition) => {
              const path = definition.trigger.type === 'webhook' ? definition.trigger.path : '';
              const url = `http://127.0.0.1:${status.port ?? ''}${path}`;
              return (
                <div key={definition.id} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 font-mono text-[10px] text-violet-200">
                    {url}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(url)}
                    className="shrink-0 rounded-md border border-white/[0.09] px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-violet-300/30 hover:text-violet-200"
                  >
                    Copy
                  </button>
                </div>
              );
            })
          )}
          <p className="text-[10px] leading-relaxed text-neutral-500">
            POST only. The request must carry the automation's{' '}
            <code className="font-mono text-violet-300">secret</code> in the request header; the listener checks
            it before running anything.
          </p>
        </div>
      )}
    </Card>
  );
}
