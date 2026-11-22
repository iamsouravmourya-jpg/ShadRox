/**
 * Deterministic Node-native Milestone Verifier.
 *
 * Replaces fragile LLM-generated POSIX/Windows shell file-existence commands
 * (`test -f`, `ls`, `dir`, `Test-Path`, `Get-Item`) with direct deterministic
 * workspace inspection + SHA-256 content-hash comparison, and provides explicit
 * category-aware verification so read-only / checkpoint milestones verify tool
 * execution telemetry instead of failing with "the milestone touched nothing".
 */

import type {
  DiagnosticLine,
  MilestoneCategory,
  ToolExecutionEvent,
  TurnWrites,
  VerifiableUnit
} from './types';

/* ------------------------------------------------------------------ *
 * Synchronous FIPS 180-4 SHA-256 (works identically in Browser & Node)
 * ------------------------------------------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(content: string): string {
  const utf8 = new TextEncoder().encode(content);
  const bitLen = utf8.length * 8;
  const paddedLen = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hiBits, false);
  view.setUint32(paddedLen - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export async function captureFileHashSnapshot(
  paths: readonly string[],
  readFile?: (path: string) => Promise<string | null>
): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};
  if (!readFile || paths.length === 0) return snapshot;
  const unique = [...new Set(paths.map((p) => normalizeVerifyPath(p)).filter(Boolean))];
  for (const target of unique) {
    try {
      const content = await readFile(target);
      snapshot[target] = typeof content === 'string' ? sha256Hex(content) : null;
    } catch {
      snapshot[target] = null;
    }
  }
  return snapshot;
}

export function normalizeVerifyPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/* ------------------------------------------------------------------ *
 * Category classification & shell existence-check interception
 * ------------------------------------------------------------------ */

const CHECKPOINT_INTENT_RE = /\b(create|save|take|list|verify)?\s*checkpoint\b|\bsnapshot\b/i;
const LEADING_READ_ONLY_VERB_RE = /^(?:verify|check|inspect|audit|analy[sz]e|read|review|list|search)\b/i;
const READ_ONLY_INTENT_RE =
  /\b(inspect|audit|review|analyze|analyse|check\s+preview|verify\s+preview|read|list|search|save\s+memory|record\s+memory|memory\s+note|check\s+problems|diagnostics)\b/i;
const EXPLICIT_MUTATION_VERB_RE =
  /\b(create|write|add|implement|update|edit|modify|refactor|fix|patch|replace|rename|remove|delete|wire|integrate|extend|enhance|style|convert|migrate|rewrite)\b/i;
const MUTATION_VERB_RE =
  /\b(create|write|add|build|implement|update|edit|modify|refactor|fix|patch|replace|rename|remove|delete|wire|integrate|extend|enhance|style|convert|migrate)\b/i;

export function inferMilestoneCategory(
  unit: Pick<VerifiableUnit, 'category' | 'title' | 'instruction' | 'expectedFiles' | 'verifyCommand'>
): MilestoneCategory {
  if (unit.category) return unit.category;
  const rawTitle = (unit.title ?? '').trim().replace(/^(?:\d+[.)]\s*|[-*]\s*)/, '').trim();
  const rawInstruction = (unit.instruction ?? '').trim();
  const text = `${unit.title ?? ''} ${unit.instruction ?? ''}`.trim();

  if (unit.expectedFiles.length === 0 && CHECKPOINT_INTENT_RE.test(text)) {
    return 'checkpoint';
  }

  const leadingSubject = rawTitle || rawInstruction;
  if (LEADING_READ_ONLY_VERB_RE.test(leadingSubject) && !EXPLICIT_MUTATION_VERB_RE.test(text)) {
    return 'read_only';
  }

  if (unit.expectedFiles.length === 0) {
    if (READ_ONLY_INTENT_RE.test(text) && !MUTATION_VERB_RE.test(text)) return 'read_only';
    if (unit.verifyCommand) return 'command_execution';
    return 'file_mutation';
  }
  return 'file_mutation';
}

export interface ShellFileCheckClause {
  kind: 'file' | 'dir' | 'exists';
  target: string;
}

