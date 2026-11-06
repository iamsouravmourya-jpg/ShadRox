import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DebugConfigResult,
  DebugScope,
  DebugStackFrame,
  DebugState,
  DebugThread,
  DebugVariable,
  ShadRoxDesktopAPI
} from '../lib/desktop';
import { attachRuntimeToOpenReceipt, captureDebugRuntime } from '../lib/debug/runtimeCapture';

const MAX_OUTPUT_CHARS = 16_000;

const IDLE_STATE: DebugState = {
  status: 'idle',
  workspaceId: null,
  configName: null,
  threadId: null,
  frameId: null,
  stopReason: null,
  exception: false,
  message: null,
  output: ''
};

const EMPTY_CONFIG: DebugConfigResult = {
  found: false,
  path: '',
  configurations: [],
  error: null
};

export interface DebugController {
  /** False in a browser build or when the main-process host is absent. */
  available: boolean;
  config: DebugConfigResult;
  state: DebugState;
  threads: DebugThread[];
  frames: DebugStackFrame[];
  selectedFrame: DebugStackFrame | null;
  scopes: DebugScope[];
  /** True while a start request is in flight. */
  busy: boolean;
  error: string | null;
  /** Recent debuggee output, clipped by the main process. */
  output: string;
  /** Workspace-relative file path -> breakpoint lines. */
  breakpoints: Record<string, number[]>;
  start: (configName?: string) => Promise<void>;
  stop: () => Promise<void>;
  continueExecution: () => Promise<void>;
  next: () => Promise<void>;
  stepIn: () => Promise<void>;
  stepOut: () => Promise<void>;
  pause: () => Promise<void>;
  selectFrame: (frame: DebugStackFrame) => Promise<void>;
  /** Hover value for one identifier in the selected frame; null when unsure. */
  evaluate: (frameId: number, expression: string) => Promise<string | null>;
  toggleBreakpoint: (path: string, line: number) => Promise<void>;
  clearError: () => void;
}

/**
 * Owns the renderer half of a debug session: configuration, stopped context,
 * breakpoints and the receipt-runtime siphon. The adapter process itself lives
 * in the main process; this hook only holds bounded snapshots.
 */
