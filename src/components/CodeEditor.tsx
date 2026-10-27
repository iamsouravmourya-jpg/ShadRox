import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  search,
  SearchQuery,
  setSearchQuery
} from '@codemirror/search';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  FilePlus,
  Folder,
  FolderOpen,
  FolderTree,
  Loader2,
  Pencil,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
  Zap
} from 'lucide-react';
import { copyToClipboard, downloadFile, downloadWorkspaceZip, estimateTokens, formatCode } from '../lib/toolUtils';
import { getLanguageExtension } from '../lib/languages';
import { ghostText } from '../lib/ghostText';
import { runQuickEdit, sliceQuickEditContext } from '../lib/quickEdit';
import type { ProviderId } from '../lib/providers';
import type { WorkspaceFile } from '../lib/types';
import type { DirectoryPage } from '../lib/desktop';

interface CodeEditorProps {
  files: WorkspaceFile[];
  activeFileIndex: number;
  dirtyFiles: string[];
  canWriteToDisk: boolean;
  isSaving: boolean;
  onSelectFile: (index: number) => void;
  onCloseFile: () => void;
  onCloseTab: (index: number) => void;
  onChangeContent: (content: string) => void;
  onDeleteFile: (index: number) => void;
  onNewFile: () => void;
  onSaveAll: () => void;
  onRenameFile: (from: string, to: string) => void;
  onRevertFile: () => void;
  revealTarget?: { name: string; line: number; column?: number; nonce: number } | null;
  workspaceName?: string;
  nativeDirectoryPages?: Record<string, DirectoryPage>;
  loadingDirectories?: string[];
  onLoadDirectory?: (path: string, cursor?: number) => void;
  onOpenPath?: (path: string) => void;
  editorAi?: EditorAiConfig | null;
}

/** BYOK settings the editor spends on inline AI work (tab completion, Ctrl+K). */
export interface EditorAiConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  completionEnabled: boolean;
  onToggleCompletion: () => void;
}

interface QuickEditTarget {
  from: number;
  to: number;
  top: number;
  left: number;
}

interface ExplorerFile {
  file: WorkspaceFile;
  index: number;
}

interface ExplorerFolder {
  name: string;
  path: string;
  folders: ExplorerFolder[];
  files: ExplorerFile[];
}

