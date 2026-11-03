import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, ChevronUp, Columns, Eraser, Plus, RotateCcw, Rows, Search, X } from 'lucide-react';
import type { ShadRoxDesktopAPI, TerminalOutput } from '../lib/desktop';
import {
  MAX_TERMINAL_SESSIONS,
  activeTerminalSession,
  createTerminalSessions,
  recallWorkspaceSessions,
  rememberWorkspaceSessions,
  terminalSessionsReducer
} from '../lib/terminal/sessions';
import type { PaneLayout, PaneNode } from '../lib/terminal/panes';
import {
  createInitialLayout,
  nearestKey,
  paneCount,
  paneSessionKeys,
  removePane,
  setRatioDeep,
  splitPane
} from '../lib/terminal/panes';
import type { TerminalSession, TerminalSessionStatus } from '../lib/terminal/sessions';
import {
  appendTerminalTranscript,
  dropTerminalTranscript,
  takeTerminalTranscript,
  terminalTranscriptKey
} from '../lib/terminal/ringBuffer';
import {
  TERMINAL_MIN_HEIGHT,
  clampTerminalHeight,
  readTerminalHeight,
  terminalHeightFromDrag,
  terminalHeightFromKey,
  writeTerminalHeight
} from '../lib/terminal/dockHeight';
import { formatTerminalDockEvent, isSafeCommandLine, subscribeTerminalDockEvents } from '../lib/terminal/echoChannel';
import type { TerminalDockEvent } from '../lib/terminal/echoChannel';

interface TerminalSurfaceHandle {
  terminal: XTerm;
  search: SearchAddon;
  /** Prints text in the transcript without touching the shell. */
  echo(text: string): void;
  /** Types a command into the shell and runs it. */
  run(command: string): void;
  restart(): void;
  kill(): void;
  focus(): void;
  copySelection(): void;
  pasteClipboard(): void;
}

interface PanelKeyHandlers {
  cycle(delta: number): void;
  openFind(): void;
}

interface TerminalSurfaceProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  session: TerminalSession;
  active: boolean;
  onStatus(sessionKey: string, status: TerminalSessionStatus): void;
  onRegister(sessionKey: string, handle: TerminalSurfaceHandle | null): void;
  keyHandlers: React.RefObject<PanelKeyHandlers>;
}

