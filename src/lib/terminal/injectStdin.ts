/**
 * Approval-gated stdin injection.
 *
 * An interactive prompt (`Overwrite? [y/N]`, `Continue?`) is answered by typing
 * into the PTY, which is the one thing this app refuses to do silently: the run
 * path in the echo channel ends at a real shell, and text typed there can delete
 * work. So nothing in production writes to a PTY without going through
 * `injectStdinWithApproval` first — no UI shortcut, no agent tool. The gate is
 * the same `confirmAction` shape the user already sees for command approval, and
 * it shows the exact bytes (plus the Enter that follows them) before publishing
 * through the existing `run: true` echo-channel path.
 */

import { confirmAction } from '../confirm';
import type { ConfirmRequest } from '../confirm';
import { isSafeCommandLine, publishTerminalDockEvent } from './echoChannel';
import type { TerminalCommandRequest, TerminalDockSource } from './echoChannel';
import { terminalStateManager } from './state';
import type { StructuredTerminalState } from './shellIntegration';

/** A prompt answer is short by nature; a wall of text is a sign of a paste, not an answer. */
export const MAX_INJECTED_STDIN_LENGTH = 200;

export interface InjectStdinOptions {
  /** Human name of the tab, when the caller has one; the id is always shown too. */
  label?: string;
  /** Who asked for the bytes. Defaults to 'user' because only the user approves. */
  source?: TerminalDockSource;
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
  publish?: (event: TerminalCommandRequest) => boolean;
}

export interface InjectStdinAccepted {
  ok: true;
  sessionId: string;
  text: string;
  byteLength: number;
}

export interface InjectStdinRefused {
  ok: false;
  /** Why nothing was typed. Safe to show verbatim. */
  reason: string;
}

export type InjectStdinOutcome = InjectStdinAccepted | InjectStdinRefused;

/**
 * Discriminator helper. This project typechecks with `strict` off, where a bare
 * `outcome.ok` check does not narrow a union, so callers need the predicate.
 */
export function wasInjected(outcome: InjectStdinOutcome): outcome is InjectStdinAccepted {
  return outcome.ok === true;
}

export function injectionRefusal(outcome: InjectStdinOutcome): string {
  return wasInjected(outcome) ? '' : outcome.reason;
}

let dockMounted = false;

/**
 * The panel reports whether a live dock can route an injection. Refusing up front
 * matters: a published event with no subscriber is queued and replayed on the next
 * mount, which would type approved-then-forgotten text into a different command.
 */
export function setTerminalDockMounted(mounted: boolean): void {
  dockMounted = mounted;
}

export function isTerminalDockMounted(): boolean {
  return dockMounted;
}

function refused(reason: string): InjectStdinRefused {
  return { ok: false, reason };
}

/** Control bytes rendered as visible names so the approval dialog cannot be spoofed. */
export function describeInjectedBytes(text: string): string {
  const visible = Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x09) return '<TAB>';
      if (code === 0x0a) return '<LF>';
      if (code === 0x0d) return '<CR>';
      if (code === 0x1b) return '<ESC>';
      if (code === 0x7f) return '<DEL>';
      if (code < 0x20) return `<0x${code.toString(16).padStart(2, '0')}>`;
      return char;
    })
    .join('');
  const bytes = new TextEncoder().encode(text).length + 1;
  return visible ? `${visible} + Enter (${bytes} bytes)` : `Enter only (1 byte)`;
}

function stateLine(state: StructuredTerminalState): string {
  const running = state.currentCommand ?? '(command text not captured)';
  const cwd = state.cwd || '(cwd unknown)';
  return `${cwd}\nrunning: ${running}`;
}

/**
 * Refuses everything the shell would not thank us for, then asks the user.
 * Returns without ever publishing when any check fails or Cancel is pressed.
 */
export async function injectStdinWithApproval(
  sessionId: string,
  text: string,
  options: InjectStdinOptions = {}
): Promise<InjectStdinOutcome> {
  if (!sessionId) return refused('No terminal session was named, so nothing was typed.');

  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return refused('Nothing to send: the answer is empty.');
  if (raw.length > MAX_INJECTED_STDIN_LENGTH) {
    return refused(`Refused: ${raw.length} characters is more than a prompt answer (${MAX_INJECTED_STDIN_LENGTH} max).`);
  }
  if (!isSafeCommandLine(raw)) {
    return refused('Refused: the text must be one printable line with no control characters.');
  }
  if (!dockMounted) {
    return refused('The terminal dock is closed, so nothing was typed into it.');
  }
  if (!terminalStateManager.hasSession(sessionId)) {
    return refused(`No such terminal session: ${sessionId}.`);
  }

  const state = terminalStateManager.getSessionState(sessionId);
  if (!state) return refused(`No shell state for session ${sessionId}.`);
  // Idle shells already have a keyboard: typing into a prompt nobody asked for is
  // how an old answer becomes a new command.
  if (!state.isExecuting) {
    return refused('That terminal is sitting at a prompt, not waiting on a running command.');
  }

  const confirm = options.confirm ?? ((request: ConfirmRequest) => confirmAction(request));
  const publish = options.publish ?? ((event: TerminalCommandRequest) => publishTerminalDockEvent(event));

  const title = 'Type this into the terminal?';
  const body = [
    `Terminal: ${options.label ? `${options.label} · ` : ''}${sessionId}`,
    stateLine(state),
    `Bytes: ${describeInjectedBytes(raw)}`,
    '',
    'This writes straight to the running process. Cancel sends nothing.'
  ].join('\n');

  const accepted = await confirm({ title, body, confirmLabel: 'Send input', cancelLabel: 'Cancel', tone: 'danger' });
  if (!accepted) return refused('Cancelled: nothing was typed.');

  const routed = publish({
    kind: 'command',
    command: raw,
    source: options.source ?? 'user',
    run: true,
    sessionKey: sessionId
  });
  if (!routed) return refused('The terminal did not accept the input, so nothing was typed.');

  return { ok: true, sessionId, text: raw, byteLength: new TextEncoder().encode(raw).length + 1 };
}

/** Transcript line for the panel, so the injection is visible after it happens. */
export function formatInjectionOutcome(outcome: InjectStdinOutcome): string {
  const dim = '\x1b[38;5;245m';
  const reset = '\x1b[0m';
  if (wasInjected(outcome)) {
    return `\r\n${dim}[shadrox] sent ${JSON.stringify(outcome.text)} + Enter to the running command${reset}\r\n`;
  }
  return `\r\n${dim}[shadrox] ${outcome.reason}${reset}\r\n`;
}
