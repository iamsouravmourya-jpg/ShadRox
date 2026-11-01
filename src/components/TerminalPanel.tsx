import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ShieldCheck, TerminalSquare, X, Eraser, RotateCcw } from 'lucide-react';
import type { ShadRoxDesktopAPI, TerminalMode, TerminalOutput } from '../lib/desktop';

const MODES: { id: TerminalMode; name: string; blurb: string }[] = [
  {
    id: 'system',
    name: 'System',
    blurb: 'Your own shell with your full environment. Use it to install Node, git or a package manager.'
  },
  {
    id: 'agent',
    name: 'AI',
    blurb: "The environment the assistant's commands run in. Stored API keys and tokens are stripped from it."
  }
];

interface TerminalPanelProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}

interface TerminalSurfaceProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  mode: TerminalMode;
  active: boolean;
  sessionKey: number;
  onStatus: (mode: TerminalMode, status: string) => void;
  onTerminal: (mode: TerminalMode, terminal: XTerm | null) => void;
}

function TerminalSurface({ desktop, workspaceId, mode, active, sessionKey, onStatus, onTerminal }: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);

  // The effect deliberately ignores `active`: switching tabs must not tear down
  // the shell, or a running install would die when the user glances at the other
  // tab. A hidden host measures zero, so xterm simply re-fits when it reappears.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    onStatus(mode, 'Starting');

    let disposed = false;
    let sessionId: string | null = null;
    let resizeFrame = 0;
    const pendingOutput = new Map<string, TerminalOutput[]>();
    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: {
        background: '#050505',
        foreground: '#d4d4d4',
        cursor: mode === 'agent' ? '#38bdf8' : '#34d399',
        selectionBackground: mode === 'agent' ? '#0c4a6e' : '#065f46'
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    onTerminal(mode, terminal);

    const applyOutput = (output: TerminalOutput) => {
      if (output.type === 'data' && output.data) terminal.write(output.data);
      if (output.type === 'exit') {
        terminal.write(`\r\n\x1b[90m[process exited with code ${output.exitCode ?? 'unknown'}]\x1b[0m\r\n`);
        onStatus(mode, 'Exited');
      }
    };
    const unsubscribe = desktop.onTerminalOutput((output) => {
      if (disposed || output.workspaceId !== workspaceId) return;
      if (!sessionId) {
        const waiting = pendingOutput.get(output.sessionId) ?? [];
        waiting.push(output);
        pendingOutput.set(output.sessionId, waiting);
        return;
      }
      if (output.sessionId === sessionId) applyOutput(output);
    });
    const input = terminal.onData((data) => {
      if (sessionId && !disposed) void desktop.writeTerminal(workspaceId, sessionId, data).catch((error) => {
        terminal.write(`\r\n\x1b[31m[terminal input failed: ${error instanceof Error ? error.message : String(error)}]\x1b[0m\r\n`);
      });
    });
    const fitAndResize = () => {
      if (disposed || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        if (sessionId) void desktop.resizeTerminal(workspaceId, sessionId, terminal.cols, terminal.rows).catch(() => {});
      } catch {
        // xterm can briefly measure zero while its dock is opening or resizing.
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitAndResize);
    });
    observer.observe(host);

    void desktop.createTerminal(workspaceId, terminal.cols, terminal.rows, mode).then((created) => {
      if (disposed) {
        void desktop.closeTerminal(workspaceId, created.sessionId);
        return;
      }
      sessionId = created.sessionId;
      onStatus(mode, 'Connected');
      terminal.write(`\x1b[32m${created.label}\x1b[0m · ${created.title}\r\n`);
      if (created.mode === 'agent') {
        terminal.write('\x1b[90mAPI keys and tokens are stripped from this shell.\x1b[0m\r\n');
      }
      for (const output of pendingOutput.get(sessionId) ?? []) applyOutput(output);
      pendingOutput.clear();
      fitAndResize();
    }).catch((error) => {
      if (disposed) return;
      onStatus(mode, 'Unavailable');
      terminal.write(`\x1b[31mCould not start terminal: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      if (sessionId) void desktop.closeTerminal(workspaceId, sessionId).catch(() => {});
      terminal.dispose();
      terminalRef.current = null;
      onTerminal(mode, null);
      pendingOutput.clear();
    };
  }, [desktop, workspaceId, mode, sessionKey, onStatus, onTerminal]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  return <div ref={hostRef} className={active ? 'min-h-0 flex-1 px-2 py-1' : 'hidden'} />;
}

export function TerminalPanel({ desktop, workspaceId, workspaceName, onClose }: TerminalPanelProps) {
  const [mode, setMode] = useState<TerminalMode>('system');
  const [statuses, setStatuses] = useState<Record<TerminalMode, string>>({ system: 'Starting', agent: 'Starting' });
  const [sessionKeys, setSessionKeys] = useState<Record<TerminalMode, number>>({ system: 0, agent: 0 });

  const onStatus = useCallback((changed: TerminalMode, status: string) => {
    setStatuses((current) => (current[changed] === status ? current : { ...current, [changed]: status }));
  }, []);
  const surfaces = useRef<Partial<Record<TerminalMode, XTerm>>>({});
  const onTerminal = useCallback((changed: TerminalMode, terminal: XTerm | null) => {
    if (terminal) surfaces.current[changed] = terminal;
    else delete surfaces.current[changed];
  }, []);

  const status = statuses[mode];
  const activeBlurb = MODES.find((candidate) => candidate.id === mode)?.blurb ?? '';

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#07080b]" aria-label="Interactive terminal">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] bg-ink-950 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center rounded border border-white/[0.07] bg-white/[0.03] p-0.5" role="tablist" aria-label="Terminal mode">
            {MODES.map((candidate) => {
              const isActive = candidate.id === mode;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setMode(candidate.id)}
                  title={candidate.blurb}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${
                    isActive
                      ? candidate.id === 'agent'
                        ? 'bg-sky-400/15 text-sky-300'
                        : 'bg-emerald-400/15 text-emerald-300'
                      : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  {candidate.id === 'agent' ? <ShieldCheck className="h-3 w-3" /> : <TerminalSquare className="h-3 w-3" />}
                  {candidate.name}
                </button>
              );
            })}
          </div>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === 'Connected' ? 'bg-violet-400' : status === 'Starting' ? 'bg-amber-400' : 'bg-neutral-600'}`} />
          <span className="truncate text-[10px] font-mono normal-case text-neutral-600" title={activeBlurb}>{workspaceName}</span>
          <span className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-neutral-500">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              surfaces.current[mode]?.clear();
              surfaces.current[mode]?.focus();
            }}
            className="flex items-center gap-1 rounded p-1 text-[10px] text-neutral-500 hover:text-white"
            title="Clear terminal scrollback"
            aria-label="Clear terminal"
          >
            <Eraser className="h-3 w-3" />
            Clear
          </button>
          <button
            type="button"
            onClick={() => setSessionKeys((keys) => ({ ...keys, [mode]: keys[mode] + 1 }))}
            className="flex items-center gap-1 rounded p-1 text-[10px] text-neutral-500 hover:text-white"
            title={`Restart the ${mode === 'agent' ? 'AI' : 'system'} terminal session`}
            aria-label="Restart terminal"
          >
            <RotateCcw className="h-3 w-3" />
            Restart
          </button>
          <button type="button" onClick={onClose} className="p-1 text-neutral-500 hover:text-white" title="Close terminal" aria-label="Close terminal">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {MODES.map((candidate) => (
          <TerminalSurface
            key={candidate.id}
            desktop={desktop}
            workspaceId={workspaceId}
            mode={candidate.id}
            active={mode === candidate.id}
            sessionKey={sessionKeys[candidate.id]}
            onStatus={onStatus}
            onTerminal={onTerminal}
          />
        ))}
      </div>
    </section>
  );
}
