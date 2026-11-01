import type { DesktopDiagnostic, TsFileOverride } from './desktop';
import type { WorkspaceFile } from './types';

/**
 * Helpers shared by the TypeScript language-service surfaces: diagnostics,
 * go-to-definition, outline and workspace symbols. All paths that cross the
 * bridge are either absolute (what the main process returns) or
 * workspace-relative with forward slashes (what it expects back), so this
 * module owns the conversion between the two.
 */

export const EMPTY_DIAGNOSTICS: DesktopDiagnostic[] = [];

const SCRIPT_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs'
]);

const warnedMessages = new Set<string>();

/** Forward slashes everywhere; Windows paths arrive with backslashes. */
export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Absolute path -> workspace-relative path, or null when the file lives outside
 * the workspace root. Comparison is case-insensitive because Windows paths and
 * the TS service can disagree on drive-letter/file-name casing.
 */
export function relativeToRoot(rootPath: string | null | undefined, absolutePath: string): string | null {
  if (!rootPath) return null;
  const root = stripTrailingSlashes(normalizeSlashes(rootPath));
  const absolute = normalizeSlashes(absolutePath);
  if (!root) return null;
  const lowerRoot = root.toLowerCase();
  const lowerAbsolute = absolute.toLowerCase();
  if (lowerAbsolute === lowerRoot) return '';
  if (!lowerAbsolute.startsWith(`${lowerRoot}/`)) return null;
  return absolute.slice(root.length + 1);
}

/** Workspace-relative path -> absolute path using the workspace root. */
export function absolutePathFor(rootPath: string | null | undefined, relativePath: string): string | null {
  if (!rootPath) return null;
  const root = stripTrailingSlashes(normalizeSlashes(rootPath));
  const relative = normalizeSlashes(relativePath).replace(/^\.\//, '');
  if (!root) return null;
  return relative ? `${root}/${relative}` : root;
}

export function baseName(path: string): string {
  return normalizeSlashes(path).split('/').pop() || path;
}

/** True when the TS language service can reasonably provide symbols for it. */
export function isScriptFilePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return SCRIPT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Every open buffer with unsaved content, in the shape the bridge expects.
 * `dirtyFiles` is the workspace hook's baseline diff, so clean buffers are
 * intentionally omitted — the main process already has those on disk.
 */
export function buildTsOverrides(files: WorkspaceFile[], dirtyFiles: string[]): TsFileOverride[] {
  if (dirtyFiles.length === 0) return [];
  const dirty = new Set(dirtyFiles);
  const overrides: TsFileOverride[] = [];
  for (const file of files) {
    if (!dirty.has(file.name)) continue;
    overrides.push({ path: normalizeSlashes(file.name), content: file.content });
  }
  return overrides;
}

/** Group bridge diagnostics by normalized absolute path. */
export function groupDiagnosticsByFile(diagnostics: DesktopDiagnostic[]): Record<string, DesktopDiagnostic[]> {
  const byFile: Record<string, DesktopDiagnostic[]> = {};
  for (const diagnostic of diagnostics) {
    if (!diagnostic?.file) continue;
    const key = normalizeSlashes(diagnostic.file);
    (byFile[key] ??= []).push(diagnostic);
  }
  return byFile;
}

/**
 * Diagnostics for one workspace-relative file. Falls back to a
 * case-insensitive scan so a drive-letter/casing difference cannot silently
 * hide squiggles.
 */
export function findDiagnosticsForFile(
  byFile: Record<string, DesktopDiagnostic[]>,
  rootPath: string | null | undefined,
  relativePath: string | null | undefined
): DesktopDiagnostic[] {
  if (!relativePath) return EMPTY_DIAGNOSTICS;
  const target = absolutePathFor(rootPath, relativePath);
  if (!target) return EMPTY_DIAGNOSTICS;
  const exact = byFile[target];
  if (exact) return exact;
  const lower = target.toLowerCase();
  for (const key of Object.keys(byFile)) {
    if (normalizeSlashes(key).toLowerCase() === lower) return byFile[key];
  }
  return EMPTY_DIAGNOSTICS;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiagnostics(diagnostics: DesktopDiagnostic[]): DiagnosticCounts {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1;
    else if (diagnostic.severity === 'warning') warnings += 1;
    else infos += 1;
  }
  return { errors, warnings, infos };
}

export function severityRank(severity: DesktopDiagnostic['severity']): number {
  if (severity === 'error') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

/** Errors first, then by position — the order the problems list presents. */
export function compareDiagnostics(a: DesktopDiagnostic, b: DesktopDiagnostic): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    a.line - b.line ||
    a.character - b.character
  );
}

/**
 * The bridge swallows nothing; the renderer does. A failing language service
 * must never become a render error, and an identical failure on every keystroke
 * must not flood the console.
 */
export function warnBridgeError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${scope}:${message}`;
  if (warnedMessages.has(key)) return;
  warnedMessages.add(key);
  console.warn(`[shadrox] ${scope} failed: ${message}`);
}

/** Human label for a diagnostic code (`TS2322: ...` in lint hovers). */
export function formatDiagnosticMessage(diagnostic: DesktopDiagnostic): string {
  const code = diagnostic.code?.trim();
  return code ? `${code}: ${diagnostic.message}` : diagnostic.message;
}
