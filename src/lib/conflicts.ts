/**
 * Git conflict marker parsing and resolution.
 *
 * Parses `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` blocks (7 or more
 * repeated marker characters, at column 0) and rewrites a conflicted file
 * using Ours / Theirs / Both choices. Pure string work: no Node APIs.
 */

export type ConflictChoice = 'ours' | 'theirs' | 'both';

export interface ConflictHunk {
  index: number;
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-based line of the `>>>>>>>` marker. */
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string;
  theirs: string;
  /** diff3 `|||||||` section content, `null` when the marker is absent. */
  base: string | null;
}

export interface ParsedConflict {
  hunks: ConflictHunk[];
  malformed: boolean;
}

const OPEN_RE = /^<{7,}(.*)$/;
const BASE_RE = /^\|{7,}(.*)$/;
const SEP_RE = /^={7,}(.*)$/;
const CLOSE_RE = /^>{7,}(.*)$/;

type Phase = 'ours' | 'base' | 'theirs';

/** Splits on any line break style while dropping the terminators. */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** Uses CRLF when the file's first newline is CRLF, otherwise LF. */
function detectNewline(content: string): string {
  const match = /\r?\n/.exec(content);
  return match && match[0] === '\r\n' ? '\r\n' : '\n';
}

/** True when `content` holds at least one complete conflict block. */
export function hasConflictMarkers(content: string): boolean {
  return parseConflicts(content).hunks.length > 0;
}

/**
 * Walks the file looking for conflict blocks. Stops at the first marker that
 * appears out of order (or at an unterminated block) and reports it as
 * malformed, keeping the hunks that were parsed successfully.
 */
export function parseConflicts(content: string): ParsedConflict {
  const lines = splitLines(content);
  const hunks: ConflictHunk[] = [];
  let malformed = false;
  let i = 0;

  while (i < lines.length) {
    const opener = OPEN_RE.exec(lines[i]);
    if (!opener) {
      i++;
      continue;
    }

    const startLine = i + 1;
    const oursLabel = opener[1].trim();
    const oursLines: string[] = [];
    const theirsLines: string[] = [];
    const baseLines: string[] = [];
    let theirsLabel = '';
    let hasBase = false;
    let phase: Phase = 'ours';
    let closed = false;
    i++;

    while (i < lines.length) {
      const line = lines[i];

      if (OPEN_RE.test(line)) {
        malformed = true;
        break;
      }
      if (BASE_RE.test(line)) {
        if (phase !== 'ours') {
          malformed = true;
          break;
        }
        phase = 'base';
        hasBase = true;
        i++;
        continue;
      }
      if (SEP_RE.test(line)) {
        if (phase === 'theirs') {
          malformed = true;
          break;
        }
        phase = 'theirs';
        i++;
        continue;
      }
      const closer = CLOSE_RE.exec(line);
      if (closer) {
        if (phase !== 'theirs') {
          malformed = true;
          break;
        }
        theirsLabel = closer[1].trim();
        closed = true;
        i++;
        break;
      }

      if (phase === 'ours') oursLines.push(line);
      else if (phase === 'base') baseLines.push(line);
      else theirsLines.push(line);
      i++;
    }

    if (!closed) {
      malformed = true;
      break;
    }

    hunks.push({
      index: hunks.length,
      startLine,
      endLine: i,
      oursLabel,
      theirsLabel,
      ours: oursLines.join('\n'),
      theirs: theirsLines.join('\n'),
      base: hasBase ? baseLines.join('\n') : null,
    });
  }

  return { hunks, malformed };
}

/** Splits the raw hunk lines back into ours/theirs sections, empty lines included. */
function sectionLines(
  lines: string[],
  startIndex: number,
  endIndex: number
): { ours: string[]; theirs: string[] } {
  let baseIndex = -1;
  let sepIndex = -1;
  for (let j = startIndex + 1; j < endIndex; j++) {
    if (baseIndex === -1 && BASE_RE.test(lines[j])) {
      baseIndex = j;
      continue;
    }
    if (SEP_RE.test(lines[j])) {
      sepIndex = j;
      break;
    }
  }

  const oursEnd = baseIndex !== -1 ? baseIndex : sepIndex;
  const ours = oursEnd >= 0 ? lines.slice(startIndex + 1, oursEnd) : [];
  const theirs = sepIndex >= 0 ? lines.slice(sepIndex + 1, endIndex) : [];
  return { ours, theirs };
}

/**
 * Rewrites every hunk that has a choice. Hunks beyond the end of `choices`
 * are left untouched (markers included) and counted in `unresolved`.
 * Output keeps the file's newline style.
 */
export function resolveConflictFile(
  content: string,
  choices: ConflictChoice[]
): { content: string; unresolved: number } {
  const parsed = parseConflicts(content);
  const lines = splitLines(content);
  const newline = detectNewline(content);
  const out: string[] = [];
  let cursor = 0;
  let unresolved = 0;

  for (const hunk of parsed.hunks) {
    const startIndex = hunk.startLine - 1;
    const endIndex = hunk.endLine - 1;

    while (cursor < startIndex) {
      out.push(lines[cursor]);
      cursor++;
    }

    const choice = choices[hunk.index];
    if (choice === 'ours' || choice === 'theirs' || choice === 'both') {
      const sections = sectionLines(lines, startIndex, endIndex);
      if (choice === 'ours') out.push(...sections.ours);
      else if (choice === 'theirs') out.push(...sections.theirs);
      else out.push(...sections.ours, ...sections.theirs);
      cursor = endIndex + 1;
    } else {
      unresolved++;
      while (cursor <= endIndex) {
        out.push(lines[cursor]);
        cursor++;
      }
    }
  }

  while (cursor < lines.length) {
    out.push(lines[cursor]);
    cursor++;
  }

  return { content: out.join(newline), unresolved };
}

/** Returns the files that contain at least one conflict hunk, in input order. */
export function detectConflictFiles(
  files: Array<{ name: string; content: string }>
): Array<{ name: string; hunks: ConflictHunk[] }> {
  const result: Array<{ name: string; hunks: ConflictHunk[] }> = [];
  for (const file of files) {
    const { hunks } = parseConflicts(file.content);
    if (hunks.length > 0) result.push({ name: file.name, hunks });
  }
  return result;
}
