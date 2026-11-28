import type { ExternalToolDefinition } from './agent/mcpTools';
import { hasPreviewableFiles, type WorkspaceToolContext } from './agent/toolGatekeeper';
import { hashContextContent, type ContextSource } from './contextManifest';
import { normalizeSlashes } from './diagnostics';
import type { MapInputFile } from './repoMap';
import type { WorkspaceFile } from './types';

export function normalizeContextPath(filePath: string): string {
  return normalizeSlashes(filePath).replace(/^\.\//, '').toLowerCase();
}

/**
 * Groups multi-line stack traces with their header error line, deduplicates
 * identical diagnostic entries while preserving first-seen order and counting
 * repeats `(xN)`, and caps output to `maxUnique` entries.
 */
export function dedupeAndCapDiagnostics(raw: string, maxUnique = 5): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const rawLines = trimmed.split(/\r?\n/);
  const entries: string[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const isContinuation = /^\s+(?:at\s|\.\.\.|Caused by:|Traceback|\^|~)/.test(line) && entries.length > 0;
    if (isContinuation) {
      entries[entries.length - 1] = `${entries[entries.length - 1]}\n${line}`;
    } else {
      entries.push(line.trim());
    }
  }

  const uniqueOrder: string[] = [];
  const counts = new Map<string, number>();
  const keyToEntry = new Map<string, string>();

  for (const entry of entries) {
    const normKey = entry
      .replace(/\s+/g, ' ')
      .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
      .trim();
    const prev = counts.get(normKey);
    if (prev === undefined) {
      counts.set(normKey, 1);
      keyToEntry.set(normKey, entry);
      uniqueOrder.push(normKey);
    } else {
      counts.set(normKey, prev + 1);
    }
  }

  const cap = Math.max(1, maxUnique);
  const shown = uniqueOrder.slice(0, cap).map((key) => {
    const entry = keyToEntry.get(key) ?? '';
    const count = counts.get(key) ?? 1;
    if (count <= 1) return entry;
    const newlineIdx = entry.indexOf('\n');
    if (newlineIdx < 0) return `${entry} (x${count})`;
    return `${entry.slice(0, newlineIdx)} (x${count})${entry.slice(newlineIdx)}`;
  });

  const omitted = uniqueOrder.length - shown.length;
  if (omitted > 0) {
    shown.push(`… (+${omitted} more unique runtime/diagnostic error${omitted === 1 ? '' : 's'} omitted)`);
  }
  return shown.join('\n');
}

/**
 * Deduplicates workspace files by normalized relative path, preserving the
 * earlier (higher-priority buffered) copy when duplicates exist.
 */
