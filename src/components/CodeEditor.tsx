import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
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
  FolderTree,
  Loader2,
  Save,
  Search,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import { copyToClipboard, downloadFile, downloadWorkspaceZip, estimateTokens, formatCode } from '../lib/toolUtils';
import { getLanguageExtension } from '../lib/languages';
import type { WorkspaceFile } from '../lib/types';

interface CodeEditorProps {
  files: WorkspaceFile[];
  activeFileIndex: number;
  dirtyFiles: string[];
  canWriteToDisk: boolean;
  isSaving: boolean;
  onSelectFile: (index: number) => void;
  onCloseFile: () => void;
  onChangeContent: (content: string) => void;
  onDeleteFile: (index: number) => void;
  onNewFile: () => void;
  onSaveAll: () => void;
  workspaceName?: string;
}

export function CodeEditor({
  files,
  activeFileIndex,
  dirtyFiles,
  canWriteToDisk,
  isSaving,
  onSelectFile,
  onCloseFile,
  onChangeContent,
  onDeleteFile,
  onNewFile,
  onSaveAll,
  workspaceName
}: CodeEditorProps) {
  const activeFile = files[activeFileIndex] ?? files[0] ?? null;
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [hasCopied, setHasCopied] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const dirty = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);

  const extensions = useMemo(() => {
    const list = [search({ top: true })];
    if (activeFile) {
      const ext = getLanguageExtension(activeFile.name, activeFile.language);
      if (ext) list.push(ext);
    }
    return list;
  }, [activeFile?.name, activeFile?.language]);

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

  // Filter files in vertical sidebar
  const filterLower = fileFilter.trim().toLowerCase();
  const visibleFiles = useMemo(() => {
    return files
      .map((file, index) => ({ file, index }))
      .filter((entry) => !filterLower || entry.file.name.toLowerCase().includes(filterLower));
  }, [files, filterLower]);

  const lineCount = activeFile ? activeFile.content.split('\n').length : 0;
  const charCount = activeFile ? activeFile.content.length : 0;
  const tokenEst = activeFile ? estimateTokens(activeFile.content) : 0;
  const isDirty = activeFile ? dirty.has(activeFile.name) : false;

  return (
    <div className="flex-1 min-h-0 flex bg-black overflow-hidden relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-12 right-6 z-30 px-3 py-1 bg-emerald-950/90 border border-emerald-800 text-emerald-300 text-xs font-mono shadow-lg transition-opacity">
          {toastMsg}
        </div>
      )}

      {/* Left Column: Vertical Files Explorer Sidebar */}
      <div
        className={`${
          isSidebarOpen ? 'w-60 sm:w-64' : 'w-0'
        } shrink-0 border-r border-neutral-900 bg-neutral-950 flex flex-col transition-all duration-200 overflow-hidden select-none`}
      >
        {/* Explorer Header */}
        <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
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
        <div className="p-2 border-b border-neutral-900/70">
          <div className="relative">
            <Search className="w-3 h-3 text-neutral-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Search files..."
              spellCheck={false}
              className="w-full border border-neutral-800 focus:border-neutral-700 bg-black text-[11px] text-neutral-200 pl-6 pr-5 py-1 outline-none placeholder:text-neutral-600"
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

        {/* Vertical Files List */}
        <div className="flex-1 overflow-y-auto divide-y divide-neutral-900/40">
          {visibleFiles.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-neutral-600 italic">
              {fileFilter ? 'No matching files' : 'No files in workspace'}
            </div>
          ) : (
            visibleFiles.map(({ file, index }) => {
              const isActive = index === activeFileIndex;
              const hasUnsaved = dirty.has(file.name);
              return (
                <div
                  key={`${file.name}-${index}`}
                  onClick={() => onSelectFile(index)}
                  className={`group flex items-center justify-between px-3 py-2 text-left cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-neutral-900/90 border-l-2 border-emerald-500 text-white'
                      : 'hover:bg-neutral-900/50 text-neutral-400 border-l-2 border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                    <FileCode2
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isActive ? 'text-emerald-400' : 'text-neutral-500 group-hover:text-neutral-300'
                      }`}
                    />
                    <span className="font-mono text-xs truncate">{file.name}</span>
                    {hasUnsaved && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
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
            })
          )}
        </div>
      </div>

      {/* Sidebar Toggle Tab */}
      <button
        type="button"
        onClick={() => setIsSidebarOpen((open) => !open)}
        title={isSidebarOpen ? 'Collapse file tree' : 'Expand file tree'}
        className="w-3.5 hover:w-4 bg-neutral-950 border-r border-neutral-900 flex items-center justify-center text-neutral-600 hover:text-white transition-all cursor-pointer z-10"
      >
        {isSidebarOpen ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>

      {/* Right Column: Code Editor Beside File List */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-black">
        {/* Editor Top Navigation & Action Toolbar */}
        <div className="h-9 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-neutral-900 bg-neutral-950/70">
          {/* Active file metadata */}
          <div className="flex items-center gap-2 min-w-0">
            {activeFile ? (
              <>
                <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
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
                  className="w-28 sm:w-36 border border-neutral-800 focus:border-neutral-600 bg-black text-[11px] text-neutral-200 pl-6 pr-2 py-0.5 outline-none placeholder:text-neutral-600"
                />
              </div>

              {/* Format code */}
              <button
                type="button"
                onClick={handleFormat}
                title="Format Code"
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-neutral-400 hover:text-white border border-neutral-800 hover:border-neutral-700 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden lg:inline">Format</span>
              </button>

              {/* Copy file content */}
              <button
                type="button"
                onClick={handleCopy}
                title="Copy Code"
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-neutral-400 hover:text-white border border-neutral-800 hover:border-neutral-700 transition-colors cursor-pointer"
              >
                {hasCopied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
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
                className="p-1 text-neutral-400 hover:text-white transition-colors cursor-pointer border border-neutral-800 hover:border-neutral-700"
              >
                <Download className="w-3.5 h-3.5" />
              </button>

              {/* Save file */}
              {canWriteToDisk && (
                <button
                  type="button"
                  onClick={onSaveAll}
                  disabled={!isDirty || isSaving}
                  title="Save changes to disk (Ctrl+S)"
                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-white text-black hover:bg-neutral-200 disabled:opacity-30 font-medium transition-colors cursor-pointer"
                >
                  {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              )}
            </div>
          )}
        </div>

        {/* CodeMirror Editor Area */}
        <div className="flex-1 min-h-0 overflow-hidden">
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
          <div className="h-6 shrink-0 border-t border-neutral-900 bg-neutral-950 px-3 flex items-center justify-between text-[10px] font-mono text-neutral-500 select-none">
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
}
