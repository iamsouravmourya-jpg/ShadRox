/**
 * Command echo channel.
 *
 * Chat-side actions ("Run" on a proposed command) and the preview/automation
 * panels need to write into the terminal dock without importing it, and the dock
 * may be closed when they do. So events go through this one publisher: live
 * subscribers receive them immediately, otherwise a bounded queue holds them for
 * the dock's next mount.
 */

export type TerminalDockSource = 'assistant' | 'user' | 'system';

export interface TerminalCommandRequest {
  kind: 'command';
  command: string;
  source: TerminalDockSource;
  /** When set the panel types the command into that tab's shell instead of only printing it. */
  run?: boolean;
  sessionKey?: string;
}

export interface TerminalCommandResult {
  kind: 'result';
  command: string;
  source: TerminalDockSource;
  exitCode: number | null;
  signal?: string | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

export type TerminalDockEvent = TerminalCommandRequest | TerminalCommandResult;

export const MAX_QUEUED_TERMINAL_EVENTS = 16;
export const MAX_TERMINAL_COMMAND_LENGTH = 2000;
export const MAX_TERMINAL_OUTPUT_PREVIEW = 4000;

const SOURCE_LABELS: Record<TerminalDockSource, string> = {
  assistant: 'assistant',
  user: 'user',
  system: 'shadrox'
};

function sourceLabel(source: TerminalDockSource | undefined): string {
  return SOURCE_LABELS[source ?? 'system'] ?? 'shadrox';
}

/** One printable line: no control bytes that could redraw the prompt or spoof a status. */
export function sanitizeEchoLine(text: string, max: number = MAX_TERMINAL_COMMAND_LENGTH): string {
  const cleaned = String(text ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)} [trimmed]`;
}

/**
 * Gate for typing a command into a live shell instead of only printing it.
 *
 * Tab collapsing and newline stripping above are display choices; a shell has to
 * receive what the user clicked. So auto-run only accepts a single line of
 * printable characters, and a command that needs anything else stops at the
 * transcript, where the user can see and edit it.
 */
export function isSafeCommandLine(command: string): boolean {
  const raw = String(command ?? '');
  return raw.trim().length > 0 && raw.length <= MAX_TERMINAL_COMMAND_LENGTH && /^[\x20-\x7e]+$/.test(raw);
}

export function truncateEchoOutput(text: string | undefined, max: number = MAX_TERMINAL_OUTPUT_PREVIEW): string {
  const raw = String(text ?? '');
  return raw.length > max ? `${raw.slice(0, max)}\r\n... truncated ...` : raw;
}

export function formatDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || (durationMs as number) < 0) return '';
  const ms = durationMs as number;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatTerminalDockEvent(event: TerminalDockEvent): string {
  if (event.kind === 'command') {
    const command = sanitizeEchoLine(event.command);
    if (!command) return '';
    return `\r\n\x1b[38;5;245m[${sourceLabel(event.source)}] $\x1b[0m \x1b[1m${command}\x1b[0m\r\n`;
  }

  const command = sanitizeEchoLine(event.command);
  const dim = '\x1b[38;5;245m';
  const reset = '\x1b[0m';
  const duration = formatDuration(event.durationMs);
  const succeeded = event.exitCode === 0 && !event.signal;
  const status = event.signal
    ? `\x1b[91mterminated by ${sanitizeEchoLine(event.signal, 40)}\x1b[0m`
    : `${succeeded ? '\x1b[92m' : '\x1b[91m'}exit ${event.exitCode ?? 'unknown'}\x1b[0m`;
  const parts = [
    `\r\n${dim}[${sourceLabel(event.source)} ran] ${command}${duration ? ` (${duration})` : ''}${reset}\r\n`
  ];
  const stdout = truncateEchoOutput(event.stdout).trimEnd();
  const stderr = truncateEchoOutput(event.stderr).trimEnd();
  if (stdout) parts.push(`${stdout}\r\n`);
  if (stderr) parts.push(`\x1b[93m${stderr}\x1b[0m\r\n`);
  if (!stdout && !stderr) parts.push(`${dim}(no output)${reset}\r\n`);
  parts.push(`${status}\r\n`);
  return parts.join('');
}

type Listener = (event: TerminalDockEvent) => void;

const listeners = new Set<Listener>();
let queue: TerminalDockEvent[] = [];

/** True when a mounted dock took the event; false means it is queued for the next mount. */
/**
 * A `run: true` event must be typed into a real shell, so its success is an
 * acknowledgement rather than "a listener existed". The panel registers the
 * router while it is mounted; the queue never replays run events because the
 * session they were approved for may be gone by then.
 */
let runRouter: ((event: TerminalCommandRequest) => boolean) | null = null;

export function setTerminalRunRouter(router: ((event: TerminalCommandRequest) => boolean) | null): void {
  runRouter = router;
}

export function publishTerminalDockEvent(event: TerminalDockEvent): boolean {
  if (!event || (event.kind === 'command' && !String(event.command).trim())) return false;
  if (event.kind === 'command' && event.run) {
    if (listeners.size === 0) return false;
    return runRouter ? runRouter(event) : false;
  }
  if (listeners.size === 0) {
    queue.push(event);
    if (queue.length > MAX_QUEUED_TERMINAL_EVENTS) queue = queue.slice(-MAX_QUEUED_TERMINAL_EVENTS);
    return false;
  }
  for (const listener of listeners) listener(event);
  return true;
}

export function subscribeTerminalDockEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (queue.length > 0) {
    const pending = queue;
    queue = [];
    for (const event of pending) {
      for (const active of listeners) active(event);
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

export function pendingTerminalDockEvents(): readonly TerminalDockEvent[] {
  return queue;
}

export function clearTerminalDockQueue(): void {
  queue = [];
}
