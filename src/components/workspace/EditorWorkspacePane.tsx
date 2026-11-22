import { Suspense, type ReactNode } from 'react';
import { AlertCircle, FolderOpen } from 'lucide-react';
import {
  CodeEditor,
  type DefinitionNavigation,
  type EditorQuickFixActions,
  type EditorSymbolActions
} from '../CodeEditor';
import { DebugPanel } from '../DebugPanel';
import { TerminalPanel } from '../TerminalPanel';
import type { useDebug } from '../../hooks/useDebug';
import type { RevealTarget } from '../../hooks/useLanguageActions';
import type { useOutline } from '../../hooks/useOutline';
import type { useWorkspace } from '../../hooks/useWorkspace';
import type { ConflictChoice } from '../../lib/conflicts';
import type { ConflictHunk } from '../../lib/conflicts';
import type { DesktopDiagnostic, OutlineSymbol, SemanticToken, ShadRoxDesktopAPI } from '../../lib/desktop';
import type { ProviderId } from '../../lib/providers';

export interface EditorWorkspacePaneProps {
  isPreviewOpen: boolean;
  isPreviewFullscreen: boolean;
  previewPane: ReactNode;
  workspace: ReturnType<typeof useWorkspace>;
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  conflictHunks: ConflictHunk[];
  unmergedPaths: string[];
  onResolveConflicts: (choice: ConflictChoice) => void;
  onBackToHub: () => void;
  onNewFile: () => void;
  onSaveAll: () => void;
  revealTarget: RevealTarget | null;
  editorAi: {
    provider: ProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    completionEnabled: boolean;
    onToggleCompletion: () => void;
    temperature: number;
    hasCredential: boolean;
  };
  activeDiagnostics: DesktopDiagnostic[];
  onDefinitionRequest: (line: number, character: number) => Promise<DefinitionNavigation | null>;
  activeSemanticTokens: SemanticToken[];
  outlineEnabled: boolean;
  outline: ReturnType<typeof useOutline>;
  onSelectOutlineSymbol: (symbol: OutlineSymbol) => void;
  editorSymbols: EditorSymbolActions | undefined;
  editorQuickFixes: EditorQuickFixActions | undefined;
  debug: ReturnType<typeof useDebug>;
  debugBreakpointsEnabled: boolean;
  debugPausedAt: { file: string; line: number; column?: number } | null;
  onNavigateToPath: (path: string, line?: number, column?: number) => void;
  sidebarPanel: ReactNode;
  isDebugPanelOpen: boolean;
  onCloseDebugPanel: () => void;
  onAskAiToDebug: (summary: string) => void;
  isTerminalOpen: boolean;
  terminalAvailable: boolean;
  onCloseTerminal: () => void;
}