function TerminalSurface({
  desktop,
  workspaceId,
  session,
  active,
  onStatus,
  onRegister,
  keyHandlers
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const transcriptKey = terminalTranscriptKey(workspaceId, session.key);
    let disposed = false;
    let ptySessionId: string | null = null;
    let resizeFrame = 0;
    let spawnSequence = 0;
    const pendingOutput: TerminalOutput[] = [];

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
    const search = new SearchAddon({ highlightLimit: 500 });
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      if (!desktop.openTerminalLink) return;
      void desktop.openTerminalLink(uri).catch(() => {
        terminal.write(`\r\n\x1b[31m[ShadRox refused to open that link]\x1b[0m\r\n`);
      });
    }));
    terminal.open(host);

    const restored = takeTerminalTranscript(transcriptKey);
    if (restored) {
      terminal.write(restored);
      terminal.write('\x1b[90m[scrollback restored]\x1b[0m\r\n');
    }

    const applyOutput = (output: TerminalOutput) => {
      if (output.type === 'data' && output.data) {
        appendTerminalTranscript(transcriptKey, output.data);
        terminal.write(output.data);
      }
      if (output.type === 'exit') {
        const line = `\r\n\x1b[90m[process exited with code ${output.exitCode ?? 'unknown'}]\x1b[0m\r\n`;
        appendTerminalTranscript(transcriptKey, line);
        terminal.write(line);
        onStatus(session.key, 'exited');
      }
    };

    // main keys its pty map by this tab's own id, so output can be matched early.
    const unsubscribe = desktop.onTerminalOutput((output) => {
      if (disposed || output.workspaceId !== workspaceId || output.sessionId !== session.key) return;
      if (!ptySessionId) {
        pendingOutput.push(output);
        return;
      }
      applyOutput(output);
    });

    const input = terminal.onData((data) => {
      if (!ptySessionId || disposed) return;
      void desktop.writeTerminal(workspaceId, ptySessionId, data).catch((error) => {
        terminal.write(`\r\n\x1b[31m[terminal input failed: ${error instanceof Error ? error.message : String(error)}]\x1b[0m\r\n`);
      });
    });

    const fitAndResize = () => {
      if (disposed || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        if (ptySessionId) void desktop.resizeTerminal(workspaceId, ptySessionId, terminal.cols, terminal.rows).catch(() => {});
      } catch {
        // xterm can briefly measure zero while its dock is opening or resizing.
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitAndResize);
    });
    observer.observe(host);

    const spawn = () => {
      const sequence = ++spawnSequence;
      onStatus(session.key, 'starting');
      void desktop.createTerminal(workspaceId, terminal.cols, terminal.rows, session.mode, session.key).then((created) => {
        if (disposed || sequence !== spawnSequence) {
          void desktop.closeTerminal(workspaceId, created.sessionId).catch(() => {});
          return;
        }
        ptySessionId = created.sessionId;
        onStatus(session.key, 'connected');
        terminal.write(`\x1b[32m${created.label}\x1b[0m · ${created.title}\r\n`);
        const waiting = pendingOutput.splice(0, pendingOutput.length);
        for (const output of waiting) applyOutput(output);
        fitAndResize();
      }).catch((error) => {
        if (disposed || sequence !== spawnSequence) return;
        onStatus(session.key, 'failed');
        terminal.write(`\x1b[31mCould not start terminal: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
      });
    };
    spawn();

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey) return true;
      if (event.shiftKey && event.code === 'KeyC') {
        handle.copySelection();
        return false;
      }
      if (event.shiftKey && event.code === 'KeyV') {
        handle.pasteClipboard();
        return false;
      }
      if (event.code === 'Tab') {
        keyHandlers.current?.cycle(event.shiftKey ? -1 : 1);
        return false;
      }
      if (event.code === 'KeyF') {
        keyHandlers.current?.openFind();
        return false;
      }
      return true;
    });

    // Right-click pastes; when text is selected it copies instead, so the gesture
    // never silently replaces a selection the user was about to copy.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) handle.copySelection();
      else handle.pasteClipboard();
    };
    host.addEventListener('contextmenu', onContextMenu);

    const copySelection = () => {
      const text = terminal.getSelection();
      if (!text) return;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
      }
      fallbackCopy(text);
    };

    const pasteClipboard = () => {
      if (!navigator.clipboard?.readText) return;
      void navigator.clipboard.readText().then((text) => {
        if (text) terminal.paste(text);
      }).catch(() => {
        terminal.write('\r\n\x1b[31m[clipboard is unavailable]\x1b[0m\r\n');
      });
    };

    const restart = () => {
      const previous = ptySessionId;
      ptySessionId = null;
      spawnSequence += 1;
      terminal.reset();
      dropTerminalTranscript(transcriptKey);
      // Reset first, then respawn: create is idempotent per tab key, so the old
      // shell has to be gone before the same key can mean a new one.
      void (previous ? desktop.closeTerminal(workspaceId, previous) : Promise.resolve())
        .catch(() => {})
        .then(() => {
          if (!disposed) spawn();
        });
    };

    const kill = () => {
      const previous = ptySessionId;
      ptySessionId = null;
      spawnSequence += 1;
      dropTerminalTranscript(transcriptKey);
      if (previous) void desktop.closeTerminal(workspaceId, previous).catch(() => {});
    };

    const handle: TerminalSurfaceHandle = {
      terminal,
      search,
      echo(text) {
        appendTerminalTranscript(transcriptKey, text);
        terminal.write(text);
      },
      run(command) {
        if (!ptySessionId) return;
        void desktop.writeTerminal(workspaceId, ptySessionId, `${command}\r`).catch(() => {});
      },
      restart,
      kill,
      focus() {
        if (activeRef.current) terminal.focus();
      },
      copySelection,
      pasteClipboard
    };
    onRegister(session.key, handle);
    if (active) terminal.focus();

    return () => {
      disposed = true;
      spawnSequence += 1;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      host.removeEventListener('contextmenu', onContextMenu);
      // The shell itself stays alive while only the dock is hidden, so switching
      // back reattaches to the same session; a closed tab was killed by kill().
      onRegister(session.key, null);
      terminal.dispose();
    };
  }, [desktop, workspaceId, session.key, session.mode, onStatus, onRegister, keyHandlers]);

  useEffect(() => {
    if (active) hostRef.current?.querySelector('textarea')?.focus();
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 px-2 py-1"
      aria-hidden={!active}
      style={{ opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }}
    />
  );
}

function fallbackCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
}

function createTabKey(): string {
  const random = globalThis.crypto;
  if (random?.randomUUID) return random.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const STATUS_TONE: Record<TerminalSessionStatus, string> = {
  starting: 'bg-amber-400',
  connected: 'bg-emerald-400',
  exited: 'bg-neutral-600',
  failed: 'bg-rose-500'
};

const STATUS_LABEL: Record<TerminalSessionStatus, string> = {
  starting: 'Starting',
  connected: 'Connected',
  exited: 'Exited',
  failed: 'Unavailable'
};

interface TerminalPanelProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}

export function TerminalPanel({ desktop, workspaceId, workspaceName, onClose }: TerminalPanelProps) {
  const [sessionsState, dispatch] = useReducerCompat(workspaceId);
  const surfacesRef = useRef(new Map<string, TerminalSurfaceHandle>());
  const [height, setHeight] = useState(() => readTerminalHeight(getStorage(), window.innerHeight));
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [findResult, setFindResult] = useState({ index: -1, count: 0 });
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  // Split pane layout: sits on top of the session list. The first session starts
  // as a single pane; splitting adds a sibling and the tree grows from there.
  const [paneLayout, setPaneLayout] = useState<PaneLayout | null>(null);
  const paneLayoutRef = useRef<PaneLayout | null>(null);
  paneLayoutRef.current = paneLayout;

  // Initialise the pane layout once a first session exists.
  useEffect(() => {
    if (paneLayout || sessionsState.sessions.length === 0) return;
    setPaneLayout(createInitialLayout(sessionsState.sessions[0].key));
  }, [paneLayout, sessionsState.sessions]);

  // When a session is closed, also remove its pane. When the layout empties,
  // reset so the next "new terminal" starts fresh.
  useEffect(() => {
    if (!paneLayout) return;
    const liveKeys = new Set(sessionsState.sessions.map((s) => s.key));
    const paneKeys = new Set(paneSessionKeys(paneLayout.root));
    let changed = false;
    for (const key of paneKeys) {
      if (!liveKeys.has(key)) {
        const next = removePane(paneLayout.root, key);
        if (next === null) {
          setPaneLayout(null);
        } else {
          const fallback = nearestKey(paneLayout.root, key);
          setPaneLayout({ root: next, activeKey: paneLayout.activeKey === key ? fallback : paneLayout.activeKey });
        }
        changed = true;
        break;
      }
    }
    if (!changed && paneLayout.activeKey && !liveKeys.has(paneLayout.activeKey)) {
      const fallback = nearestKey(paneLayout.root, paneLayout.activeKey);
      setPaneLayout({ ...paneLayout, activeKey: fallback });
    }
  }, [sessionsState.sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = activeTerminalSession(sessionsState);
  const activeHandle = active ? surfacesRef.current.get(active.key) ?? null : null;

  const registerSurface = useCallback((sessionKey: string, handle: TerminalSurfaceHandle | null) => {
    if (handle) surfacesRef.current.set(sessionKey, handle);
    else surfacesRef.current.delete(sessionKey);
  }, []);

  const setStatus = useCallback((sessionKey: string, status: TerminalSessionStatus) => {
    dispatch({ type: 'status', key: sessionKey, status });
  }, [dispatch]);

  const keyHandlers = useRef<PanelKeyHandlers>({
    cycle: (delta) => dispatch({ type: 'cycle', delta }),
    openFind: () => {
      setIsFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.focus());
    }
  });

  useEffect(() => {
    rememberWorkspaceSessions(workspaceId, sessionsState.sessions);
  }, [workspaceId, sessionsState.sessions]);

  useEffect(() => {
    if (!isFindOpen) return;
    findInputRef.current?.focus();
  }, [isFindOpen, active?.key]);

  // Ctrl+F from outside the xterm element (the find bar itself, the header).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.code !== 'KeyF') return;
      if (event.target instanceof HTMLElement && event.target.tagName === 'INPUT') return;
      event.preventDefault();
      keyHandlers.current.openFind();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeTerminalDockEvents((event) => routeDockEvent(event, surfacesRef.current, active?.key ?? null));
    return unsubscribe;
  }, [active?.key]);

  const activeSearch = activeHandle?.search;
  useEffect(() => {
    if (!activeSearch) return;
    const subscription = activeSearch.onDidChangeResults((result) => setFindResult({
      index: result.resultIndex,
      count: result.resultCount
    }));
    return () => subscription.dispose();
  }, [activeSearch]);

  useEffect(() => {
    if (!activeHandle) return;
    if (!query) {
      activeHandle.search.clearDecorations();
      setFindResult({ index: -1, count: 0 });
      return;
    }
    activeHandle.search.findNext(query, { incremental: true, ...SEARCH_OPTIONS });
  }, [query, activeHandle]);

  const closeSession = (sessionKey: string) => {
    surfacesRef.current.get(sessionKey)?.kill();
    if (sessionKey === renamingKey) setRenamingKey(null);
    // Remove from the pane layout so the split collapses cleanly.
    const layout = paneLayoutRef.current;
    if (layout) {
      const next = removePane(layout.root, sessionKey);
      if (next === null) setPaneLayout(null);
      else {
        const fallback = nearestKey(layout.root, sessionKey);
        setPaneLayout({ root: next, activeKey: layout.activeKey === sessionKey ? fallback : layout.activeKey });
      }
    }
    dispatch({ type: 'close', key: sessionKey });
  };

  const handleSplit = (orientation: 'horizontal' | 'vertical') => {
    if (!paneLayout || sessionsState.sessions.length >= MAX_TERMINAL_SESSIONS) return;
    const targetKey = paneLayout.activeKey ?? paneSessionKeys(paneLayout.root)[0];
    if (!targetKey) return;
    const newKey = createTabKey();
    dispatch({ type: 'add', key: newKey, mode: 'system' });
    setPaneLayout({
      root: splitPane(paneLayout.root, targetKey, newKey, orientation),
      activeKey: newKey
    });
  };

  const focusPane = (sessionKey: string) => {
    dispatch({ type: 'activate', key: sessionKey });
    setPaneLayout((prev) => prev ? { ...prev, activeKey: sessionKey } : prev);
    surfacesRef.current.get(sessionKey)?.focus();
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: heightRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setHeight(terminalHeightFromDrag(drag.startHeight, event.clientY - drag.startY, window.innerHeight));
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    writeTerminalHeight(getStorage(), heightRef.current);
  };

  const statusKey = active?.status ?? 'failed';

  /**
   * Renders the pane tree. A leaf gets its own flex cell with a focused border;
   * a split divides into two children by the stored ratio. Each leaf mounts its
   * own TerminalSurface, but only the focused pane passes `active={true}` so the
   * xterm instance in the background panes still receives output (they overlap
   * within their own cell, not across the whole dock).
   */
  const renderPaneNode = (node: PaneNode, activeKey: string | null): React.ReactNode => {
    if (node.type === 'leaf') {
      const session = sessionsState.sessions.find((s) => s.key === node.sessionKey);
      if (!session) return null;
      const isActive = node.sessionKey === activeKey;
      return (
        <div
          key={node.sessionKey}
          className={`relative min-w-0 min-h-0 flex-1 ${isActive ? '' : 'opacity-90'} ${paneCount(paneLayout!.root) > 1 ? 'border-r border-white/[0.04] last:border-r-0' : ''}`}
          onMouseDown={() => { if (!isActive) focusPane(node.sessionKey); }}
        >
          <TerminalSurface
            key={session.key}
            desktop={desktop}
            workspaceId={workspaceId}
            session={session}
            active={isActive}
            onStatus={setStatus}
            onRegister={registerSurface}
            keyHandlers={keyHandlers}
          />
          {/* Close-pane button for split views */}
          {paneCount(paneLayout!.root) > 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeSession(node.sessionKey); }}
              className="absolute right-1 top-1 z-10 rounded bg-black/60 p-0.5 text-neutral-500 hover:text-white"
              title="Close this pane"
              aria-label="Close pane"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      );
    }
    // Split node
    const flex = node.orientation === 'horizontal' ? 'flex-row' : 'flex-col';
    const firstSize = `${Math.round(node.ratio * 100)}%`;
    const secondSize = `${Math.round((1 - node.ratio) * 100)}%`;
    return (
      <div key={`split-${node.first.type}-${node.second.type}`} className={`flex min-w-0 min-h-0 flex-1 ${flex}`}>
        <div className="min-w-0 min-h-0" style={{ flexBasis: firstSize, flexGrow: 0, flexShrink: 0 }}>
          {renderPaneNode(node.first, activeKey)}
        </div>
        <div
          className="shrink-0 bg-white/[0.04] hover:bg-emerald-500/30 transition-colors"
          style={node.orientation === 'horizontal' ? { width: 3, cursor: 'col-resize' } : { height: 3, cursor: 'row-resize' }}
          onPointerDown={(e) => {
            e.preventDefault();
            const parent = e.currentTarget.parentElement;
            if (!parent) return;
            const startCoord = node.orientation === 'horizontal' ? e.clientX : e.clientY;
            const startRatio = node.ratio;
            const move = (ev: PointerEvent) => {
              const rect = parent.getBoundingClientRect();
              const total = node.orientation === 'horizontal' ? rect.width : rect.height;
              const delta = (node.orientation === 'horizontal' ? ev.clientX : ev.clientY) - startCoord;
              const next = Math.max(0.1, Math.min(0.9, startRatio + delta / total));
              setPaneLayout((prev) => prev ? { ...prev, root: setRatioDeep(prev.root, node, next) } : prev);
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        />
        <div className="min-w-0 min-h-0" style={{ flexBasis: secondSize, flexGrow: 0, flexShrink: 0 }}>
          {renderPaneNode(node.second, activeKey)}
        </div>
      </div>
    );
  };

  return (
    <section
      className="flex min-h-0 shrink-0 flex-col border-white/[0.07] bg-[#07080b]"
      style={{ height }}
      aria-label="Terminal"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={height}
        aria-valuemin={TERMINAL_MIN_HEIGHT}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setHeight(terminalHeightFromKey(heightRef.current, event.key, window.innerHeight));
          writeTerminalHeight(getStorage(), heightRef.current);
        }}
        className="group h-1.5 shrink-0 cursor-row-resize bg-white/[0.06] hover:bg-emerald-500/40 focus:bg-emerald-500/60 focus:outline-none"
        title="Drag to resize the terminal"
      >
        <div className="flex h-full items-center justify-center opacity-0 group-hover:opacity-100">
          <ChevronUp className="h-2.5 w-2.5 text-emerald-200" />
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.07] bg-ink-950 px-2">
        <div role="tablist" aria-label="Terminal sessions" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessionsState.sessions.map((session) => {
            const isActive = session.key === sessionsState.activeKey;
            return (
              <div
                key={session.key}
                role="tab"
                aria-selected={isActive}
                className={`flex h-6 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-mono ${
                  isActive ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-white/[0.06] bg-white/[0.02] text-neutral-500 hover:text-neutral-300'
                }`}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') dispatch({ type: 'cycle', delta: 1 });
                  if (event.key === 'ArrowLeft') dispatch({ type: 'cycle', delta: -1 });
                  if (event.key === 'Delete' || event.key === 'Backspace') closeSession(session.key);
                  if (event.key === 'F2') setRenamingKey(session.key);
                }}
                onDoubleClick={() => setRenamingKey(session.key)}
                onClick={() => dispatch({ type: 'activate', key: session.key })}
                title={`${session.name} · double-click to rename`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[session.status]}`} />
                {renamingKey === session.key ? (
                  <input
                    autoFocus
                    defaultValue={session.name}
                    maxLength={40}
                    aria-label="Terminal tab name"
                    className="w-24 rounded bg-black/50 px-1 text-[10px] text-white outline outline-emerald-500/40"
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                      dispatch({ type: 'rename', key: session.key, name: event.currentTarget.value });
                      setRenamingKey(null);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setRenamingKey(null);
                    }}
                  />
                ) : (
                  <span className="max-w-[10rem] truncate">{session.name}</span>
                )}
                <button
                  type="button"
                  aria-label={`Close ${session.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeSession(session.key);
                  }}
                  className="shrink-0 rounded p-0.5 text-neutral-600 hover:text-white"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            aria-label="New terminal"
            title={sessionsState.sessions.length >= MAX_TERMINAL_SESSIONS ? 'Terminal tab limit reached' : 'New terminal'}
            disabled={sessionsState.sessions.length >= MAX_TERMINAL_SESSIONS}
            onClick={() => dispatch({ type: 'add', key: createTabKey(), mode: 'system' })}
            className="flex h-6 shrink-0 items-center gap-1 rounded border border-white/[0.06] px-1.5 text-[10px] text-neutral-500 hover:text-white disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden truncate text-[10px] font-mono text-neutral-600 sm:inline" title={workspaceName}>{workspaceName}</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[statusKey]}`} />
          <span className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
            {active ? STATUS_LABEL[active.status] : 'No session'}
          </span>
          <button
            type="button"
            onClick={() => {
              activeHandle?.terminal.clear();
              activeHandle?.focus();
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
            onClick={() => activeHandle?.restart()}
            className="flex items-center gap-1 rounded p-1 text-[10px] text-neutral-500 hover:text-white"
            title="Restart the active terminal session"
            aria-label="Restart terminal"
          >
            <RotateCcw className="h-3 w-3" />
            Restart
          </button>
          <button
            type="button"
            onClick={() => setIsFindOpen((open) => !open)}
            aria-label="Search in terminal"
            title="Search in terminal (Ctrl+F)"
            className={`rounded p-1 hover:text-white ${isFindOpen ? 'text-emerald-300' : 'text-neutral-500'}`}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => handleSplit('horizontal')}
            title="Split terminal vertically (side by side)"
            aria-label="Split terminal vertically"
            disabled={sessionsState.sessions.length >= MAX_TERMINAL_SESSIONS}
            className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-30"
          >
            <Columns className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => handleSplit('vertical')}
            title="Split terminal horizontally (stacked)"
            aria-label="Split terminal horizontally"
            disabled={sessionsState.sessions.length >= MAX_TERMINAL_SESSIONS}
            className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-30"
          >
            <Rows className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onClose} className="p-1 text-neutral-500 hover:text-white" title="Close terminal" aria-label="Close terminal">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isFindOpen && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/[0.07] bg-ink-950 px-2">
          <input
            ref={findInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setIsFindOpen(false);
                activeHandle?.focus();
                return;
              }
              if (event.key !== 'Enter' || !query) return;
              event.preventDefault();
              if (event.shiftKey) activeHandle?.search.findPrevious(query, SEARCH_OPTIONS);
              else activeHandle?.search.findNext(query, SEARCH_OPTIONS);
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            className="h-6 min-w-0 flex-1 rounded border border-white/[0.07] bg-black/40 px-2 text-[11px] font-mono text-neutral-200 outline-none focus:border-emerald-500/40"
          />
          <span className="shrink-0 text-[10px] font-mono text-neutral-500" aria-live="polite">
            {query ? (findResult.count ? `${findResult.index + 1 || findResult.count} of ${findResult.count}` : 'no results') : ''}
          </span>
          <button
            type="button"
            disabled={!query}
            onClick={() => activeHandle?.search.findPrevious(query, SEARCH_OPTIONS)}
            className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-40"
            aria-label="Previous match"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!query}
            onClick={() => activeHandle?.search.findNext(query, SEARCH_OPTIONS)}
            className="rounded p-1 text-neutral-500 hover:text-white disabled:opacity-40"
            aria-label="Next match"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setIsFindOpen(false);
              setQuery('');
              activeHandle?.focus();
            }}
            className="rounded p-1 text-neutral-500 hover:text-white"
            aria-label="Close find"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {paneLayout && paneCount(paneLayout.root) > 1 ? (
          renderPaneNode(paneLayout.root, paneLayout.activeKey)
        ) : (
          <>
            {sessionsState.sessions.map((session) => (
              <TerminalSurface
                key={session.key}
                desktop={desktop}
                workspaceId={workspaceId}
                session={session}
                active={session.key === sessionsState.activeKey}
                onStatus={setStatus}
                onRegister={registerSurface}
                keyHandlers={keyHandlers}
              />
            ))}
          </>
        )}
        {sessionsState.sessions.length === 0 && (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] font-mono text-neutral-600">
            No terminal session.
            <button
              type="button"
              onClick={() => dispatch({ type: 'add', key: createTabKey(), mode: 'system' })}
              className="rounded border border-white/[0.08] px-2 py-0.5 text-neutral-400 hover:text-white"
            >
              New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const SEARCH_OPTIONS = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  decorations: {
    matchBackground: '#123528',
    activeMatchBackground: '#1f6f4e',
    matchOverviewRuler: '#34d399',
    activeMatchColorOverviewRuler: '#f59e0b'
  }
};

