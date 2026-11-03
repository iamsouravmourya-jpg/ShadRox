import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDesktopBridge, type DesktopDiagnostic, type TsFileOverride } from '../lib/desktop';
import {
  EMPTY_DIAGNOSTICS,
  absolutePathFor,
  compareDiagnostics,
  countDiagnostics,
  findDiagnosticsForFile,
  groupDiagnosticsByFile,
  warnBridgeError,
  type DiagnosticCounts
} from '../lib/diagnostics';

interface UseDiagnosticsOptions {
  /** Bridge present + workspace kind is `folder`. Nothing else calls the bridge. */
  enabled: boolean;
  workspaceId: string | null;
  /** Workspace root, used to resolve the active file's diagnostics. */
  rootPath: string | null;
  /** Unsaved buffers, workspace-relative. Sent with every request. */
  overrides?: TsFileOverride[];
  /** Changing files triggers an immediate refresh. */
  activeFilePath?: string | null;
}

interface DiagnosticsState {
  byFile: Record<string, DesktopDiagnostic[]>;
  truncated: boolean;
  projectFiles: number;
  configPath: string | null;
  isRefreshing: boolean;
}

export interface DiagnosticsController extends DiagnosticCounts {
  /** Diagnostics keyed by the absolute path the bridge returned. */
  byFile: Record<string, DesktopDiagnostic[]>;
  /** Flat list, errors first, for the problems panel. */
  diagnostics: DesktopDiagnostic[];
  truncated: boolean;
  projectFiles: number;
  configPath: string | null;
  isRefreshing: boolean;
  refresh: () => void;
  /** Diagnostics for one workspace-relative file. */
  forFile: (relativePath: string | null | undefined) => DesktopDiagnostic[];
}

const EMPTY_STATE: DiagnosticsState = {
  byFile: {},
  truncated: false,
  projectFiles: 0,
  configPath: null,
  isRefreshing: false
};

const EMPTY_OVERRIDES: TsFileOverride[] = [];
const EDIT_DEBOUNCE_MS = 900;

/**
 * A scoped response only covers the files it was asked about, so the other
 * files keep their previous results. This is what lets typing check one file
 * instead of re-running the whole project.
 */
function mergeScopedDiagnostics(
  previous: Record<string, DesktopDiagnostic[]>,
  next: Record<string, DesktopDiagnostic[]>,
  rootPath: string | null,
  files: string[]
): Record<string, DesktopDiagnostic[]> {
  const scoped = new Set(
    files
      .map((file) => absolutePathFor(rootPath, file))
      .filter((file): file is string => Boolean(file))
      .map((file) => file.toLowerCase())
  );
  const merged: Record<string, DesktopDiagnostic[]> = {};
  for (const [file, list] of Object.entries(previous)) {
    if (!scoped.has(file.toLowerCase())) merged[file] = list;
  }
  return Object.assign(merged, next);
}

/**
 * Owns TypeScript diagnostics from the main-process language service.
 *
 * Requests are tagged with a monotonically increasing id, so a slow response
 * from an older buffer can never overwrite a newer one. Failures are logged
 * once and otherwise swallowed: a broken language service must not take the
 * editor render down with it.
 */
export function useDiagnostics({
  enabled,
  workspaceId,
  rootPath,
  overrides = EMPTY_OVERRIDES,
  activeFilePath
}: UseDiagnosticsOptions): DiagnosticsController {
  const [state, setState] = useState<DiagnosticsState>(EMPTY_STATE);
  const fullRequestIdRef = useRef(0);
  const scopedRequestIdRef = useRef(0);
  const overridesRef = useRef(overrides);
  const mountedRef = useRef(true);
  const workspaceIdRef = useRef(workspaceId);
  overridesRef.current = overrides;
  workspaceIdRef.current = workspaceId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fullRequestIdRef.current += 1;
      scopedRequestIdRef.current += 1;
    };
  }, []);

  const run = useCallback(
    async (onlyFiles?: string[]) => {
      if (!enabled || !workspaceId) return;
      const desktop = getDesktopBridge();
      if (!desktop) return;

      const requestWorkspaceId = workspaceId;
      const scoped = Boolean(onlyFiles && onlyFiles.length > 0);
      const id = scoped
        ? ++scopedRequestIdRef.current
        : ++fullRequestIdRef.current;
      const isStale = () =>
        !mountedRef.current ||
        workspaceIdRef.current !== requestWorkspaceId ||
        (scoped ? id !== scopedRequestIdRef.current : id !== fullRequestIdRef.current);

      setState((previous) => ({ ...previous, isRefreshing: true }));
      try {
        const result = await desktop.diagnostics(workspaceId, overridesRef.current, scoped ? onlyFiles : undefined);
        if (isStale()) return;
        const nextByFile = groupDiagnosticsByFile(result?.diagnostics ?? []);
        setState((previous) => ({
          byFile: scoped && onlyFiles
            ? mergeScopedDiagnostics(previous.byFile, nextByFile, rootPath, onlyFiles)
            : nextByFile,
          truncated: scoped ? previous.truncated : Boolean(result?.truncated),
          projectFiles: result?.projectFiles ?? 0,
          configPath: result?.configPath ?? previous.configPath,
          isRefreshing: false
        }));
      } catch (error) {
        if (isStale()) return;
        warnBridgeError('diagnostics', error);
        setState((previous) => ({ ...previous, isRefreshing: false }));
      }
    },
    [enabled, workspaceId, rootPath]
  );

  // Workspace opened/changed, or diagnostics became available.
  useEffect(() => {
    if (!enabled || !workspaceId) {
      fullRequestIdRef.current += 1;
      scopedRequestIdRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }
    void run();
  }, [enabled, workspaceId, run]);

  // Buffer edits (and switching files, which introduces the only file that
  // needs a fresh check): debounce so a burst of keystrokes produces one
  // single-file request. The full project is rescanned on open, save and the
  // Problems panel's refresh button.
  useEffect(() => {
    if (!enabled || !workspaceId || !activeFilePath) return;
    const timer = window.setTimeout(() => void run([activeFilePath]), EDIT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, workspaceId, overrides, activeFilePath, run]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  const byFile = enabled ? state.byFile : EMPTY_STATE.byFile;
  const diagnostics = useMemo(
    () => Object.values(byFile).flat().sort(compareDiagnostics),
    [byFile]
  );
  const counts = useMemo(() => countDiagnostics(diagnostics), [diagnostics]);
  const forFile = useCallback(
    (relativePath: string | null | undefined) => findDiagnosticsForFile(byFile, rootPath, relativePath),
    [byFile, rootPath]
  );

  return {
    byFile,
    diagnostics: enabled ? diagnostics : EMPTY_DIAGNOSTICS,
    errors: counts.errors,
    warnings: counts.warnings,
    infos: counts.infos,
    truncated: enabled ? state.truncated : false,
    projectFiles: enabled ? state.projectFiles : 0,
    configPath: enabled ? state.configPath : null,
    isRefreshing: enabled ? state.isRefreshing : false,
    refresh,
    forFile
  };
}
