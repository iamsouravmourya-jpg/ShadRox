import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  SkipForward,
  Square,
  X
} from 'lucide-react';
import type { DebugStackFrame, DebugVariable, ShadRoxDesktopAPI } from '../lib/desktop';
import type { DebugController } from '../hooks/useDebug';

interface DebugPanelProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  controller: DebugController;
  /** Opens a stopped frame through the app's one navigation path. */
  onOpenFrame: (file: string, line?: number, column?: number) => void;
  onClose: () => void;
}

/** The one-line example the empty state shows, kept verbatim and minimal. */
export const DEBUG_CONFIG_EXAMPLE =
  '{"configurations":[{"name":"Launch app","type":"node","request":"launch","program":"src/index.js","adapterCommand":"js-debug-adapter"}]}';

const STATUS_LABEL: Record<string, string> = {
  idle: 'not started',
  starting: 'starting…',
  running: 'running',
  stopped: 'paused',
  terminated: 'terminated',
  error: 'error'
};

function shortPath(file: string | null): string {
  return file ?? '(external)';
}

/**
 * One lazily expanded node of the variables tree: a scope, or a structured
 * variable. Children are requested on first expand and cached for the frame,
 * so re-expanding never re-hits the adapter.
 */
function VariablesBranch({
  reference,
  label,
  detail,
  depth,
  load
}: {
  reference: number;
  label: string;
  detail?: string | null;
  depth: number;
  load: (reference: number) => Promise<DebugVariable[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DebugVariable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (items || loading) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await load(reference));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={expanded}
        className="flex w-full items-start gap-1 rounded px-1 py-0.5 text-left font-mono text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.05] hover:text-white cursor-pointer"
        style={{ paddingLeft: `${6 + depth * 12}px` }}
      >
        {expanded ? (
          <ChevronDown className="mt-[2px] h-3 w-3 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="mt-[2px] h-3 w-3 shrink-0 text-neutral-500" />
        )}
        <span className="shrink-0 text-sky-200">{label}</span>
        {detail ? <span className="min-w-0 truncate text-neutral-400">= {detail}</span> : null}
        {loading && <Loader2 className="mt-[2px] h-3 w-3 shrink-0 animate-spin text-neutral-500" />}
      </button>
      {expanded && error && (
        <p className="px-2 py-0.5 text-[10px] text-rose-400" style={{ paddingLeft: `${18 + depth * 12}px` }}>
          {error}
        </p>
      )}
      {expanded && items && items.length === 0 && (
        <p className="py-0.5 text-[10px] italic text-neutral-600" style={{ paddingLeft: `${18 + depth * 12}px` }}>
          no variables
        </p>
      )}
      {expanded &&
        items?.map((variable) =>
          variable.variablesReference > 0 ? (
            <VariablesBranch
              key={`${variable.name}-${variable.variablesReference}`}
              reference={variable.variablesReference}
              label={variable.name}
              detail={variable.value}
              depth={depth + 1}
              load={load}
            />
          ) : (
            <div
              key={`${variable.name}-${variable.variablesReference}`}
              className="flex items-start gap-1 py-0.5 pr-2 font-mono text-[11px]"
              style={{ paddingLeft: `${18 + depth * 12}px` }}
            >
              <span className="shrink-0 text-neutral-300">{variable.name}</span>
              <span className="text-neutral-600">=</span>
              <span className="min-w-0 break-all text-neutral-200">{variable.value}</span>
              {variable.type ? <span className="shrink-0 text-[10px] text-neutral-600">{variable.type}</span> : null}
            </div>
          )
        )}
    </div>
  );
}

/**
 * The debugger dock. It owns no session state: everything comes from the
 * `useDebug` controller, and every action is the same main-process call the
 * command palette and editor chip use. When no configuration exists the panel
 * says exactly how to add one instead of offering a dead Start button.
 */
