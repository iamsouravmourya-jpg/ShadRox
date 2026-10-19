import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { X } from 'lucide-react';
import type { ShadRoxDesktopAPI, TerminalOutput } from '../lib/desktop';

interface TerminalPanelProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}

export function TerminalPanel({ desktop, workspaceId, workspaceName, onClose }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Starting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
        cursor: '#34d399',
        selectionBackground: '#065f46'
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    const applyOutput = (output: TerminalOutput) => {
      if (output.type === 'data' && output.data) terminal.write(output.data);
      if (output.type === 'exit') {
        terminal.write(`\r\n\x1b[90m[process exited with code ${output.exitCode ?? 'unknown'}]\x1b[0m\r\n`);
        setStatus('Exited');
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

    void desktop.createTerminal(workspaceId, terminal.cols, terminal.rows).then((created) => {
      if (disposed) {
        void desktop.closeTerminal(workspaceId, created.sessionId);
        return;
      }
      sessionId = created.sessionId;
      setStatus('Connected');
      terminal.write(`\x1b[32mShadRox terminal\x1b[0m · ${created.title}\r\n`);
      for (const output of pendingOutput.get(sessionId) ?? []) applyOutput(output);
      pendingOutput.clear();
      fitAndResize();
      terminal.focus();
    }).catch((error) => {
      if (disposed) return;
      setStatus('Unavailable');
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
      pendingOutput.clear();
    };
  }, [desktop, workspaceId]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#050505]" aria-label="Interactive terminal">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-neutral-900 bg-neutral-950 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-neutral-400">
          <span className={`h-1.5 w-1.5 rounded-full ${status === 'Connected' ? 'bg-emerald-400' : status === 'Starting' ? 'bg-amber-400' : 'bg-neutral-600'}`} />
          <span>Terminal</span>
          <span className="truncate normal-case tracking-normal text-neutral-600">{workspaceName}</span>
          <span className="text-neutral-600">{status}</span>
        </div>
        <button type="button" onClick={onClose} className="p-1 text-neutral-500 hover:text-white" title="Close terminal" aria-label="Close terminal">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </section>
  );
}