function unquoteToken(token: string): string {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Splits a shell command on `&&` / `;` ONLY when every single clause is a
 * pure file-existence or directory-listing check (`test -f`, `[ -f ... ]`,
 * `ls`, `dir`, `Test-Path`, `Get-Item`). Returns null for real build/test
 * commands (`npm test`, `tsc`, `pytest`, etc.) so those still run normally.
 */
export function parseNativeFileCheckCommand(command: string): ShellFileCheckClause[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[|`<>]/.test(trimmed)) return null;

  const segments = trimmed.split(/\s*(?:&&|;)\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const clauses: ShellFileCheckClause[] = [];

  for (const segment of segments) {
    // 1. POSIX `test -f path`, `test -d path`, `test -e path`, `test -s path`
    const testMatch = segment.match(/^test\s+-(f|s|e|r|w|d)\s+(.+)$/i);
    if (testMatch) {
      const flag = testMatch[1].toLowerCase();
      const target = normalizeVerifyPath(unquoteToken(testMatch[2]));
      if (!target || target.startsWith('-')) return null;
      clauses.push({ kind: flag === 'd' ? 'dir' : flag === 'e' ? 'exists' : 'file', target });
      continue;
    }

    // 2. POSIX `[ -f path ]` or `[[ -f path ]]`
    const bracketMatch = segment.match(/^\[\[?\s+-(f|s|e|r|w|d)\s+([^\]]+?)\s+\]\]?$/i);
    if (bracketMatch) {
      const flag = bracketMatch[1].toLowerCase();
      const target = normalizeVerifyPath(unquoteToken(bracketMatch[2]));
      if (!target || target.startsWith('-')) return null;
      clauses.push({ kind: flag === 'd' ? 'dir' : flag === 'e' ? 'exists' : 'file', target });
      continue;
    }

    // 3. `stat <flags> path`
    const statMatch = segment.match(/^stat(?:\s+-[A-Za-z]+)*\s+(.+)$/i);
    if (statMatch) {
      const target = normalizeVerifyPath(unquoteToken(statMatch[1]));
      if (!target || target.includes(' ')) return null;
      clauses.push({ kind: 'exists', target });
      continue;
    }

    // 4. PowerShell `Test-Path <path>` or `Get-Item <path>`
    const psMatch = segment.match(/^(?:Test-Path|Get-Item)(?:\s+-Path)?(?:\s+-PathType\s+\w+)?\s+(.+)$/i);
    if (psMatch) {
      const target = normalizeVerifyPath(unquoteToken(psMatch[1]));
      if (!target || target.startsWith('-')) return null;
      clauses.push({ kind: 'exists', target });
      continue;
    }

    // 5. `ls [flags] <path>` or Windows `dir [flags] <path>`
    const listMatch = segment.match(/^(?:ls|dir)(?:\s+[-/][A-Za-z0-9]+)*\s+(.+)$/i);
    if (listMatch) {
      const target = normalizeVerifyPath(unquoteToken(listMatch[1]));
      if (!target || target.includes('*')) return null;
      clauses.push({ kind: 'exists', target });
      continue;
    }

    // 6. Plain `ls` or `dir` without target (checks workspace root has files)
    if (/^(?:ls|dir)(?:\s+[-/][A-Za-z0-9]+)*$/i.test(segment)) {
      clauses.push({ kind: 'dir', target: '' });
      continue;
    }

    return null;
  }

  return clauses.length > 0 ? clauses : null;
}

export interface NativeFileCheckResult {
  handled: boolean;
  ok: boolean;
  notes: string[];
  missing: string[];
}

export async function evaluateNativeFileCheckCommand(
  command: string,
  options: {
    listFiles: () => string[];
    readFile?: (path: string) => Promise<string | null>;
  }
): Promise<NativeFileCheckResult | null> {
  const clauses = parseNativeFileCheckCommand(command);
  if (!clauses) return null;

  const files = options.listFiles().map((f) => normalizeVerifyPath(f));
  const fileSetLower = new Set(files.map((f) => f.toLowerCase()));
  const missing: string[] = [];

  for (const clause of clauses) {
    if (clause.target === '') {
      if (files.length === 0) missing.push('.');
      continue;
    }
    const targetLower = clause.target.toLowerCase();
    const prefixLower = `${targetLower}/`;
    const inListAsDir = files.some((f) => f.toLowerCase().startsWith(prefixLower));
    const inListAsFile = fileSetLower.has(targetLower);

    if (clause.kind === 'dir') {
      if (!inListAsDir) missing.push(clause.target);
      continue;
    }

    if (clause.kind === 'exists' && (inListAsDir || inListAsFile)) {
      continue;
    }

    if (clause.kind === 'file' && inListAsFile) {
      continue;
    }

    if (typeof options.readFile === 'function') {
      try {
        const content = await options.readFile(clause.target);
        if (typeof content === 'string') continue;
      } catch {
        /* absent on disk */
      }
    }

    missing.push(clause.target);
  }

  if (missing.length > 0) {
    return {
      handled: true,
      ok: false,
      missing,
      notes: [
        `Node-native file check replaced "${command}" and found missing path(s): ${missing.join(', ')}.`
      ]
    };
  }

  return {
    handled: true,
    ok: true,
    missing: [],
    notes: [
      `Node-native check verified ${clauses.map((c) => c.target || '.').join(', ')} on disk cleanly.`
    ]
  };
}

/* ------------------------------------------------------------------ *
 * SHA-256 mutation & telemetry verification
 * ------------------------------------------------------------------ */

export interface HashComparisonResult {
  compared: boolean;
  mutatedPaths: string[];
  unchangedPaths: string[];
  missingPaths: string[];
}

export function compareFileHashSnapshots(
  targetPaths: readonly string[],
  preHashes?: Record<string, string | null>,
  postHashes?: Record<string, string | null>
): HashComparisonResult {
  const unique = [...new Set(targetPaths.map((p) => normalizeVerifyPath(p)).filter(Boolean))];
  if (!preHashes || !postHashes || unique.length === 0) {
    return { compared: false, mutatedPaths: [], unchangedPaths: [], missingPaths: [] };
  }

  const mutatedPaths: string[] = [];
  const unchangedPaths: string[] = [];
  const missingPaths: string[] = [];
  let anyComparable = false;

  for (const path of unique) {
    const hasPost = Object.prototype.hasOwnProperty.call(postHashes, path);
    if (!hasPost) continue;
    anyComparable = true;
    const before = Object.prototype.hasOwnProperty.call(preHashes, path) ? preHashes[path] : null;
    const after = postHashes[path];
    if (after === null) {
      missingPaths.push(path);
    } else if (before !== after) {
      mutatedPaths.push(path);
    } else {
      unchangedPaths.push(path);
    }
  }

  return {
    compared: anyComparable,
    mutatedPaths,
    unchangedPaths,
    missingPaths
  };
}

const CHECKPOINT_TOOLS = new Set(['checkpoint', 'list_checkpoints']);
const READ_ONLY_TOOLS = new Set([
  'preview_inspect',
  'preview_control',
  'memory_read',
  'memory_note',
  'read_file',
  'search_text',
  'find_files',
  'list_directory',
  'problems',
  'verify',
  'git_state',
  'terminal_state',
  'debugger_state',
  'outline',
  'find_references',
  'go_to_definition',
  'semantic_search',
  'diff_review'
]);

export function verifyToolTelemetry(
  category: MilestoneCategory,
  unit: Pick<VerifiableUnit, 'title' | 'instruction'>,
  writes?: TurnWrites
): { ok: boolean; ranRelevantTool: boolean; notes: string[] } {
  const events: readonly ToolExecutionEvent[] = writes?.toolEvents ?? [];
  const notes: string[] = [];

  if (category === 'checkpoint') {
    const checkpointOk = events.some((ev) => ev.ok && CHECKPOINT_TOOLS.has(ev.name));
    if (checkpointOk) {
      notes.push('checkpoint telemetry confirmed without requiring file diffs.');
      return { ok: true, ranRelevantTool: true, notes };
    }
    const checkpointFailed = events.find((ev) => !ev.ok && CHECKPOINT_TOOLS.has(ev.name));
    if (checkpointFailed) {
      notes.push(`checkpoint tool failed${checkpointFailed.summary ? `: ${checkpointFailed.summary}` : '.'}`);
      return { ok: false, ranRelevantTool: true, notes };
    }
    return { ok: true, ranRelevantTool: events.some((ev) => ev.ok), notes };
  }

  if (category === 'read_only') {
    const text = `${unit.title ?? ''} ${unit.instruction ?? ''}`.toLowerCase();
    const wantsPreview = /\bpreview\b/.test(text);
    const wantsMemory = /\bmemory\b/.test(text);
    if (wantsPreview) {
      const previewOk = events.some((ev) => ev.ok && (ev.name === 'preview_inspect' || ev.name === 'preview_control'));
      if (previewOk) {
        notes.push('read-only preview inspection verified via tool telemetry.');
        return { ok: true, ranRelevantTool: true, notes };
      }
      const previewFailed = events.find((ev) => !ev.ok && (ev.name === 'preview_inspect' || ev.name === 'preview_control'));
      if (previewFailed) {
        notes.push(`preview inspection tool did not succeed: ${previewFailed.name}.`);
        return { ok: false, ranRelevantTool: true, notes };
      }
    }
    if (wantsMemory) {
      const memoryOk = events.some((ev) => ev.ok && (ev.name === 'memory_read' || ev.name === 'memory_note'));
      if (memoryOk) {
        notes.push('memory operation verified via tool telemetry.');
        return { ok: true, ranRelevantTool: true, notes };
      }
    }
    const anyReadOk = events.some((ev) => ev.ok && READ_ONLY_TOOLS.has(ev.name));
    if (anyReadOk) {
      notes.push('read-only milestone verified via tool execution telemetry.');
      return { ok: true, ranRelevantTool: true, notes };
    }
    return { ok: false, ranRelevantTool: false, notes };
  }

  return { ok: false, ranRelevantTool: false, notes };
}

export function buildNonMutationDiagnostics(missingPaths: readonly string[]): DiagnosticLine[] {
  return missingPaths.map((path) => ({
    path,
    line: 1,
    column: 1,
    message: `Expected milestone file "${path}" was not found on disk after verification.`,
    severity: 'error'
  }));
}
