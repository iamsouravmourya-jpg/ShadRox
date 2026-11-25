import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bundleDocument, bundleProject, canBundle, describeBundleError } from '../lib/bundler';
import { friendlyPreviewError, type AutomationDesktopApi, type BundleState } from '../lib/appHelpers';
import {
  PREVIEW_AGENT_CONTROL_EVENT,
  type DesktopPreviewOutput,
  type DesktopPreviewState,
  type PreviewApprovalRequest,
  type PreviewProjectCandidate,
  type ShadRoxDesktopAPI
} from '../lib/desktop';
import {
  PREVIEW_BASE_STYLE,
  PREVIEW_ERROR_BRIDGE,
  previewCapabilityMessage,
  resolvePreviewDocument
} from '../lib/preview';
import type { AssetMap } from '../lib/assets';
import type { SecretItem, WorkspaceFile } from '../lib/types';
import { usePreviewSync } from './usePreviewSync';

/** Keep only entries matching the highest active previewRunId so stale run logs never bleed into context. */
export function filterLogsForLatestPreviewRun(logs: DesktopPreviewOutput[]): DesktopPreviewOutput[] {
  if (!Array.isArray(logs)) return [];
  let latestRunId = 0;
  for (const entry of logs) {
    if (entry && typeof entry.previewRunId === 'number' && Number.isFinite(entry.previewRunId) && entry.previewRunId > latestRunId) {
      latestRunId = entry.previewRunId;
    }
  }
  if (latestRunId <= 0) return logs;
  return logs.filter((entry) => entry && entry.previewRunId === latestRunId);
}

export interface UseLocalPreviewControllerOptions {
  desktop: ShadRoxDesktopAPI | null;
  desktopBridge: (ShadRoxDesktopAPI & AutomationDesktopApi) | null;
  nativeWorkspaceId: string | null;
  workspaceKind: 'folder' | 'file' | undefined;
  files: WorkspaceFile[];
  activeFile: WorkspaceFile | null | undefined;
  assets: AssetMap;
  secrets: SecretItem[];
  changeRevision: number;
  isPreviewOpen: boolean;
  setIsPreviewOpen: (open: boolean) => void;
  isPreviewFullscreen: boolean;
  setIsPreviewFullscreen: (value: boolean | ((prev: boolean) => boolean)) => void;
}

