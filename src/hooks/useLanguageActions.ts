import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DefinitionNavigation,
  EditorQuickFixActions,
  EditorSymbolActions,
  RenameOutcome
} from '../components/CodeEditor';
import type { CodeAction, OutlineSymbol, ReferenceLocation, ShadRoxDesktopAPI, WorkspaceTextEdit } from '../lib/desktop';
import { normalizeSlashes, relativeToRoot, warnBridgeError } from '../lib/diagnostics';
import { groupEditsByFile, planFileEdits } from '../lib/editor/edits';
import { symbolAt } from '../lib/editor/references';
import type { ReplacePlan } from '../lib/editor/searchReplace';
import { clearFimCache, fimIdentity } from '../lib/fimClient';
import { findElementLine, type RevealSourceTarget } from '../lib/previewSource';
import type { ProviderId } from '../lib/providers';
import type { useWorkspace } from './useWorkspace';

export interface RevealTarget {
  name: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  nonce: number;
}

export interface UseLanguageActionsOptions {
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  workspace: ReturnType<typeof useWorkspace>;
  activeFilePath: string | null;
  outlineEnabled: boolean;
  diagnosticsOverrides: Array<{ path: string; content: string }>;
  saveFilesAtomicWithHooks: (names: string[]) => Promise<{ written: number; failed: boolean; message: string | null }>;
  byok: {
    activeProvider: ProviderId;
    baseUrl: string;
    selectedModel: string;
    activeKey: string;
    temperature: number;
  };
  setIsPreviewFullscreen: (open: boolean) => void;
  setIsPreviewOpen: (open: boolean) => void;
  setQuickOpenMode: (mode: 'files' | 'content' | 'commands' | null) => void;
}