export function useDebug(
  desktop: ShadRoxDesktopAPI | null,
  workspaceId: string | null
): DebugController {
  const api = desktop?.debug ?? null;
  const [config, setConfig] = useState<DebugConfigResult>(EMPTY_CONFIG);
  const [state, setState] = useState<DebugState>(IDLE_STATE);
  const [threads, setThreads] = useState<DebugThread[]>([]);
  const [frames, setFrames] = useState<DebugStackFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<DebugScope[]>([]);
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState('');

  const apiRef = useRef(api);
  apiRef.current = api;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const clearStoppedContext = useCallback(() => {
    setFrames([]);
    setSelectedFrameId(null);
    setScopes([]);
    setThreads([]);
  }, []);

  const loadStoppedContext = useCallback(
    async (targetWorkspaceId: string, threadId: number | null, exception: boolean) => {
      const debug = apiRef.current;
      if (!debug) return;
      try {
        const [nextThreads, nextFrames] = await Promise.all([
          debug.threads(targetWorkspaceId),
          debug.stack(targetWorkspaceId)
        ]);
        if (workspaceRef.current !== targetWorkspaceId) return;
        setThreads(nextThreads);
        setFrames(nextFrames);
        const top = nextFrames[0] ?? null;
        setSelectedFrameId(top?.id ?? null);
        if (top) {
          const nextScopes = await debug.scopes(targetWorkspaceId, top.id);
          if (workspaceRef.current === targetWorkspaceId) setScopes(nextScopes);
        } else {
          setScopes([]);
        }
        if (exception) {
          // The failure receipt, when one is open, gets the exact stopped
          // frame and locals. Fire-and-forget: the UI must not wait on it.
          void captureDebugRuntime(debug, targetWorkspaceId).then((runtime) => {
            attachRuntimeToOpenReceipt(runtime);
          });
        }
      } catch (cause) {
        if (workspaceRef.current === targetWorkspaceId) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    },
    []
  );

  // Reload config/state and subscribe to the host's lifecycle events.
  useEffect(() => {
    setBreakpoints({});
    setError(null);
    setOutput('');
    clearStoppedContext();
    if (!api || !workspaceId) {
      setConfig(EMPTY_CONFIG);
      setState(IDLE_STATE);
      return;
    }

    let cancelled = false;
    void api
      .config(workspaceId)
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    void api
      .state(workspaceId)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setOutput(next.output);
        if (next.status === 'stopped') {
          void loadStoppedContext(workspaceId, next.threadId, next.exception);
        }
      })
      .catch(() => {
        // A missing host degrades to the idle state; the panel says so.
      });

    const unsubscribe = api.onEvent((event) => {
      if (event.workspaceId !== workspaceId) return;
      switch (event.type) {
        case 'state': {
          setState(event.state);
          setOutput(event.state.output);
          if (event.state.status !== 'stopped') clearStoppedContext();
          break;
        }
        case 'stopped': {
          setState((current) => ({
            ...current,
            status: 'stopped',
            workspaceId,
            threadId: event.threadId,
            stopReason: event.reason,
            exception: event.exception,
            message: event.exception ? 'Paused on an exception.' : null
          }));
          void loadStoppedContext(workspaceId, event.threadId, event.exception);
          break;
        }
        case 'continued': {
          setState((current) => ({
            ...current,
            status: 'running',
            threadId: event.threadId ?? current.threadId,
            stopReason: null,
            exception: false,
            message: null
          }));
          clearStoppedContext();
          break;
        }
        case 'terminated': {
          setState((current) => ({
            ...current,
            status: 'terminated',
            threadId: null,
            frameId: null,
            stopReason: null,
            exception: false,
            message: event.message ?? null
          }));
          clearStoppedContext();
          break;
        }
        case 'output': {
          setOutput((current) => {
            const next = `${current}${event.text}`;
            return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(next.length - MAX_OUTPUT_CHARS);
          });
          break;
        }
        case 'error': {
          setError(event.message);
          break;
        }
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, workspaceId, clearStoppedContext, loadStoppedContext]);

  const reapplyBreakpoints = useCallback(async () => {
    const debug = apiRef.current;
    const target = workspaceRef.current;
    if (!debug || !target) return;
    for (const [file, lines] of Object.entries(breakpoints)) {
      try {
        await debug.setBreakpoints(target, file, lines);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [breakpoints]);

  const start = useCallback(
    async (configName?: string) => {
      const debug = apiRef.current;
      const target = workspaceRef.current;
      if (!debug || !target) {
        setError('The debugger is unavailable in this build.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const next = await debug.start(target, configName);
        setState(next);
        await reapplyBreakpoints();
        if (next.status === 'stopped') {
          await loadStoppedContext(target, next.threadId, next.exception);
        } else {
          clearStoppedContext();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [clearStoppedContext, loadStoppedContext, reapplyBreakpoints]
  );

  const stop = useCallback(async () => {
    const debug = apiRef.current;
    const target = workspaceRef.current;
    if (!debug || !target) return;
    setBusy(true);
    try {
      await debug.stop(target);
      setState((current) => ({ ...IDLE_STATE, workspaceId: target, output: current.output }));
      clearStoppedContext();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [clearStoppedContext]);

  const resume = useCallback(
    async (command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => {
      const debug = apiRef.current;
      const target = workspaceRef.current;
      if (!debug || !target) return;
      try {
        const next = await debug[command](target, state.threadId ?? undefined);
        setState(next);
        if (next.status === 'stopped') {
          await loadStoppedContext(target, next.threadId, next.exception);
        } else {
          clearStoppedContext();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [clearStoppedContext, loadStoppedContext, state.threadId]
  );

  const selectFrame = useCallback(async (frame: DebugStackFrame) => {
    const debug = apiRef.current;
    const target = workspaceRef.current;
    if (!debug || !target) return;
    setSelectedFrameId(frame.id);
    try {
      setScopes(await debug.scopes(target, frame.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const evaluate = useCallback(async (frameId: number, expression: string): Promise<string | null> => {
    const debug = apiRef.current;
    const target = workspaceRef.current;
    if (!debug || !target) return null;
    try {
      const value = await debug.evaluate(target, frameId, expression);
      return value.result || null;
    } catch {
      // A hover is best-effort: an adapter that cannot evaluate shows nothing.
      return null;
    }
  }, []);

  const toggleBreakpoint = useCallback(
    async (path: string, line: number) => {
      const debug = apiRef.current;
      const target = workspaceRef.current;
      if (!target) return;
      const current = breakpoints[path] ?? [];
      const next = current.includes(line)
        ? current.filter((entry) => entry !== line)
        : [...current, line].sort((a, b) => a - b);
      const nextMap = { ...breakpoints };
      if (next.length === 0) delete nextMap[path];
      else nextMap[path] = next;
      setBreakpoints(nextMap);
      if (!debug) return;
      try {
        await debug.setBreakpoints(target, path, next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [breakpoints]
  );

  const selectedFrame = useMemo(
    () => frames.find((frame) => frame.id === selectedFrameId) ?? frames[0] ?? null,
    [frames, selectedFrameId]
  );

  return {
    available: Boolean(api),
    config,
    state,
    threads,
    frames,
    selectedFrame,
    scopes,
    busy,
    error,
    output,
    breakpoints,
    start,
    stop,
    continueExecution: () => resume('continue'),
    next: () => resume('next'),
    stepIn: () => resume('stepIn'),
    stepOut: () => resume('stepOut'),
    pause: () => resume('pause'),
    selectFrame,
    evaluate,
    toggleBreakpoint,
    clearError: () => setError(null)
  };
}

export type { DebugVariable };