function buildExplorerTree(files: WorkspaceFile[], filter: string): ExplorerFolder {
  const root: ExplorerFolder = { name: '', path: '', folders: [], files: [] };
  const folders = new Map<string, ExplorerFolder>([['', root]]);
  const query = filter.trim().toLowerCase();

  files.forEach((file, index) => {
    if (query && !file.name.toLowerCase().includes(query)) return;
    const segments = file.name.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) return;

    let parent = root;
    let parentPath = '';
    for (const segment of segments) {
      const folderPath = parentPath ? `${parentPath}/${segment}` : segment;
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { name: segment, path: folderPath, folders: [], files: [] };
        folders.set(folderPath, folder);
        parent.folders.push(folder);
      }
      parent = folder;
      parentPath = folderPath;
    }
    parent.files.push({ file, index });
  });

  const sort = (folder: ExplorerFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.file.name.localeCompare(b.file.name));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function CodeEditor({
  files,
  activeFileIndex,
  dirtyFiles,
  canWriteToDisk,
  isSaving,
  onSelectFile,
  onCloseFile,
  onCloseTab,
  onChangeContent,
  onDeleteFile,
  onNewFile,
  onSaveAll,
  onRenameFile,
  onRevertFile,
  revealTarget,
  workspaceName,
  nativeDirectoryPages,
  loadingDirectories = [],
  onLoadDirectory,
  onOpenPath,
  editorAi
}: CodeEditorProps) {
  const activeFile = files[activeFileIndex] ?? files[0] ?? null;
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['']));
  const [hasCopied, setHasCopied] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [quickEdit, setQuickEdit] = useState<QuickEditTarget | null>(null);
  const [quickEditPrompt, setQuickEditPrompt] = useState('');
  const [isQuickEditing, setIsQuickEditing] = useState(false);
  const [quickEditError, setQuickEditError] = useState<string | null>(null);
  const quickEditAbort = useRef<AbortController | null>(null);

  const dirty = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);
  const filePathSignature = useMemo(() => files.map((file) => file.name).join('\n'), [files]);
  const explorerTree = useMemo(() => buildExplorerTree(files, fileFilter), [files, fileFilter]);
  const allFoldersExpanded = fileFilter.trim().length > 0;

  useEffect(() => {
    const firstLevel = new Set(['', ...files
      .map((file) => file.name.split('/').filter(Boolean).slice(0, 1)[0])
      .filter((name): name is string => Boolean(name) && files.some((file) => file.name.startsWith(`${name}/`)))]);
    setExpandedFolders(firstLevel);
  }, [workspaceName, filePathSignature]);

  const extensions = useMemo(() => {
    const list: Extension[] = [search({ top: true })];
    if (activeFile) {
      const ext = getLanguageExtension(activeFile.name, activeFile.language);
      if (ext) list.push(ext);
    }
    if (editorAi?.completionEnabled) {
      list.push(
        ghostText({
          provider: editorAi.provider,
          model: editorAi.model,
          apiKey: editorAi.apiKey,
          language: activeFile?.language
        })
      );
    }
    if (editorAi) {
      list.push(
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'k') return false;
            event.preventDefault();
            const range = view.state.selection.main;
            const caret = view.coordsAtPos(range.from);
            const box = view.dom.getBoundingClientRect();
            setQuickEditError(null);
            setQuickEditPrompt('');
            setQuickEdit({
              from: range.from,
              to: range.to,
              top: Math.max(6, (caret?.bottom ?? box.top + 22) - box.top + 6),
              left: Math.min(Math.max(6, (caret?.left ?? box.left + 12) - box.left), Math.max(6, box.width - 340))
            });
            return true;
          }
        })
      );
    }
    return list;
  }, [activeFile?.name, activeFile?.language, editorAi]);

  // Ctrl+K edits are scoped to the open buffer; switching files drops the bubble.
  useEffect(() => {
    quickEditAbort.current?.abort();
    quickEditAbort.current = null;
    setQuickEdit(null);
    setQuickEditError(null);
    setIsQuickEditing(false);
  }, [activeFile?.name]);

  const closeQuickEdit = useCallback(() => {
    quickEditAbort.current?.abort();
    quickEditAbort.current = null;
    setIsQuickEditing(false);
    setQuickEdit(null);
  }, []);

  const applyQuickEdit = useCallback(async () => {
    const view = editorRef.current?.view;
    const instruction = quickEditPrompt.trim();
    if (!view || !activeFile || !editorAi || !quickEdit || !instruction || isQuickEditing) return;

    setIsQuickEditing(true);
    setQuickEditError(null);
    const controller = new AbortController();
    quickEditAbort.current = controller;

    try {
      const doc = view.state.doc;
      // A bare caret edits the whole line, the same fallback Void uses.
      const caretOnly = quickEdit.from === quickEdit.to;
      const line = doc.lineAt(quickEdit.from);
      const from = caretOnly ? line.from : quickEdit.from;
      const to = caretOnly ? line.to : quickEdit.to;
      const context = sliceQuickEditContext(
        doc.toString(),
        from,
        to,
        instruction,
        activeFile.name,
        activeFile.language
      );
      const replacement = await runQuickEdit(
        context,
        { provider: editorAi.provider, model: editorAi.model, apiKey: editorAi.apiKey },
        controller.signal
      );
      view.dispatch({
        changes: { from, to, insert: replacement },
        selection: { anchor: from + replacement.length },
        userEvent: 'input.replace'
      });
      setQuickEdit(null);
      setQuickEditPrompt('');
      setToastMsg('Quick edit applied · Ctrl+Z to undo');
      window.setTimeout(() => setToastMsg(null), 3500);
    } catch (error) {
      if (!controller.signal.aborted) {
        setQuickEditError(error instanceof Error ? error.message : 'Quick edit failed.');
      }
    } finally {
      quickEditAbort.current = null;
      setIsQuickEditing(false);
    }
  }, [activeFile, editorAi, isQuickEditing, quickEdit, quickEditPrompt]);

  const runSearch = (term: string) => {
    const view = editorRef.current?.view;
    if (!view) return;
    if (!term) {
      closeSearchPanel(view);
      return;
    }
    openSearchPanel(view);
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: term, caseSensitive: false }))
    });
  };

  const handleSearchChange = (value: string) => {
    setFindQuery(value);
    runSearch(value);
  };

  const handleCopy = async () => {
    if (!activeFile) return;
    const ok = await copyToClipboard(activeFile.content);
    if (ok) {
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    }
  };

  const handleFormat = () => {
    if (!activeFile) return;
    const res = formatCode(activeFile.content, activeFile.language);
    if (res.changed) {
      onChangeContent(res.content);
      setToastMsg('Formatted');
      setTimeout(() => setToastMsg(null), 2000);
    } else {
      setToastMsg('Already formatted');
      setTimeout(() => setToastMsg(null), 1500);
    }
  };

  const handleDownloadFile = () => {
    if (!activeFile) return;
    downloadFile(activeFile.name, activeFile.content);
  };

  const handleDownloadZip = () => {
    if (files.length === 0) return;
    downloadWorkspaceZip(workspaceName || 'shadrox-project', files);
  };

  const handleDeleteFile = (index: number) => {
    const target = files[index];
    if (!target) return;
    if (target.content.trim() && !window.confirm(`Delete "${target.name}" from workspace?`)) {
      return;
    }
    onDeleteFile(index);
  };

  const handleRename = () => {
    if (!activeFile) return;
    const next = window.prompt('Rename file (workspace-relative path):', activeFile.name);
    if (!next || !next.trim() || next.trim() === activeFile.name) return;
    onRenameFile(activeFile.name, next.trim());
  };

  const handleRevert = () => {
    if (!activeFile || !dirty.has(activeFile.name)) return;
    if (!window.confirm(`Discard local changes in "${activeFile.name}" and reload it from disk?`)) return;
    onRevertFile();
  };

  useEffect(() => {
    if (!revealTarget || !activeFile || revealTarget.name !== activeFile.name) return;
    const frame = requestAnimationFrame(() => {
      const view = editorRef.current?.view;
      if (!view) return;
      const lineNumber = Math.min(Math.max(1, revealTarget.line), view.state.doc.lines);
      const line = view.state.doc.line(lineNumber);
      const position = Math.min(line.from + Math.max(0, (revealTarget.column ?? 1) - 1), line.to);
      view.dispatch({
        selection: { anchor: position, head: position },
        effects: EditorView.scrollIntoView(position, { y: 'center' })
      });
      view.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [revealTarget, activeFile?.name]);

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const lineCount = activeFile ? activeFile.content.split('\n').length : 0;
  const charCount = activeFile ? activeFile.content.length : 0;
  const tokenEst = activeFile ? estimateTokens(activeFile.content) : 0;
  const isDirty = activeFile ? dirty.has(activeFile.name) : false;

  return (
    <div className="flex-1 min-h-0 flex bg-ink-950 overflow-hidden relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-12 right-6 z-30 rounded-lg border border-violet-300/30 bg-violet-500/15 px-3 py-1 font-mono text-xs text-violet-200 shadow-lg transition-opacity">
          {toastMsg}
        </div>
      )}

      {/* Left Column: Vertical Files Explorer Sidebar */}
      <div
        className={`${
          isSidebarOpen ? 'w-60 sm:w-64' : 'w-0'
        } shrink-0 border-r border-white/[0.07] bg-ink-950 flex flex-col transition-all duration-200 overflow-hidden select-none`}
      >
        {/* Explorer Header */}
        <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-white/[0.07]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400 flex items-center gap-1.5">
            <FolderTree className="w-3.5 h-3.5 text-neutral-500" />
            Explorer
            <span className="text-neutral-600 font-normal">({files.length})</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onNewFile}
              title="Create new file"
              className="p-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <FilePlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleDownloadZip}
              title="Export workspace as ZIP"
              className="p-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Quick Filter Input */}
        <div className="p-2 border-b border-white/[0.05]">
          <div className="relative">
            <Search className="w-3 h-3 text-neutral-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Search files..."
              spellCheck={false}
              className="w-full rounded-lg border border-white/[0.09] bg-ink-950 py-1 pl-6 pr-5 text-[11px] text-neutral-200 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-300/40"
            />
            {fileFilter && (
              <button
                type="button"
                onClick={() => setFileFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-white cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Hierarchical workspace tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {files.length === 0 && !nativeDirectoryPages ? (
            <div className="p-4 text-center text-[11px] text-neutral-600 italic">
              No files in workspace
            </div>
          ) : (
            explorerTree.files.length + explorerTree.folders.length === 0
              ? <div className="p-4 text-center text-[11px] text-neutral-600 italic">No matching files</div>
              : nativeDirectoryPages
                ? renderNativeFolder('', 0, workspaceName || 'Workspace')
                : renderFolder(explorerTree, 0, workspaceName || 'Workspace')
          )}
        </div>
      </div>

      {/* Sidebar Toggle Tab */}
      <button
        type="button"
        onClick={() => setIsSidebarOpen((open) => !open)}
        title={isSidebarOpen ? 'Collapse file tree' : 'Expand file tree'}
        className="w-3.5 hover:w-4 bg-ink-950 border-r border-white/[0.07] flex items-center justify-center text-neutral-600 hover:text-white transition-all cursor-pointer z-10"
      >
        {isSidebarOpen ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>

      {/* Right Column: Code Editor Beside File List */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-ink-950">
        {/* Editor Top Navigation & Action Toolbar */}
        <div className="h-9 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-white/[0.07] bg-ink-900/70">
          {/* Active file metadata */}
          <div className="flex items-center gap-2 min-w-0">
            {activeFile ? (
              <>
                <FileCode2 className="w-3.5 h-3.5 text-violet-300 shrink-0" />
                <span className="font-mono text-xs text-neutral-100 truncate font-medium">
                  {activeFile.name}
                </span>
                {isDirty && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                )}
                <span className="hidden md:inline text-[10px] text-neutral-500 uppercase font-mono">
                  {activeFile.language}
                </span>
              </>
            ) : (
              <span className="text-xs text-neutral-500">No file selected</span>
            )}
          </div>

          {/* Action buttons toolbar */}
          {activeFile && (
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Search in active file */}
              <div className="relative hidden sm:block">
                <Search className="w-3 h-3 text-neutral-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={findQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const view = editorRef.current?.view;
                      if (view) findNext(view);
                    }
                  }}
                  placeholder="Find in file..."
                  spellCheck={false}
                  className="w-28 sm:w-36 rounded-lg border border-white/[0.09] bg-ink-950 py-1 pl-6 pr-2 text-[11px] text-neutral-200 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-300/40"
                />
              </div>

              {/* Format code */}
              <button
                type="button"
                onClick={handleFormat}
                title="Format Code"
                className="flex items-center gap-1 rounded-lg border border-white/[0.09] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-violet-300" />
                <span className="hidden lg:inline">Format</span>
              </button>

              {editorAi && (
                <button
                  type="button"
                  onClick={editorAi.onToggleCompletion}
                  title={
                    editorAi.completionEnabled
                      ? 'Inline tab completion is ON — press Tab to accept a ghost suggestion'
                      : 'Turn on inline tab completion'
                  }
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                    editorAi.completionEnabled
                      ? 'border-violet-300/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'
                      : 'border-white/[0.09] text-neutral-500 hover:border-white/[0.14] hover:text-white'
                  }`}
                >
                  <Zap className={`w-3.5 h-3.5 ${editorAi.completionEnabled ? 'text-violet-300' : 'text-neutral-600'}`} />
                  <span className="hidden lg:inline">Tab complete</span>
                </button>
              )}

              {/* Copy file content */}
              <button
                type="button"
                onClick={handleCopy}
                title="Copy Code"
                className="flex items-center gap-1 rounded-lg border border-white/[0.09] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
              >
                {hasCopied ? (
                  <Check className="w-3.5 h-3.5 text-violet-300" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span className="hidden lg:inline">{hasCopied ? 'Copied' : 'Copy'}</span>
              </button>

              {/* Download single file */}
              <button
                type="button"
                onClick={handleDownloadFile}
                title="Download this file"
                className="rounded-lg border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
              </button>

              {canWriteToDisk && (
                <>
                  <button
                    type="button"
                    onClick={handleRename}
                    title="Rename file on disk"
                    className="rounded-lg border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleRevert}
                    disabled={!isDirty}
                    title="Discard local edits and reload from disk"
                    className="rounded-lg border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-amber-300/40 hover:text-amber-300 disabled:opacity-30 cursor-pointer"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}

              {/* Save file */}
              {canWriteToDisk && (
                <button
                  type="button"
                  onClick={onSaveAll}
                  disabled={!isDirty || isSaving}
                  title="Save changes to disk (Ctrl+S)"
                  className="flex items-center gap-1 rounded-lg bg-violet-300 px-2.5 py-1 text-[11px] font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-30 disabled:hover:bg-violet-300 cursor-pointer"
                >
                  {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              )}
            </div>
          )}
        </div>

        {/* Open file tabs */}
        {files.length > 0 && (
          <div className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-white/[0.07] bg-ink-950">
            {files.map((file, index) => {
              const isActive = index === activeFileIndex;
              const hasUnsaved = dirty.has(file.name);
              return (
                <div
                  key={`${file.name}-${index}`}
                  className={`group flex shrink-0 items-center gap-1.5 border-r border-white/[0.06] px-2.5 transition-colors ${
                    isActive ? 'bg-ink-900 text-white' : 'text-neutral-500 hover:bg-white/[0.03] hover:text-neutral-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectFile(index)}
                    title={file.name}
                    className="flex min-w-0 max-w-[180px] items-center gap-1.5 font-mono text-[11px] cursor-pointer"
                  >
                    <FileCode2 className={`h-3 w-3 shrink-0 ${isActive ? 'text-violet-300' : 'text-neutral-600'}`} />
                    <span className="truncate">{file.name.split('/').pop()}</span>
                    {hasUnsaved && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onCloseTab(index)}
                    title={`Close ${file.name}`}
                    aria-label={`Close ${file.name}`}
                    className="rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:text-white group-hover:opacity-100 cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* CodeMirror Editor Area */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {quickEdit && editorAi && (
            <div
              role="dialog"
              aria-label="Quick edit selection"
              className="absolute z-30 w-[340px] rounded-xl border border-white/[0.12] bg-ink-900/95 p-2 shadow-2xl backdrop-blur"
              style={{ top: quickEdit.top, left: quickEdit.left }}
            >
              <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-violet-300" />
                  Quick edit
                  {quickEdit.from !== quickEdit.to && <span className="normal-case tracking-normal">selection</span>}
                </span>
                <button
                  type="button"
                  onClick={closeQuickEdit}
                  className="text-neutral-600 transition-colors hover:text-white cursor-pointer"
                  aria-label="Close quick edit"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <input
                autoFocus
                value={quickEditPrompt}
                onChange={(event) => setQuickEditPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void applyQuickEdit();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeQuickEdit();
                  }
                }}
                placeholder="Describe the change to this code..."
                spellCheck={false}
                className="w-full rounded-lg border border-white/[0.09] bg-ink-950 px-2 py-1.5 text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-300/40"
              />
              {quickEditError && <p className="mt-1.5 text-[10px] text-rose-400">{quickEditError}</p>}
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-neutral-600">
                <span className="font-mono">Enter to apply · Esc to cancel</span>
                <button
                  type="button"
                  onClick={() => void applyQuickEdit()}
                  disabled={!quickEditPrompt.trim() || isQuickEditing}
                  className="flex items-center gap-1 rounded-md bg-violet-300 px-2 py-1 font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-40 cursor-pointer"
                >
                  {isQuickEditing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {isQuickEditing ? 'Writing' : 'Apply'}
                </button>
              </div>
            </div>
          )}
          {activeFile ? (
            <CodeMirror
              ref={editorRef}
              value={activeFile.content}
              height="100%"
              theme="dark"
              extensions={extensions}
              onChange={(value) => onChangeContent(value)}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                highlightActiveLine: true,
                foldGutter: true,
                dropCursor: true,
                allowMultipleSelections: true,
                indentOnInput: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                rectangularSelection: true,
                crosshairCursor: false,
                highlightSelectionMatches: true,
                tabSize: 2
              }}
              className="h-full text-[12px] font-mono leading-relaxed [&_.cm-editor]:h-full [&_.cm-scroller]:h-full"
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-600">
              <FileCode2 className="w-8 h-8 text-neutral-700 mb-2" />
              <p className="text-xs text-neutral-400">Select a file from the explorer on the left to edit</p>
            </div>
          )}
        </div>

        {/* Professional IDE Status Bar */}
        {activeFile && (
          <div className="h-6 shrink-0 border-t border-white/[0.07] bg-ink-950 px-3 flex items-center justify-between text-[10px] font-mono text-neutral-500 select-none">
            <div className="flex items-center gap-3">
              <span>{lineCount} lines</span>
              <span>{charCount} chars</span>
              <span>~{tokenEst} tokens</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="uppercase text-neutral-400">{activeFile.language}</span>
              <span>UTF-8</span>
              <span>Spaces: 2</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  function renderFolder(folder: ExplorerFolder, depth: number, label?: string): ReactNode {
    const isExpanded = allFoldersExpanded || expandedFolders.has(folder.path);
    const folderLabel = label ?? folder.name;
    const isRoot = folder.path === '';
    const folderFiles = folder.files.map(({ file, index }) => {
      const isActive = index === activeFileIndex;
      const hasUnsaved = dirty.has(file.name);
      return (
        <div key={`${file.name}-${index}`} className="group flex items-center min-w-0 pr-2">
          <button
            type="button"
            onClick={() => onSelectFile(index)}
            title={file.name}
            className={`flex flex-1 min-w-0 items-center gap-1.5 rounded-md py-1 text-left transition-colors cursor-pointer ${
              isActive ? 'bg-violet-500/[.12] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'
            }`}
            style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
          >
            <FileCode2
              className={`w-3 h-3 shrink-0 ${
                isActive ? 'text-violet-300' : 'text-neutral-500 group-hover:text-neutral-300'
              }`}
            />
            <span className="font-mono text-[11px] truncate">{file.name.split('/').pop()}</span>
            {hasUnsaved && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
            )}
          </button>
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteFile(index);
              }}
              title="Delete file"
              className="opacity-0 group-hover:opacity-100 p-0.5 text-neutral-600 hover:text-red-400 transition-opacity cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      );
    });
    const childItems = isExpanded
      ? [
          ...folder.folders.map((child) => renderFolder(child, depth + 1)),
          ...folderFiles
        ]
      : [];

    return (
      <div key={folder.path || 'workspace-root'}>
        <button
          type="button"
          onClick={() => toggleFolder(folder.path)}
          aria-expanded={isExpanded}
          className="w-full flex items-center gap-1.5 py-1 pr-2 text-left text-[11px] text-neutral-300 hover:bg-white/[0.03] cursor-pointer"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <ChevronRight className={`w-3 h-3 shrink-0 text-neutral-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-300" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0 text-amber-300" />
          )}
          <span className="truncate font-medium">{folderLabel}</span>
        </button>
        {isExpanded && childItems}
      </div>
    );
  }

  function renderNativeFolder(path: string, depth: number, label?: string): ReactNode {
    const isExpanded = allFoldersExpanded || expandedFolders.has(path);
    const page = nativeDirectoryPages?.[path];
    const isLoading = loadingDirectories.includes(path);
    const folderLabel = label ?? path.split('/').pop() ?? 'Workspace';
    return (
      <div key={path || 'workspace-root'}>
        <button
          type="button"
          onClick={() => {
            toggleFolder(path);
            if (!isExpanded && !page) onLoadDirectory?.(path);
          }}
          aria-expanded={isExpanded}
          className="w-full flex items-center gap-1.5 py-1 pr-2 text-left text-[11px] text-neutral-300 hover:bg-white/[0.03] cursor-pointer"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <ChevronRight className={`w-3 h-3 shrink-0 text-neutral-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          {isExpanded ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-300" /> : <Folder className="w-3.5 h-3.5 shrink-0 text-amber-300" />}
          <span className="truncate font-medium">{folderLabel}</span>
          {isLoading && <Loader2 className="ml-auto w-3 h-3 animate-spin text-neutral-500" />}
        </button>
        {isExpanded && (page?.entries ?? []).map((entry) => {
          if (entry.kind === 'directory') {
            return renderNativeFolder(entry.path, depth + 1, entry.name);
          }
          const index = files.findIndex((file) => file.name === entry.path);
          const isActive = index >= 0 && index === activeFileIndex;
          const isDirty = dirty.has(entry.path);
          return (
            <button
              key={entry.path}
              type="button"
              onClick={() => index >= 0 ? onSelectFile(index) : onOpenPath?.(entry.path)}
              title={entry.path}
              className={`w-full flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors cursor-pointer ${isActive ? 'bg-violet-500/[.12] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'}`}
              style={{ paddingLeft: `${22 + depth * 14}px` }}
            >
              <FileCode2 className={`w-3 h-3 shrink-0 ${isActive ? 'text-violet-300' : 'text-neutral-500'}`} />
              <span className="font-mono text-[11px] truncate">{entry.name}</span>
              {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
            </button>
          );
        })}
        {isExpanded && page?.nextCursor !== null && page?.nextCursor !== undefined && (
          <button type="button" onClick={() => onLoadDirectory?.(path, page.nextCursor ?? undefined)} className="pl-8 py-1 text-[10px] text-neutral-500 hover:text-white">
            Load more…
          </button>
        )}
      </div>
    );
  }
}