export function useLanguageActions({
  desktop,
  nativeWorkspaceId,
  workspace,
  activeFilePath,
  outlineEnabled,
  diagnosticsOverrides,
  saveFilesAtomicWithHooks,
  byok,
  setIsPreviewFullscreen,
  setIsPreviewOpen,
  setQuickOpenMode
}: UseLanguageActionsOptions) {
  const [references, setReferences] = useState<ReferenceLocation[] | null>(null);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesSymbol, setReferencesSymbol] = useState<string | null>(null);
  const referencesRequestId = useRef(0);
  const [revealTarget, setRevealTarget] = useState<RevealTarget | null>(null);

  const [inlineCompletion, setInlineCompletion] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('shadrox.inlineCompletion') !== 'off';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    referencesRequestId.current += 1;
    setReferences(null);
    setReferencesLoading(false);
    setReferencesSymbol(null);
  }, [nativeWorkspaceId]);

  const handleQuickOpenFile = useCallback((index: number) => {
    setIsPreviewFullscreen(false);
    setIsPreviewOpen(false);
    workspace.selectFile(index);
    setQuickOpenMode(null);
  }, [workspace, setIsPreviewFullscreen, setIsPreviewOpen, setQuickOpenMode]);

  const navigateToPath = useCallback(
    async (path: string, line?: number, column?: number, endLine?: number, endColumn?: number) => {
      setIsPreviewFullscreen(false);
      setIsPreviewOpen(false);
      const relative = normalizeSlashes(path);
      const index = workspace.files.findIndex((file) => file.name.toLowerCase() === relative.toLowerCase());
      const name = index >= 0 ? workspace.files[index].name : relative;
      if (index >= 0) workspace.selectFile(index);
      else await workspace.openFile(name);
      if (typeof line === 'number') {
        setRevealTarget({ name, line, column, endLine, endColumn, nonce: Date.now() });
      }
    },
    [workspace, setIsPreviewFullscreen, setIsPreviewOpen]
  );

  const handleOpenSearchHit = useCallback(
    async (path: string, line?: number, column?: number) => {
      setQuickOpenMode(null);
      await navigateToPath(path, line, column);
    },
    [navigateToPath, setQuickOpenMode]
  );

  const handleQuickReplaceAll = useCallback(
    async (plans: ReplacePlan[]): Promise<string> => {
      if (!workspace.canWriteToDisk) return 'This workspace is read-only, so nothing was replaced.';
      const currentFiles = await workspace.loadFilesForPatching(plans.map((plan) => plan.file));
      const currentByPath = new Map(
        currentFiles.map((file) => [file.name.replace(/\\/g, '/').toLowerCase(), file])
      );
      const missing = plans.find(
        (plan) => !currentByPath.has(plan.file.replace(/\\/g, '/').toLowerCase())
      );
      if (missing) return `Could not read ${missing.file}; nothing was replaced.`;
      const changed = plans.find((plan) => {
        const current = currentByPath.get(plan.file.replace(/\\/g, '/').toLowerCase());
        return current?.content !== plan.original;
      });
      if (changed) return `${changed.file} changed after the preview; search again before replacing.`;

      const buffers = workspace.applyFilePatches(plans.map((plan) => ({ path: plan.file, content: plan.content })));
      const names = [...buffers.updated, ...buffers.created];
      if (names.length === 0) return 'Nothing changed — the files already match.';
      const saved = await saveFilesAtomicWithHooks(names);
      const total = plans.reduce((sum, plan) => sum + plan.replacements, 0);
      const fileCount = plans.length;
      const summary = `${total} replacement${total === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`;
      if (saved.failed) return `${summary} — save manually (${saved.message ?? 'disk write failed'})`;
      return `${summary} applied`;
    },
    [workspace, saveFilesAtomicWithHooks]
  );

  const handleRevealSource = useCallback(
    async (target: RevealSourceTarget) => {
      const relative = normalizeSlashes(target.path);
      let content = workspace.files.find((file) => file.name.toLowerCase() === relative.toLowerCase())?.content;
      if (content === undefined && desktop && nativeWorkspaceId) {
        try {
          content = (await desktop.readFile(nativeWorkspaceId, relative)).content;
        } catch (error) {
          warnBridgeError('preview-reveal', error);
          return;
        }
      }
      if (content === undefined) return;
      const location = findElementLine(content, target);
      await navigateToPath(
        relative,
        location ? location.line + 1 : undefined,
        location ? location.character + 1 : undefined
      );
    },
    [workspace.files, desktop, nativeWorkspaceId, navigateToPath]
  );

  const handleDefinitionRequest = useCallback(
    async (line: number, character: number): Promise<DefinitionNavigation | null> => {
      const rootPath = workspace.workspace?.path;
      if (!desktop || !nativeWorkspaceId || workspace.workspace?.kind !== 'folder' || !rootPath || !workspace.activeFile) {
        return null;
      }
      const activeName = workspace.activeFile.name;
      try {
        const results = await desktop.definition(nativeWorkspaceId, activeName, line, character, diagnosticsOverrides);
        const first = results?.[0];
        if (!first) return null;
        const relative = relativeToRoot(rootPath, first.file);
        if (!relative) return null;
        const index = workspace.files.findIndex((file) => file.name.toLowerCase() === relative.toLowerCase());
        const targetName = index >= 0 ? workspace.files[index].name : normalizeSlashes(relative);
        if (targetName.toLowerCase() === activeName.toLowerCase()) {
          return {
            line: first.line,
            character: first.character,
            endLine: first.endLine,
            endCharacter: first.endCharacter
          };
        }
        await navigateToPath(
          targetName,
          first.line + 1,
          first.character + 1,
          first.endLine + 1,
          first.endCharacter + 1
        );
        return null;
      } catch (error) {
        warnBridgeError('definition', error);
        return null;
      }
    },
    [
      desktop,
      nativeWorkspaceId,
      workspace.workspace?.kind,
      workspace.workspace?.path,
      workspace.activeFile,
      workspace.files,
      diagnosticsOverrides,
      navigateToPath
    ]
  );

  const handleSelectOutlineSymbol = useCallback(
    (symbol: OutlineSymbol) => {
      if (!activeFilePath) return;
      setRevealTarget({
        name: activeFilePath,
        line: symbol.line + 1,
        column: symbol.character + 1,
        nonce: Date.now()
      });
    },
    [activeFilePath]
  );

  const toggleInlineCompletion = useCallback(() => {
    setInlineCompletion((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem('shadrox.inlineCompletion', next ? 'on' : 'off');
      } catch {
        /* localStorage unavailable */
      }
      return next;
    });
  }, []);

  const editorAi = useMemo(
    () => ({
      provider: byok.activeProvider,
      baseUrl: byok.baseUrl,
      model: byok.selectedModel,
      apiKey: byok.activeKey,
      completionEnabled: inlineCompletion && Boolean(byok.activeKey),
      onToggleCompletion: toggleInlineCompletion,
      temperature: byok.temperature,
      hasCredential: Boolean(byok.activeKey)
    }),
    [
      byok.activeProvider,
      byok.baseUrl,
      byok.selectedModel,
      byok.activeKey,
      byok.temperature,
      inlineCompletion,
      toggleInlineCompletion
    ]
  );

  const fimIdentityKey = useMemo(
    () =>
      fimIdentity({
        provider: byok.activeProvider,
        baseUrl: byok.baseUrl,
        model: byok.selectedModel,
        apiKey: byok.activeKey
      }),
    [byok.activeProvider, byok.baseUrl, byok.selectedModel, byok.activeKey]
  );

  useEffect(() => {
    clearFimCache();
  }, [fimIdentityKey]);

  const closeReferences = useCallback(() => {
    referencesRequestId.current += 1;
    setReferences(null);
    setReferencesLoading(false);
    setReferencesSymbol(null);
  }, []);

  const handleFindReferences = useCallback(
    (line: number, character: number) => {
      const rootPath = workspace.workspace?.path;
      const activeFile = workspace.activeFile;
      if (
        !desktop ||
        !nativeWorkspaceId ||
        workspace.workspace?.kind !== 'folder' ||
        !rootPath ||
        !activeFile
      ) {
        return;
      }
      const requestId = ++referencesRequestId.current;
      setReferences([]);
      setReferencesLoading(true);
      setReferencesSymbol(symbolAt(activeFile.content, line, character) || null);
      void desktop
        .references(nativeWorkspaceId, activeFile.name, line, character, diagnosticsOverrides)
        .then((results) => {
          if (requestId !== referencesRequestId.current) return;
          const relative = (results ?? [])
            .map((reference) => {
              const path = relativeToRoot(rootPath, reference.file);
              return path ? { ...reference, file: normalizeSlashes(path) } : null;
            })
            .filter((reference): reference is ReferenceLocation => reference !== null);
          setReferences(relative);
          setReferencesLoading(false);
        })
        .catch((error) => {
          if (requestId !== referencesRequestId.current) return;
          warnBridgeError('references', error);
          setReferences([]);
          setReferencesLoading(false);
        });
    },
    [
      desktop,
      nativeWorkspaceId,
      workspace.workspace?.kind,
      workspace.workspace?.path,
      workspace.activeFile,
      diagnosticsOverrides
    ]
  );

  const handleSelectReference = useCallback(
    (reference: ReferenceLocation) => {
      void navigateToPath(reference.file, reference.line + 1, reference.character + 1);
    },
    [navigateToPath]
  );

  const applyLanguageServiceEdits = useCallback(
    async (edits: WorkspaceTextEdit[]): Promise<RenameOutcome> => {
      const rootPath = workspace.workspace?.path;
      if (!desktop || !nativeWorkspaceId || workspace.workspace?.kind !== 'folder' || !rootPath) {
        return { ok: false, message: 'This action needs a folder workspace open in the desktop app.' };
      }
      if (!workspace.canWriteToDisk) {
        return { ok: false, message: 'This workspace is read-only, so the change could not be saved.' };
      }

      const relativeEdits: WorkspaceTextEdit[] = [];
      for (const edit of edits) {
        const path = relativeToRoot(rootPath, edit.file);
        if (!path) continue;
        relativeEdits.push({ ...edit, file: normalizeSlashes(path) });
      }
      if (relativeEdits.length === 0) {
        return { ok: false, message: 'The language service found nothing to change.' };
      }

      const contents = new Map<string, string>();
      for (const file of groupEditsByFile(relativeEdits).keys()) {
        const key = file.toLowerCase();
        const open = workspace.files.find((candidate) => candidate.name.toLowerCase() === key);
        if (open) {
          contents.set(key, open.content);
          continue;
        }
        try {
          contents.set(key, (await desktop.readFile(nativeWorkspaceId, file)).content);
        } catch (error) {
          warnBridgeError('edit-read', error);
        }
      }

      const plans = planFileEdits(relativeEdits, (file) => contents.get(file.toLowerCase()) ?? null);
      if (plans.length === 0) {
        return { ok: false, message: 'Nothing changed — the code already matches.' };
      }

      const buffers = workspace.applyFilePatches(plans.map((plan) => ({ path: plan.file, content: plan.content })));
      const names = [...buffers.updated, ...buffers.created];
      const saved = names.length > 0
        ? await saveFilesAtomicWithHooks(names)
        : { written: 0, failed: false, message: null as string | null };

      const count = plans.length;
      const fileLabel = `${count} file${count === 1 ? '' : 's'}`;
      if (saved.failed) {
        return { ok: true, message: `updated ${fileLabel} — save manually (${saved.message ?? 'disk write failed'})` };
      }
      if (saved.written > 0 && buffers.created.length > 0) {
        for (const directory of new Set(buffers.created.map((path) => path.split('/').slice(0, -1).join('/')))) {
          void workspace.loadDirectory(directory);
        }
      }
      return { ok: true, message: `updated ${fileLabel}` };
    },
    [
      desktop,
      nativeWorkspaceId,
      workspace,
      saveFilesAtomicWithHooks
    ]
  );

  const handleRenameSymbol = useCallback(
    async (line: number, character: number, newName: string): Promise<RenameOutcome> => {
      const activeFile = workspace.activeFile;
      if (!desktop || !nativeWorkspaceId || workspace.workspace?.kind !== 'folder' || !activeFile) {
        return { ok: false, message: 'Renaming needs a folder workspace open in the desktop app.' };
      }

      try {
        const result = await desktop.rename(
          nativeWorkspaceId,
          activeFile.name,
          line,
          character,
          newName,
          diagnosticsOverrides
        );
        if (!result.canRename) {
          return { ok: false, message: result.reason ?? 'That position is not a symbol that can be renamed.' };
        }

        const outcome = await applyLanguageServiceEdits(result.edits);
        if (!outcome.ok) return outcome;
        const symbolName = result.displayName || newName;
        return { ok: true, message: `Renamed "${symbolName}" — ${outcome.message}` };
      } catch (error) {
        warnBridgeError('rename', error);
        return { ok: false, message: error instanceof Error ? error.message : 'Rename failed.' };
      }
    },
    [desktop, nativeWorkspaceId, workspace.workspace?.kind, workspace.activeFile, applyLanguageServiceEdits, diagnosticsOverrides]
  );

  const requestCodeActions = useCallback(
    async (
      relativePath: string,
      line: number,
      character: number,
      endLine: number,
      endCharacter: number
    ): Promise<CodeAction[]> => {
      if (!desktop || !nativeWorkspaceId || workspace.workspace?.kind !== 'folder') return [];
      try {
        return await desktop.codeActions(
          nativeWorkspaceId,
          relativePath,
          line,
          character,
          endLine,
          endCharacter,
          diagnosticsOverrides
        );
      } catch (error) {
        warnBridgeError('code-actions', error);
        return [];
      }
    },
    [desktop, nativeWorkspaceId, workspace.workspace?.kind, diagnosticsOverrides]
  );

  const handleRequestQuickFixes = useCallback(
    (line: number, character: number, endLine: number, endCharacter: number): Promise<CodeAction[]> => {
      const activeFile = workspace.activeFile;
      if (!activeFile) return Promise.resolve([]);
      return requestCodeActions(activeFile.name, line, character, endLine, endCharacter);
    },
    [workspace.activeFile, requestCodeActions]
  );

  const handleApplyQuickFix = useCallback(
    async (action: CodeAction): Promise<string> => {
      if (action.changes.length === 0) return 'That fix had no changes to apply.';
      const outcome = await applyLanguageServiceEdits(action.changes);
      if (!outcome.ok) return outcome.message;
      return `${action.description} — ${outcome.message}`;
    },
    [applyLanguageServiceEdits]
  );

  const editorSymbols = useMemo<EditorSymbolActions | undefined>(() => {
    if (!outlineEnabled) return undefined;
    return {
      available: true,
      references,
      referencesLoading,
      referencesError: null,
      referencesSymbol,
      onFindReferences: handleFindReferences,
      onSelectReference: handleSelectReference,
      onCloseReferences: closeReferences,
      onRename: handleRenameSymbol
    };
  }, [
    outlineEnabled,
    references,
    referencesLoading,
    referencesSymbol,
    handleFindReferences,
    handleSelectReference,
    closeReferences,
    handleRenameSymbol
  ]);

  const editorQuickFixes = useMemo<EditorQuickFixActions | undefined>(() => {
    if (!outlineEnabled) return undefined;
    return {
      available: true,
      onRequestFixes: handleRequestQuickFixes,
      onApplyFix: handleApplyQuickFix
    };
  }, [outlineEnabled, handleRequestQuickFixes, handleApplyQuickFix]);

  return {
    revealTarget,
    setRevealTarget,
    handleQuickOpenFile,
    navigateToPath,
    handleOpenSearchHit,
    handleQuickReplaceAll,
    handleRevealSource,
    handleDefinitionRequest,
    handleSelectOutlineSymbol,
    editorAi,
    editorSymbols,
    editorQuickFixes,
    requestCodeActions,
    handleApplyQuickFix
  };
}