export function useLocalPreviewController({
  desktop,
  desktopBridge,
  nativeWorkspaceId,
  workspaceKind,
  files,
  activeFile,
  assets,
  secrets,
  changeRevision,
  isPreviewOpen,
  setIsPreviewOpen,
  isPreviewFullscreen,
  setIsPreviewFullscreen
}: UseLocalPreviewControllerOptions) {
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [bundleState, setBundleState] = useState<BundleState>({ status: 'idle' });
  const [localRuntime, setLocalRuntime] = useState<DesktopPreviewState>({ status: 'idle', url: null });
  const [localRuntimeLogs, setLocalRuntimeLogs] = useState<DesktopPreviewOutput[]>([]);
  const [previewProjects, setPreviewProjects] = useState<PreviewProjectCandidate[]>([]);
  const [previewAutoReload, setPreviewAutoReload] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('shadrox.preview.autoReload') !== 'off';
    } catch {
      return true;
    }
  });

  const autoPreviewWorkspaceRef = useRef<string | null>(null);
  /**
   * Preview output arrives in bursts (install logs, dev-server output) and each
   * event used to re-render the whole chat. Batches are flushed at most every
   * 120ms; `previewActiveRef` stops a late `status` line from resurrecting the
   * spinner after a run already failed or was stopped.
   */
  const previewActiveRef = useRef(false);
  const previewStartAttemptRef = useRef(0);
  const previewLogBufferRef = useRef<DesktopPreviewOutput[]>([]);
  // Soft deadline resets on every progress event so a slow dependency install
  // does not eat the startup budget; hard deadline caps total startup time.
  const previewDeadlineRef = useRef({ soft: 0, hard: 0 });
  const previewLogFlushRef = useRef<number | null>(null);
  const currentPreviewRunIdRef = useRef<number>(1);
  const activeRemoteRunIdRef = useRef<number | null>(null);

  const localPreviewAvailable = useMemo(() => {
    return Boolean(desktop && nativeWorkspaceId && workspaceKind === 'folder');
  }, [desktop, nativeWorkspaceId, workspaceKind]);

  // Esc leaves full screen, but closing always has a visible button too — the
  // user should never be stuck inside a panel with only a keyboard way out.
  useEffect(() => {
    if (!isPreviewFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsPreviewFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPreviewFullscreen, setIsPreviewFullscreen]);

  const flushPreviewLogs = useCallback(() => {
    previewLogFlushRef.current = null;
    const batch = previewLogBufferRef.current;
    if (batch.length === 0) return;
    previewLogBufferRef.current = [];
    setLocalRuntimeLogs((previous) => [...previous, ...batch].slice(-200));
  }, []);

  const queuePreviewLog = useCallback(
    (entry: DesktopPreviewOutput) => {
      const buffer = previewLogBufferRef.current;
      buffer.push(entry);
      if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
      if (previewLogFlushRef.current !== null) return;
      previewLogFlushRef.current = window.setTimeout(flushPreviewLogs, 120);
    },
    [flushPreviewLogs]
  );

  useEffect(
    () => () => {
      if (previewLogFlushRef.current !== null) window.clearTimeout(previewLogFlushRef.current);
    },
    []
  );

  useEffect(() => {
    previewStartAttemptRef.current += 1;
    currentPreviewRunIdRef.current = 1;
    activeRemoteRunIdRef.current = null;
    setLocalRuntime({ status: 'idle', url: null });
    setLocalRuntimeLogs([]);
    previewLogBufferRef.current = [];
    previewActiveRef.current = false;
    setPreviewProjects([]);
    if (!desktop || !nativeWorkspaceId) return;

    return desktop.onPreviewOutput((output) => {
      if (output.workspaceId !== nativeWorkspaceId) return;
      const incomingRunId = typeof output.previewRunId === 'number' && Number.isFinite(output.previewRunId)
        ? output.previewRunId
        : null;
      if (incomingRunId !== null) {
        if (activeRemoteRunIdRef.current !== null && incomingRunId < activeRemoteRunIdRef.current) {
          return;
        }
        if (activeRemoteRunIdRef.current === null || incomingRunId > activeRemoteRunIdRef.current) {
          if (activeRemoteRunIdRef.current !== null && incomingRunId > activeRemoteRunIdRef.current) {
            previewLogBufferRef.current = [];
            setLocalRuntimeLogs([]);
          }
          activeRemoteRunIdRef.current = incomingRunId;
          currentPreviewRunIdRef.current = Math.max(currentPreviewRunIdRef.current, incomingRunId);
        }
      }
      queuePreviewLog(output);
      if (
        previewActiveRef.current
        && (output.type === 'install' || output.type === 'status' || output.type === 'stdout' || output.type === 'stderr')
      ) {
        previewDeadlineRef.current.soft = Date.now() + 120_000;
      }
      if (output.type === 'ready') {
        if (!previewActiveRef.current) return;
        const url = output.message.match(/https?:\/\/\S+/)?.[0];
        if (url) {
          const normalized = url.replace(/[),.;]+$/, '');
          setLocalRuntime({
            status: 'ready',
            url: normalized,
            mode: normalized.startsWith('shadrox-preview://') ? 'static' : 'dev',
            hmr: normalized.startsWith('shadrox-preview://') ? false : true
          });
        }
      } else if (output.type === 'stopped') {
        // Only intentional stopPreview calls emit this, and every caller sets pane state itself.
      } else if (output.type === 'error') {
        if (!previewActiveRef.current) return;
        previewActiveRef.current = false;
        setLocalRuntime({ status: 'error', url: null, message: friendlyPreviewError(output.message) });
      } else if (output.type === 'status' && previewActiveRef.current) {
        // Only promote an idle/starting run.
        setLocalRuntime((previous) =>
          previous.status === 'idle' || previous.status === 'starting'
            ? { status: 'starting', url: null }
            : previous
        );
      }
    });
  }, [desktop, nativeWorkspaceId, queuePreviewLog]);

  // The agent's preview_control runs the server through the same bridge but
  // outside startLocalPreview, so the pane has to adopt the run here or its
  // ready/error events stay gated behind previewActiveRef.
  useEffect(() => {
    if (!desktop || !nativeWorkspaceId) return;
    const onAgentControl = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action !== 'start' && action !== 'stop' && action !== 'restart') return;
      previewStartAttemptRef.current += 1;
      if (action === 'stop') {
        previewActiveRef.current = false;
        setLocalRuntime({ status: 'idle', url: null });
        return;
      }
      currentPreviewRunIdRef.current += 1;
      previewActiveRef.current = true;
      previewLogBufferRef.current = [];
      previewDeadlineRef.current = { soft: Date.now() + 120_000, hard: Date.now() + 600_000 };
      setLocalRuntimeLogs([]);
      setRuntimeError(null);
      setPreviewProjects([]);
      setLocalRuntime({ status: 'starting', url: null });
    };
    window.addEventListener(PREVIEW_AGENT_CONTROL_EVENT, onAgentControl);
    return () => window.removeEventListener(PREVIEW_AGENT_CONTROL_EVENT, onAgentControl);
  }, [desktop, nativeWorkspaceId]);

  const startLocalPreview = useCallback(async (approval?: PreviewApprovalRequest, project?: PreviewProjectCandidate) => {
    if (!desktop || !nativeWorkspaceId) return;
    const attempt = ++previewStartAttemptRef.current;
    previewDeadlineRef.current = { soft: Date.now() + 120_000, hard: Date.now() + 600_000 };
    let requestTimedOut = false;
    const startPreviewRequest = (
      options?: { projectPath?: string; projectKind?: 'node' | 'static'; manifestHash?: string; approved?: boolean }
    ) => {
      if (Date.now() >= previewDeadlineRef.current.hard) {
        requestTimedOut = true;
        return Promise.reject(new Error('Preview startup kept working for 10 minutes without becoming ready. Check the Console and retry.'));
      }
      let timeoutId = 0;
      const request = desktop.startPreview(nativeWorkspaceId, options);
      const timeout = new Promise<never>((_, reject) => {
        const arm = () => {
          const wait = Math.max(500, previewDeadlineRef.current.soft - Date.now());
          timeoutId = window.setTimeout(() => {
            const now = Date.now();
            if (now < previewDeadlineRef.current.soft && now < previewDeadlineRef.current.hard) {
              arm();
              return;
            }
            requestTimedOut = true;
            reject(new Error(now >= previewDeadlineRef.current.hard
              ? 'Preview startup kept working for 10 minutes without becoming ready. Check the Console and retry.'
              : 'Preview startup did not respond within 2 minutes. Check the Console and retry.'));
          }, wait);
        };
        arm();
      });
      return Promise.race([request, timeout]).finally(() => window.clearTimeout(timeoutId));
    };
    currentPreviewRunIdRef.current += 1;
    previewActiveRef.current = true;
    previewLogBufferRef.current = [];
    setRuntimeError(null);
    setLocalRuntime({ status: 'starting', url: null });
    setLocalRuntimeLogs([]);
    setPreviewProjects([]);
    try {
      const result = await startPreviewRequest(
        approval
          ? { projectPath: approval.projectPath, projectKind: 'node', manifestHash: approval.manifestHash, approved: true }
          : project ? { projectPath: project.projectPath, projectKind: project.kind, approved: false } : undefined
      );
      if (attempt !== previewStartAttemptRef.current) return;
      if (!result || typeof result !== 'object') {
        throw new Error('Preview failed to return a start result.');
      }
      if (result.status === 'selection-required') {
        previewActiveRef.current = false;
        setPreviewProjects(Array.isArray(result.projects) ? result.projects : []);
        setLocalRuntime({ status: 'idle', url: null });
        return;
      }
      if (result.status === 'approval-required') {
        previewActiveRef.current = false;
        setLocalRuntime({ status: 'idle', url: null });
        return;
      }
      if (typeof result.url !== 'string' || !result.url) {
        throw new Error('Preview did not return a local URL.');
      }
      setPreviewProjects([]);
      setLocalRuntime({
        status: 'ready',
        url: result.url,
        mode: result.script === 'static' ? 'static' : 'dev',
        hmr: result.script === 'static' ? false : result.hmr === true
      });
    } catch (error) {
      if (attempt !== previewStartAttemptRef.current) return;
      const message = friendlyPreviewError(error instanceof Error ? error.message : String(error));
      previewActiveRef.current = false;
      if (requestTimedOut) {
        void desktop.stopPreview(nativeWorkspaceId).then(undefined, (stopError: unknown) => {
          queuePreviewLog({
            workspaceId: nativeWorkspaceId,
            type: 'error',
            message: `Preview cleanup failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
          });
        });
      }
      setPreviewProjects([]);
      setLocalRuntime({ status: 'error', url: null, message });
      queuePreviewLog({
        workspaceId: nativeWorkspaceId,
        type: 'error',
        message
      });
    }
  }, [desktop, nativeWorkspaceId, queuePreviewLog]);

  useEffect(() => {
    if (!localPreviewAvailable || !nativeWorkspaceId) {
      autoPreviewWorkspaceRef.current = null;
      return;
    }
    if (autoPreviewWorkspaceRef.current === nativeWorkspaceId) return;

    autoPreviewWorkspaceRef.current = nativeWorkspaceId;
    // Let the folder paint first: the run does real disk work and used to make
    // opening a project feel frozen.
    const timer = window.setTimeout(() => void startLocalPreview(), 750);
    return () => window.clearTimeout(timer);
  }, [localPreviewAvailable, nativeWorkspaceId, startLocalPreview]);

  const stopLocalPreview = useCallback(async () => {
    if (!desktop || !nativeWorkspaceId) return;
    previewStartAttemptRef.current += 1;
    previewActiveRef.current = false;
    await Promise.allSettled([
      desktop.stopPreview(nativeWorkspaceId),
      desktopBridge?.stopBackendPreview?.(nativeWorkspaceId) ?? Promise.resolve()
    ]);
    setLocalRuntime({ status: 'idle', url: null });
  }, [desktop, desktopBridge, nativeWorkspaceId]);

  const previewDiagnostics = useMemo(() => {
    const latestLogs = filterLogsForLatestPreviewRun(Array.isArray(localRuntimeLogs) ? localRuntimeLogs : []);
    const safeSecrets = Array.isArray(secrets) ? secrets : [];
    const entries = latestLogs.slice(-50).map((entry) => {
      const rawMessage = typeof entry?.message === 'string' ? entry.message : String(entry?.message ?? '');
      const safeMessage = safeSecrets.reduce(
        (message, secret) => secret?.value ? message.split(secret.value).join('[REDACTED]') : message,
        rawMessage
      );
      return `[${entry?.type ?? 'log'}] ${safeMessage.slice(0, 1600)}`;
    });
    return entries.join('\n').slice(-12000);
  }, [localRuntimeLogs, secrets]);

  const localPreviewNeedsSync =
    localRuntime.status === 'ready' &&
    (localRuntime.mode === 'static' || (localRuntime.mode === 'dev' && localRuntime.hmr === false));
  const previewSync = usePreviewSync({
    revision: changeRevision,
    enabled: isPreviewOpen && localPreviewNeedsSync && previewAutoReload
  });

  const togglePreviewAutoReload = useCallback(() => {
    setPreviewAutoReload((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem('shadrox.preview.autoReload', next ? 'on' : 'off');
      } catch {
        /* storage is optional; the in-memory toggle still works */
      }
      return next;
    });
  }, []);

  const bundlable = useMemo(() => canBundle(files), [files]);

  // Next-Level bundle with virtual secrets injection
  useEffect(() => {
    if (!bundlable || localPreviewAvailable) {
      setBundleState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setBundleState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));

    const timer = window.setTimeout(async () => {
      try {
        const result = await bundleProject(files, secrets, assets);
        if (cancelled) return;
        const templateHtml = files.find((f) => f.name.toLowerCase().endsWith('index.html'))?.content;
        setBundleState({
          status: 'ready',
          html: bundleDocument(result, PREVIEW_ERROR_BRIDGE, PREVIEW_BASE_STYLE, secrets, templateHtml),
          label: `Running ${result.entry} — live project bundle`
        });
      } catch (error) {
        if (cancelled) return;
        setBundleState({ status: 'error', message: describeBundleError(error) });
      }
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bundlable, files, secrets, assets, localPreviewAvailable]);

  const staticPreview = useMemo(
    () => resolvePreviewDocument(files, activeFile ?? undefined, assets),
    [files, activeFile, assets]
  );

  const previewDocument = useMemo(() => {
    if (bundleState.status === 'ready') {
      return { html: bundleState.html, label: bundleState.label, source: 'bundle', stackType: 'Live React Bundle' };
    }
    if (bundlable) return null;
    return staticPreview;
  }, [bundleState, bundlable, staticPreview]);

  const previewCapability = useMemo(
    () => previewCapabilityMessage(activeFile ?? undefined),
    [activeFile]
  );

  const handleChoosePreviewProject = useCallback(
    (project: PreviewProjectCandidate) => {
      void startLocalPreview(undefined, project);
    },
    [startLocalPreview]
  );
  const handleCancelProjectSelection = useCallback(() => setPreviewProjects([]), []);
  const handleStartLocalPreview = useCallback(() => {
    void startLocalPreview();
  }, [startLocalPreview]);
  const handleStopLocalPreview = useCallback(() => {
    void stopLocalPreview();
  }, [stopLocalPreview]);
  const handleClearLocalPreviewLogs = useCallback(() => setLocalRuntimeLogs([]), []);
  const handleDismissPreviewError = useCallback(() => setRuntimeError(null), []);
  const handleBrowserConsoleLog = useCallback(
    (entries: { type: string; message: string }[]) => {
      const safeEntries = Array.isArray(entries) ? entries : [];
      if (safeEntries.length === 0) return;
      const previewRunId = activeRemoteRunIdRef.current ?? currentPreviewRunIdRef.current;
      setLocalRuntimeLogs((previous) => [
        ...(Array.isArray(previous) ? previous : []),
        ...safeEntries.map((entry) => ({
          type: (entry?.type ?? 'console') as DesktopPreviewOutput['type'],
          message: typeof entry?.message === 'string' ? entry.message : String(entry?.message ?? ''),
          workspaceId: nativeWorkspaceId ?? '',
          previewRunId
        }))
      ].slice(-200));
    },
    [nativeWorkspaceId]
  );
  const handleTogglePreviewFullscreen = useCallback(
    () => setIsPreviewFullscreen((fullscreen) => !fullscreen),
    [setIsPreviewFullscreen]
  );
  const handleClosePreview = useCallback(() => {
    setIsPreviewFullscreen(false);
    setIsPreviewOpen(false);
  }, [setIsPreviewFullscreen, setIsPreviewOpen]);

  return {
    runtimeError,
    setRuntimeError,
    bundleState,
    localRuntime,
    localRuntimeLogs,
    previewProjects,
    previewAutoReload,
    localPreviewAvailable,
    previewDiagnostics,
    previewSync,
    previewDocument,
    previewCapability,
    startLocalPreview,
    stopLocalPreview,
    togglePreviewAutoReload,
    handleChoosePreviewProject,
    handleCancelProjectSelection,
    handleStartLocalPreview,
    handleStopLocalPreview,
    handleClearLocalPreviewLogs,
    handleDismissPreviewError,
    handleBrowserConsoleLog,
    handleTogglePreviewFullscreen,
    handleClosePreview
  };
}