export function dedupeWorkspaceFiles(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  const seen = new Set<string>();
  const out: WorkspaceFile[] = [];
  for (const file of files) {
    const key = normalizeContextPath(file.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * Excludes files whose full contents were already injected into `files`
 * (active/attached excerpts below maxChars) so BM25 retrieval does not send
 * identical content twice in the same prompt.
 */
export function filterFilesForRetrieval(
  files: readonly WorkspaceFile[],
  alreadyIncludedInFull: ReadonlySet<string>
): WorkspaceFile[] {
  if (alreadyIncludedInFull.size === 0) return [...files];
  return files.filter((file) => !alreadyIncludedInFull.has(normalizeContextPath(file.name)));
}

/**
 * Deduplicates path lists case-insensitively across slashes and leading `./`
 * while preserving the first seen canonical casing.
 */
export function dedupeContextPaths(paths: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const key = normalizeContextPath(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Deduplicates repo-map input files by normalized relative path, preserving the
 * first seen copy. Mirrors `dedupeWorkspaceFiles` for the `MapInputFile` shape
 * the ranked repo map and dependent-file selector consume.
 */
export function dedupeMapInputFiles(files: readonly MapInputFile[]): MapInputFile[] {
  const seen = new Set<string>();
  const out: MapInputFile[] = [];
  for (const file of files) {
    const key = normalizeContextPath(file.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * Deterministic cache key for `describeTools(...)` covering every gating flag,
 * sorted tool bundles, notes, and external MCP definitions.
 */
export function serializeDescribeToolsCacheKey(
  maxRounds: number,
  external: readonly ExternalToolDefinition[],
  notes: readonly string[],
  context?: WorkspaceToolContext,
  profile: 'full' | 'lean' = 'full'
): string {
  const mcpSig = external
    .map((tool) => `${tool.name}\0${tool.parameters}\0${tool.description}`)
    .sort()
    .join('\x01');
  const notesSig = notes.join('\x02');
  if (!context) {
    return `${maxRounds}|no-ctx|${profile}|${mcpSig}|${notesSig}`;
  }
  const enabled = context.enabledBundles ? [...context.enabledBundles].sort().join(',') : 'undef';
  const unlocked = context.unlockedBundles ? [...context.unlockedBundles].sort().join(',') : 'undef';
  const touched =
    context.touchedFiles === undefined
      ? 'undef'
      : context.touchedFiles.length > 0
        ? 'nonempty'
        : 'empty';
  const ctxSig = [
    context.workspaceOpen ? '1' : '0',
    hasPreviewableFiles(context.filePaths) ? '1' : '0',
    context.previewActive ? '1' : '0',
    context.activeJobCount > 0 ? '1' : '0',
    context.terminalAwaitingInput ? '1' : '0',
    context.hasActiveTerminal ? '1' : '0',
    context.checkpointCount > 0 ? '1' : '0',
    context.turnIntent ?? 'undef',
    enabled,
    unlocked,
    context.isReadOnlyTurn === undefined ? 'undef' : context.isReadOnlyTurn ? '1' : '0',
    context.hasMutatedFiles === undefined ? 'undef' : context.hasMutatedFiles ? '1' : '0',
    touched,
    context.hasMultiFileEdit ? '1' : '0',
    context.hasGitRepo === undefined ? 'undef' : context.hasGitRepo ? '1' : '0',
    context.webAvailable === undefined ? 'undef' : context.webAvailable ? '1' : '0'
  ].join(':');
  return `${maxRounds}|${ctxSig}|${profile}|${mcpSig}|${notesSig}`;
}

/**
 * Appends optional lines to `core` only while the accumulated character count
 * stays within `maxCoreChars`, preventing semi-static context bloat from
 * starving file excerpts and retrieved chunks.
 */
export function appendCoreSectionWithinBudget(
  core: string[],
  currentChars: number,
  sectionLines: readonly string[],
  maxCoreChars: number,
  trimMarker = '\n… (section truncated for system instruction budget)'
): number {
  const nonEmpty = sectionLines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return currentChars;

  const joined = nonEmpty.join('\n\n');
  const separatorCost = currentChars > 0 ? 2 : 0;
  const remaining = maxCoreChars - currentChars - separatorCost;
  if (remaining <= 0) return currentChars;

  if (joined.length <= remaining) {
    core.push(...sectionLines);
    return currentChars + separatorCost + joined.length;
  }

  const minKeepChars = trimMarker.length + 200;
  if (remaining < minKeepChars) return currentChars;

  const sliceLen = remaining - trimMarker.length;
  const truncated = `${joined.slice(0, sliceLen)}${trimMarker}`;
  core.push(truncated);
  return currentChars + separatorCost + truncated.length;
}

export interface ManifestSymbolPin {
  name: string;
  file: string;
  line?: number;
}

export interface DedupeManifestInput {
  selectedSymbols: readonly ManifestSymbolPin[];
  selectedFiles: readonly string[];
  workspaceFiles: readonly WorkspaceFile[];
  activeFile: WorkspaceFile | null | undefined;
  diskFiles: readonly WorkspaceFile[];
  repoMap: string;
}

function approxTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * Assembles deduplicated manifest `sources` and `resolvedPaths` across pinned
 * symbols, attached files, active editor buffer, retrieved disk files, and
 * repo map so overlapping files are never emitted twice.
 */
export function dedupeManifestData(input: DedupeManifestInput): {
  sources: ContextSource[];
  resolvedPaths: string[];
  targets: string[];
} {
  const sources: ContextSource[] = [];
  const resolvedPaths: string[] = [];
  const seenResolved = new Set<string>();
  const seenFiles = new Set<string>();
  const seenPins = new Set<string>();

  const recordResolved = (filePath: string): void => {
    const key = normalizeContextPath(filePath);
    if (!key || seenResolved.has(key)) return;
    seenResolved.add(key);
    resolvedPaths.push(filePath);
  };

  for (const symbol of input.selectedSymbols) {
    const pinKey = `${normalizeContextPath(symbol.file)}#${symbol.name}#${symbol.line ?? ''}`;
    if (seenPins.has(pinKey)) continue;
    seenPins.add(pinKey);
    sources.push({
      path: symbol.file,
      kind: 'pin',
      reason: `pinned symbol ${symbol.name}`,
      ranges: symbol.line !== undefined ? [{ start: symbol.line, end: symbol.line + 1 }] : [],
      fullFile: false,
      freshness: 'fresh',
      estimatedTokens: 0
    });
  }

  for (const name of input.selectedFiles) {
    const key = normalizeContextPath(name);
    if (!key || seenFiles.has(key)) continue;
    const attachedFile = input.workspaceFiles.find(
      (file) => normalizeContextPath(file.name) === key || file.name === name
    );
    seenFiles.add(key);
    const version = attachedFile
      ? attachedFile.version ?? hashContextContent(attachedFile.content)
      : undefined;
    sources.push({
      path: attachedFile?.name ?? name,
      kind: 'attachment',
      reason: 'attached by the user',
      ranges: [],
      fullFile: true,
      freshness: version ? 'fresh' : 'unknown',
      version,
      estimatedTokens: approxTokens(attachedFile?.content ?? '')
    });
    recordResolved(attachedFile?.name ?? name);
  }

  if (input.activeFile) {
    const key = normalizeContextPath(input.activeFile.name);
    if (key && !seenFiles.has(key)) {
      seenFiles.add(key);
      const version = input.activeFile.version ?? hashContextContent(input.activeFile.content);
      sources.push({
        path: input.activeFile.name,
        kind: 'active',
        reason: 'active editor file',
        ranges: [],
        fullFile: true,
        freshness: version ? 'fresh' : 'unknown',
        version,
        estimatedTokens: approxTokens(input.activeFile.content)
      });
    }
    recordResolved(input.activeFile.name);
  }

  for (const file of input.diskFiles) {
    const key = normalizeContextPath(file.name);
    if (!key || seenFiles.has(key)) continue;
    seenFiles.add(key);
    const version = file.version ?? hashContextContent(file.content);
    sources.push({
      path: file.name,
      kind: 'retrieved',
      reason: 'auto-selected dependency',
      ranges: [],
      fullFile: true,
      freshness: version ? 'fresh' : 'unknown',
      version,
      estimatedTokens: approxTokens(file.content)
    });
    recordResolved(file.name);
  }

  if (input.repoMap) {
    sources.push({
      path: 'repo map',
      kind: 'map',
      reason: 'navigation only — shapes, not source',
      ranges: [],
      fullFile: true,
      freshness: 'fresh',
      estimatedTokens: approxTokens(input.repoMap)
    });
  }

  const targets = dedupeContextPaths([
    ...input.selectedFiles,
    ...input.selectedSymbols.map((symbol) => symbol.file)
  ]);

  return { sources, resolvedPaths, targets };
}