export function EditorWorkspacePane({
  isPreviewOpen,
  isPreviewFullscreen,
  previewPane,
  workspace,
  desktop,
  nativeWorkspaceId,
  conflictHunks,
  unmergedPaths,
  onResolveConflicts,
  onBackToHub,
  onNewFile,
  onSaveAll,
  revealTarget,
  editorAi,
  activeDiagnostics,
  onDefinitionRequest,
  activeSemanticTokens,
  outlineEnabled,
  outline,
  onSelectOutlineSymbol,
  editorSymbols,
  editorQuickFixes,
  debug,
  debugBreakpointsEnabled,
  debugPausedAt,
  onNavigateToPath,
  sidebarPanel,
  isDebugPanelOpen,
  onCloseDebugPanel,
  onAskAiToDebug,
  isTerminalOpen,
  terminalAvailable,
  onCloseTerminal
}: EditorWorkspacePaneProps) {
  return (
    <div className="order-2 flex-1 min-w-0 min-h-0 flex flex-col">
      {isPreviewOpen ? (
        isPreviewFullscreen ? (
          <div className="flex-1 min-h-0" />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">{previewPane}</div>
        )
      ) : (
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {workspace.files.length === 0 && workspace.workspace?.kind !== 'folder' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <div className="grid size-12 place-items-center rounded-2xl border border-line-2 bg-overlay">
                <FolderOpen className="w-5 h-5 text-accent" />
              </div>
              <p className="mt-3 text-xs text-ink-3">No files open in workspace.</p>
              <button
                type="button"
                onClick={onBackToHub}
                className="mt-3 text-[11px] text-accent hover:text-accent cursor-pointer"
              >
                Open folder or files
              </button>
            </div>
          ) : (
            <>
              {conflictHunks.length > 0 && (
                <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {conflictHunks.length} merge conflict{conflictHunks.length === 1 ? '' : 's'} in{' '}
                    <span className="font-mono">{workspace.activeFile?.name}</span>
                    {unmergedPaths.length > 1 ? ` · ${unmergedPaths.length} files unmerged in git` : ''}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {(['ours', 'theirs', 'both'] as ConflictChoice[]).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        onClick={() => onResolveConflicts(choice)}
                        className="rounded border border-warn/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-warn transition-colors hover:bg-warn/20 cursor-pointer"
                      >
                        {choice === 'both' ? 'Both' : choice === 'ours' ? 'Ours' : 'Theirs'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className={`flex-1 min-w-0 min-h-0 ${workspace.editorGroups.length > 1 ? 'flex flex-row' : 'flex flex-col'}`}>
                {workspace.editorGroups.map((group, groupIndex) => {
                  const groupActiveIndex = group.activePath
                    ? workspace.files.findIndex((file) => file.name === group.activePath)
                    : -1;
                  const tabIndices = group.tabs
                    .map((path) => workspace.files.findIndex((file) => file.name === path))
                    .filter((index) => index >= 0);
                  return (
                    <CodeEditor
                      key={`editor-group-${groupIndex}`}
                      files={workspace.files}
                      activeFileIndex={groupActiveIndex}
                      activeFilePath={group.activePath}
                      visibleTabIndices={tabIndices}
                      editorGroupIndex={groupIndex}
                      editorGroupCount={workspace.editorGroups.length}
                      pinnedTabs={group.pinnedTabs}
                      hideSidebar={groupIndex > 0}
                      dirtyFiles={workspace.dirtyFiles}
                      canWriteToDisk={workspace.canWriteToDisk}
                      isSaving={workspace.isSaving}
                      onSelectFile={(index) => workspace.selectFile(index, groupIndex)}
                      onFocusGroup={workspace.focusEditorGroup}
                      onSplitEditor={workspace.splitEditor}
                      onCloseEditorGroup={workspace.closeEditorGroup}
                      onReorderTabs={workspace.reorderEditorTabs}
                      onTogglePinnedTab={workspace.togglePinnedTab}
                      onCloseFile={workspace.closeFile}
                      onCloseTab={workspace.closeTab}
                      onChangeContent={workspace.updateActiveContent}
                      onDeleteFile={workspace.deleteFile}
                      onNewFile={onNewFile}
                      onCreateDirectory={workspace.createDirectory}
                      onDeleteEntry={workspace.deleteWorkspaceEntry}
                      onSaveAll={onSaveAll}
                      onRenameFile={(from, to) => void workspace.renameFile(from, to)}
                      onRevertFile={() => void workspace.revertActiveFile()}
                      revealTarget={revealTarget}
                      workspaceName={workspace.workspace?.name}
                      workspaceKind={workspace.workspace?.kind}
                      diskFileCount={workspace.workspace?.diskFileCount}
                      diskFileCountTruncated={workspace.workspace?.diskFileCountTruncated}
                      nativeDirectoryPages={workspace.workspace?.kind === 'folder' ? workspace.directoryPages : undefined}
                      loadingDirectories={workspace.loadingDirectories}
                      onLoadDirectory={(path, cursor) => void workspace.loadDirectory(path, cursor)}
                      onOpenPath={(path) => void workspace.openFile(path, groupIndex)}
                      editorAi={editorAi}
                      diagnostics={workspace.activeEditorGroup === groupIndex ? activeDiagnostics : []}
                      onDefinitionRequest={onDefinitionRequest}
                      semanticTokens={workspace.activeEditorGroup === groupIndex ? activeSemanticTokens : []}
                      outlineAvailable={outlineEnabled}
                      outlineSymbols={outline.symbols}
                      isOutlineLoading={outline.isLoading}
                      outlineError={outline.error}
                      onSelectOutlineSymbol={onSelectOutlineSymbol}
                      symbols={editorSymbols}
                      quickFixes={editorQuickFixes}
                      breakpoints={{
                        enabled: debugBreakpointsEnabled,
                        lines: group.activePath ? debug.breakpoints[group.activePath] : undefined,
                        onToggle: (line) => {
                          if (group.activePath) void debug.toggleBreakpoint(group.activePath, line);
                        }
                      }}
                      pausedAt={groupIndex === 0 ? debugPausedAt : null}
                      onOpenPaused={(file, line, column) => onNavigateToPath(file, line, column ?? undefined)}
                      debugHover={groupIndex === 0 && debug.state.status === 'stopped' && debug.selectedFrame
                        ? {
                            enabled: true,
                            evaluate: (expression) => debug.selectedFrame
                              ? debug.evaluate(debug.selectedFrame.id, expression)
                              : Promise.resolve(null)
                          }
                        : undefined}
                      sidebarPanel={groupIndex === 0 ? sidebarPanel : undefined}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
      {isDebugPanelOpen && desktop && nativeWorkspaceId && (
        <div className="h-64 shrink-0 border-t border-line">
          <DebugPanel
            desktop={desktop}
            workspaceId={nativeWorkspaceId}
            controller={debug}
            onOpenFrame={(file, line, column) => onNavigateToPath(file, line, column)}
            onAskAiToDebug={onAskAiToDebug}
            onClose={onCloseDebugPanel}
          />
        </div>
      )}
      {isTerminalOpen && terminalAvailable && desktop && nativeWorkspaceId && (
        <div className="h-56 shrink-0 border-t border-line">
          <Suspense fallback={<div className="h-full bg-base px-3 py-2 text-xs text-ink-4">Loading terminal…</div>}>
            <TerminalPanel
              key={nativeWorkspaceId}
              desktop={desktop}
              workspaceId={nativeWorkspaceId}
              workspaceName={workspace.workspace?.name ?? 'Workspace'}
              onClose={onCloseTerminal}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