/**
 * A command event needs a live shell; a result line only needs somewhere to be
 * read. So `run` goes to the tab it named (or the active one) and is refused when
 * the text is not a single printable line, while everything else is printed as
 * transcript text.
 */
function routeDockEvent(
  event: TerminalDockEvent,
  surfaces: Map<string, TerminalSurfaceHandle>,
  activeKey: string | null
): void {
  const target = (event.kind === 'command' && event.sessionKey ? surfaces.get(event.sessionKey) : null)
    || (activeKey ? surfaces.get(activeKey) : null)
    || null;
  if (!target) return;
  if (event.kind === 'command' && event.run) {
    if (isSafeCommandLine(event.command)) {
      target.run(event.command.trim());
      return;
    }
    target.echo(`${formatTerminalDockEvent({ ...event, run: false })}\x1b[33m[not auto-run: a command must be one printable line]\x1b[0m\r\n`);
    return;
  }
  const text = formatTerminalDockEvent(event);
  if (text) target.echo(text);
}

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useReducerCompat(workspaceId: string) {
  const [state, dispatch] = useReducer(terminalSessionsReducer, workspaceId, initialSessionsState);
  return [state, dispatch] as const;
}

function initialSessionsState(workspaceId: string) {
  const remembered = recallWorkspaceSessions(workspaceId);
  if (remembered.length > 0) {
    return createTerminalSessions(remembered);
  }
  return createTerminalSessions([
    { key: createTabKey(), name: 'Shell 1', mode: 'system', status: 'starting' }
  ]);
}