export function DebugPanel({ desktop, workspaceId, controller, onOpenFrame, onClose }: DebugPanelProps) {
  const {
    available,
    config,
    state,
    frames,
    selectedFrame,
    scopes,
    busy,
    error,
    output,
    start,
    stop,
    continueExecution,
    next,
    stepIn,
    stepOut,
    pause,
    selectFrame,
    clearError
  } = controller;
  const [selectedConfig, setSelectedConfig] = useState('');

  useEffect(() => {
    const first = config.configurations[0]?.name ?? '';
    setSelectedConfig((current) =>
      config.configurations.some((entry) => entry.name === current) ? current : first
    );
  }, [config.configurations]);

  const loadVariables = useCallback(
    async (reference: number): Promise<DebugVariable[]> => {
      const debug = desktop.debug;
      if (!debug) throw new Error('The debugger is unavailable in this build.');
      return debug.variables(workspaceId, reference);
    },
    [desktop, workspaceId]
  );

  const hasConfig = config.configurations.length > 0;
  const isStopped = state.status === 'stopped';
  const isRunning = state.status === 'running' || state.status === 'starting';
  const inSession = isStopped || isRunning;
  const pausedFrame = selectedFrame;
  const openFrame = (frame: DebugStackFrame) => {
    if (!frame.file) return;
    onOpenFrame(frame.file, frame.line ?? 1, frame.column ?? 1);
  };

  const example = useMemo(() => DEBUG_CONFIG_EXAMPLE, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-950">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.07] bg-ink-950 px-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state.status === 'stopped'
                ? 'bg-rose-400'
                : state.status === 'running'
                  ? 'bg-emerald-400'
                  : 'bg-neutral-600'
            }`}
          />
          Debug
        </span>
        <span className="truncate font-mono text-[10px] text-neutral-500">
          {STATUS_LABEL[state.status] ?? state.status}
          {state.configName ? ` · ${state.configName}` : ''}
          {isStopped && state.stopReason ? ` · ${state.stopReason}` : ''}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {config.configurations.length > 1 && (
            <select
              value={selectedConfig}
              onChange={(event) => setSelectedConfig(event.target.value)}
              disabled={inSession || busy}
              aria-label="Debug configuration"
              className="max-w-[160px] rounded-md border border-white/[0.09] bg-ink-950 px-1.5 py-0.5 text-[10px] text-neutral-300 outline-none disabled:opacity-50 cursor-pointer"
            >
              {config.configurations.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
          {!inSession ? (
            <button
              type="button"
              onClick={() => void start(selectedConfig || undefined)}
              disabled={!available || !hasConfig || busy || Boolean(config.error)}
              title={hasConfig ? 'Start debugging' : 'Add shadrox.debug.json first'}
              aria-label="Start debugging"
              className="flex items-center gap-1 rounded-md border border-white/[0.09] px-2 py-0.5 text-[10px] text-emerald-200 transition-colors hover:border-emerald-300/40 hover:bg-emerald-500/10 disabled:opacity-40 cursor-pointer"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Start
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={busy}
              title="Stop debugging"
              aria-label="Stop debugging"
              className="flex items-center gap-1 rounded-md border border-white/[0.09] px-2 py-0.5 text-[10px] text-rose-200 transition-colors hover:border-rose-300/40 hover:bg-rose-500/10 disabled:opacity-40 cursor-pointer"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => void continueExecution()}
            disabled={!isStopped}
            title="Continue (resume)"
            aria-label="Continue"
            className="rounded-md border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white disabled:opacity-30 cursor-pointer"
          >
            <SkipForward className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void next()}
            disabled={!isStopped}
            title="Step over"
            aria-label="Step over"
            className="rounded-md border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white disabled:opacity-30 cursor-pointer"
          >
            <ArrowRight className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void stepIn()}
            disabled={!isStopped}
            title="Step into"
            aria-label="Step into"
            className="rounded-md border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white disabled:opacity-30 cursor-pointer"
          >
            <ArrowDown className="h-3 w-3 rotate-[-45deg]" />
          </button>
          <button
            type="button"
            onClick={() => void stepOut()}
            disabled={!isStopped}
            title="Step out"
            aria-label="Step out"
            className="rounded-md border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white disabled:opacity-30 cursor-pointer"
          >
            <ArrowUp className="h-3 w-3 rotate-[-45deg]" />
          </button>
          <button
            type="button"
            onClick={() => void pause()}
            disabled={!isRunning}
            title="Pause"
            aria-label="Pause"
            className="rounded-md border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white disabled:opacity-30 cursor-pointer"
          >
            <Pause className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close debug panel"
            aria-label="Close debug panel"
            className="p-1 text-neutral-500 transition-colors hover:text-white cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-rose-900/40 bg-rose-950/30 px-2 py-1 text-[10.5px] text-rose-200">
          <AlertCircle className="mt-[1px] h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss debug error"
            className="shrink-0 text-rose-300/70 transition-colors hover:text-white cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {!available ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-neutral-500">
          The debugger needs the desktop app; this build has no main-process host.
        </div>
      ) : !config.found ? (
        <div className="flex-1 overflow-auto px-3 py-2.5">
          <p className="text-[11px] text-neutral-300">
            No debug configuration. Add <span className="font-mono text-violet-200">shadrox.debug.json</span> at the
            workspace root:
          </p>
          <pre className="mt-1.5 select-all overflow-x-auto rounded-lg border border-white/[0.08] bg-ink-900/70 px-2.5 py-2 font-mono text-[10.5px] leading-5 text-neutral-300">
            {example}
          </pre>
          <p className="mt-1.5 text-[10px] text-neutral-500">
            Needs <span className="font-mono">@vscode/js-debug</span> installed in the workspace. Breakpoints are set
            by clicking the editor gutter once a configuration exists.
          </p>
        </div>
      ) : config.error ? (
        <div className="flex flex-1 items-start gap-2 overflow-auto px-3 py-2.5 text-[11px] text-rose-300">
          <AlertCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{config.error}</span>
        </div>
      ) : !inSession ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-neutral-500">
          <p>
            Ready to launch <span className="font-mono text-neutral-300">{config.configurations[0]?.program}</span>.
          </p>
          <p className="text-[10px] text-neutral-600">
            {Object.values(controller.breakpoints).reduce((total, lines) => total + lines.length, 0)} breakpoint(s) set.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 w-[46%] min-w-[180px] shrink-0 flex-col border-r border-white/[0.07]">
            <div className="shrink-0 px-2 py-1 text-[9.5px] uppercase tracking-wider text-neutral-500">
              Call stack
            </div>
            <div className="min-h-0 flex-1 overflow-auto pb-1">
              {frames.length === 0 ? (
                <p className="px-2 py-1 text-[10px] italic text-neutral-600">
                  {isStopped ? 'No frames reported.' : 'Run until a breakpoint is hit.'}
                </p>
              ) : (
                frames.map((frame) => {
                  const isSelected = pausedFrame?.id === frame.id;
                  return (
                    <button
                      key={frame.id}
                      type="button"
                      onClick={() => {
                        void selectFrame(frame);
                        openFrame(frame);
                      }}
                      title={
                        frame.file
                          ? `${frame.file}:${frame.line ?? 1}:${frame.column ?? 1}`
                          : `${frame.name} (source outside the workspace)`
                      }
                      className={`flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left transition-colors cursor-pointer ${
                        isSelected ? 'bg-violet-500/[.14] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{frame.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                        {shortPath(frame.file)}
                        {frame.line ? `:${frame.line}` : ''}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2 py-1 text-[9.5px] uppercase tracking-wider text-neutral-500">Variables</div>
            <div className="min-h-0 flex-1 overflow-auto pb-1">
              {!isStopped || scopes.length === 0 ? (
                <p className="px-2 py-1 text-[10px] italic text-neutral-600">
                  {isStopped ? 'No scopes for this frame.' : 'Pause execution to inspect locals.'}
                </p>
              ) : (
                scopes.map((scope) => (
                  <VariablesBranch
                    key={`${scope.name}-${scope.variablesReference}`}
                    reference={scope.variablesReference}
                    label={scope.name}
                    depth={0}
                    load={loadVariables}
                  />
                ))
              )}
            </div>
            {output.trim() && (
              <>
                <div className="shrink-0 border-t border-white/[0.07] px-2 py-1 text-[9.5px] uppercase tracking-wider text-neutral-500">
                  Program output
                </div>
                <pre className="max-h-24 shrink-0 overflow-auto border-t border-white/[0.04] bg-ink-900/40 px-2 py-1 font-mono text-[10px] leading-4 text-neutral-400">
                  {output}
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
