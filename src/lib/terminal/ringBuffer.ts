/**
 * Transcript kept outside the xterm instance.
 *
 * A session's scrollback dies with its xterm when the dock unmounts, so the last
 * lines are mirrored here (module scope, so it outlives the component) and
 * reprinted when the tab is re-mounted. Only whole lines are kept, newest last.
 */

export const TERMINAL_RING_LINES = 2000;
export const TERMINAL_MAX_LINE_LENGTH = 4096;
export const MAX_TERMINAL_TRANSCRIPTS = 24;

export interface LineRing {
  push(text: string): void;
  lines(): readonly string[];
  lineCount(): number;
  clear(): void;
}

export function createLineRing(capacity: number = TERMINAL_RING_LINES): LineRing {
  const size = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : TERMINAL_RING_LINES;
  const kept: string[] = [];
  // A chunk can end mid-line; the fragment has to be remembered so the next chunk
  // continues the same line instead of inventing a break the shell never wrote.
  let fragment = '';

  const emit = (line: string) => {
    const text = line.length > TERMINAL_MAX_LINE_LENGTH
      ? `${line.slice(0, TERMINAL_MAX_LINE_LENGTH)}... truncated ...`
      : line;
    kept.push(text);
    while (kept.length > size) kept.shift();
  };

  return {
    push(text) {
      if (typeof text !== 'string' || !text) return;
      let cursor = 0;
      while (cursor < text.length) {
        const index = text.slice(cursor).search(/[\r\n]/);
        if (index < 0) {
          fragment += text.slice(cursor);
          if (fragment.length > TERMINAL_MAX_LINE_LENGTH) {
            emit(fragment);
            fragment = '';
          }
          break;
        }
        const breakAt = cursor + index;
        emit(fragment + text.slice(cursor, breakAt));
        fragment = '';
        cursor = breakAt + 1;
        // \r\n is a single break, not an empty line between them.
        if (text[cursor - 1] === '\r' && text[cursor] === '\n') cursor += 1;
      }
    },
    lines() {
      return kept;
    },
    lineCount() {
      return kept.length + (fragment ? 1 : 0);
    },
    clear() {
      kept.length = 0;
      fragment = '';
    }
  };
}

const transcripts = new Map<string, LineRing>();

export function terminalTranscriptKey(workspaceId: string, sessionKey: string): string {
  return `${workspaceId}\u0000${sessionKey}`;
}

function ringFor(key: string): LineRing {
  const existing = transcripts.get(key);
  if (existing) return existing;
  while (transcripts.size >= MAX_TERMINAL_TRANSCRIPTS) {
    const oldest = transcripts.keys().next();
    if (oldest.done) break;
    transcripts.delete(oldest.value);
  }
  const created = createLineRing();
  transcripts.set(key, created);
  return created;
}

export function appendTerminalTranscript(key: string, text: string): void {
  if (!key) return;
  ringFor(key).push(text);
}

/**
 * Consumes the transcript: reprinting it twice would double the scrollback every
 * time a tab is re-mounted.
 */
export function takeTerminalTranscript(key: string, maxLines: number = TERMINAL_RING_LINES): string {
  const ring = transcripts.get(key);
  if (!ring) return '';
  const kept = ring.lines();
  const lines = kept.slice(Math.max(0, kept.length - maxLines));
  transcripts.delete(key);
  if (lines.length === 0) return '';
  return `${lines.join('\r\n')}\r\n`;
}

export function peekTerminalTranscriptLineCount(key: string): number {
  return transcripts.get(key)?.lineCount() ?? 0;
}

export function dropTerminalTranscript(key: string): void {
  transcripts.delete(key);
}
