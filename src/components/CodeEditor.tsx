import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef, oneDark } from '@uiw/react-codemirror';
import { findNext, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { ArrowLeft, Archive, Check, Copy, Download, FileCode2, FilePlus, Loader2, Save, Search, SlidersHorizontal, Sparkles, Trash2, WrapText, X } from 'lucide-react';
import { copyToClipboard, downloadFile, downloadWorkspaceZip, estimateTokens, formatCode } from '../lib/toolUtils';
import type { WorkspaceFile } from '../lib/types';

interface CodeEditorProps {
  files: WorkspaceFile[];
  activeFileIndex: number;
  /** Workspace-relative names whose editor content differs from disk. */
  dirtyFiles: string[];
  canWriteToDisk: boolean;
  isSaving: boolean;
  onSelectFile: (index: number) => void;
  /** Returns to the file list without closing the workspace. */
  onCloseFile: () => void;
  onChangeContent: (content: string) => void;
  onDeleteFile: (index: number) => void;
  onNewFile: () => void;
  onSaveAll: () => void;
  workspaceName?: string;
}

/** Syntax support per language, so the code is coloured instead of white-on-black. */
function extensionsFor(language: string) {
  switch (language) {
    case 'typescript':
      return [javascript({ typescript: true, jsx: true })];
    case 'javascript':
      return [javascript({ jsx: true })];
    case 'html':
    case 'xml':
      return [html()];
    case 'css':
      return [css()];
    case 'json':
      return [json()];
    case 'markdown':
      return [markdown()];
    case 'python':
      return [python()];
    default:
      return [];
  }
}

/**
 * Keeps the app's black shell but only overrides the surfaces and the search
 * panel — token colours still come from oneDark, which is what makes the code
 * readable instead of a wall of white text.
 */
const DEVORA_THEME = EditorView.theme(
  {
    '&': { backgroundColor: '#000000', color: '#e5e5e5', fontSize: '12px', height: '100%' },
    '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.6' },
    '.cm-content': { caretColor: '#ffffff', paddingTop: '10px', paddingBottom: '32px' },
    '.cm-gutters': { backgroundColor: '#000000', color: '#404040', border: 'none', borderRight: '1px solid #171717' },
    '.cm-activeLineGutter': { backgroundColor: '#0f0f0f', color: '#a3a3a3' },
    '.cm-activeLine': { backgroundColor: '#0d0d0d' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffffff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#1d4ed866' },
    '.cm-selectionMatch': { backgroundColor: '#facc1522' },
    '.cm-searchMatch': { backgroundColor: '#facc1540', outline: '1px solid #facc1580' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#facc1599' },
    '.cm-panels': { backgroundColor: '#0a0a0a', color: '#d4d4d4' },
    '.cm-tooltip': { backgroundColor: '#0a0a0a', border: '1px solid #262626', color: '#d4d4d4' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#171717', color: '#ffffff' }
  },
  { dark: true }
);

const THEME = [oneDark, DEVORA_THEME];

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
  const activeFile = files[activeFileIndex] ?? null;
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [query, setQuery] = useState('');
  const [hasCopied, setHasCopied] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const toolsRef = useRef<HTMLDivElement>(null);

  const dirty = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);

  // Reports the real caret position, so the status bar stops showing the file's
  // total line count under a "Ln" label.
  const cursorListener = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCursor({ line: line.number, col: head - line.from + 1 });
      }),
    []
  );

  const extensions = useMemo(
    () => [
      ...extensionsFor(activeFile?.language ?? ''),
      search({ top: true }),
      cursorListener,
      ...(wrap ? [EditorView.lineWrapping] : [])
    ],
    [activeFile?.language, cursorListener, wrap]
  );

  const runSearch = useCallback((value: string) => {
    const view = editorRef.current?.view;
    if (!view) return;
    if (!value) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      return;
    }
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: value, caseSensitive: false })) });
    findNext(view);
  }, []);

  // Switching files (list, AI patch, checkpoint restore) has to clear the old
  // search term too, otherwise its highlights follow the user into the next file.
  useEffect(() => {
    setQuery('');
    setCursor({ line: 1, col: 1 });
    const view = editorRef.current?.view;
    if (view) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
  }, [activeFile?.name]);

  // The tools dropdown closes on any click outside it.
  useEffect(() => {
    if (!isToolsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setIsToolsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isToolsOpen]);

  const handleSearchChange = (value: string) => {
    setQuery(value);
    runSearch(value);
  };

  const handleOpen = (index: number) => {
    setQuery('');
    onSelectFile(index);
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
    downloadWorkspaceZip(workspaceName || 'devora-project', files);
  };

  /** Deleting is irreversible in the editor, so non-empty files ask first. */
  const handleDeleteFile = () => {
    if (!activeFile) return;
    if (activeFile.content.trim() && !window.confirm(`"${activeFile.name}" delete karein? Ye workspace se hat jayegi.`)) {
      return;
    }
    onDeleteFile(activeFileIndex);
  };

  // Nothing selected yet: the file list comes first, the editor only after a click.
  if (!activeFile) {
    const filter = fileFilter.trim().toLowerCase();
    const visibleFiles = files
      .map((file, index) => ({ file, index }))
      .filter((entry) => !filter || entry.file.name.toLowerCase().includes(filter));

    return (
      <div className="flex-1 min-h-0 flex flex-col bg-black">
        <div className="h-9 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-neutral-900">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0">
            Files · {filter ? `${visibleFiles.length}/${files.length}` : files.length}
          </span>
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative">
              <Search className="w-3 h-3 text-neutral-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={fileFilter}
                onChange={(event) => setFileFilter(event.target.value)}
                placeholder="Filter files"
                spellCheck={false}
                className="w-28 sm:w-44 border border-neutral-800 focus:border-neutral-600 bg-black text-[11px] text-neutral-200 pl-6 pr-6 py-1 outline-none placeholder:text-neutral-600"
              />
              {fileFilter && (
                <button
                  type="button"
                  onClick={() => setFileFilter('')}
                  title="Filter hatao"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-white cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {files.length > 0 && (
              <button
                type="button"
                onClick={handleDownloadZip}
                title="Export entire workspace as ZIP"
                className="hidden sm:flex items-center gap-1.5 text-[11px] text-neutral-400 hover:text-white transition-colors cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5 text-neutral-400" />
                Export ZIP
              </button>
            )}
            <button
              type="button"
              onClick={onNewFile}
              title="New file"
              className="flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-white transition-colors cursor-pointer shrink-0"
            >
              <FilePlus className="w-3.5 h-3.5" />
              New file
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {visibleFiles.length === 0 ? (
            <p className="px-3 py-4 text-[11px] text-neutral-600">
              "{fileFilter.trim()}" se koi file match nahi hui.
            </p>
          ) : (
            visibleFiles.map(({ file, index }) => (
              <button
                key={`${file.name}-${index}`}
                type="button"
                onClick={() => handleOpen(index)}
                className="group w-full flex items-center justify-between gap-3 px-3 py-2 border-b border-neutral-900/60 text-left hover:bg-neutral-950 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <FileCode2 className="w-3.5 h-3.5 text-neutral-600 group-hover:text-emerald-400 shrink-0" />
                  <span className="font-mono text-[11px] text-neutral-200 truncate">{file.name}</span>
                  {dirty.has(file.name) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Disk par save nahi hua" />
                  )}
                </span>
                <span className="text-[10px] text-neutral-600 shrink-0">
                  {file.language} · {file.content.split('\n').length} lines
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  const lineCount = activeFile.content.split('\n').length;
  const isDirty = dirty.has(activeFile.name);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-black">
      <div className="h-9 shrink-0 flex items-center justify-between gap-2 px-2 border-b border-neutral-900">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onCloseFile}
            title="File list par wapas jao"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono text-[11px] text-neutral-200 truncate">{activeFile.name}</span>
          {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Disk par save nahi hua" />}
          <span className="hidden lg:inline text-[10px] text-neutral-600 shrink-0">
            {lineCount} lines · {activeFile.language}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <div className="relative">
            <Search className="w-3 h-3 text-neutral-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={(event) => handleSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const view = editorRef.current?.view;
                  if (view) findNext(view);
                }
              }}
              placeholder="Search in file"
              spellCheck={false}
              className="w-28 sm:w-40 border border-neutral-800 focus:border-neutral-600 bg-black text-[11px] text-neutral-200 pl-6 pr-2 py-1 outline-none placeholder:text-neutral-600"
            />
          </div>

          <button
            type="button"
            onClick={onNewFile}
            title="New file"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>

          {/* Save Tool */}
          <button
            type="button"
            onClick={onSaveAll}
            disabled={!canWriteToDisk || dirty.size === 0 || isSaving}
            title={
              canWriteToDisk
                ? 'Disk par save karo'
                : 'Ye workspace read-only hai (drag-drop ki files disk par save nahi hoti)'
            }
            className="flex items-center gap-1 px-1.5 py-1 text-neutral-500 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {dirty.size > 0 && <span className="text-[10px] text-amber-400">{dirty.size}</span>}
          </button>

          {/* Secondary tools live in one dropdown instead of a row of icons. */}
          <div className="relative" ref={toolsRef}>
            <button
              type="button"
              onClick={() => setIsToolsOpen((open) => !open)}
              title="Aur tools — format, copy, wrap, download, export"
              className={`p-1.5 transition-colors cursor-pointer ${
                isToolsOpen ? 'text-white' : 'text-neutral-500 hover:text-white'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>

            {isToolsOpen && (
              <div className="absolute right-0 top-8 z-20 w-56 border border-neutral-800 bg-neutral-950 py-1 shadow-lg shadow-black/60">
                <button
                  type="button"
                  onClick={() => {
                    setIsToolsOpen(false);
                    handleFormat();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-neutral-500" />
                  Format & clean
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsToolsOpen(false);
                    void handleCopy();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                >
                  {hasCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-neutral-500" />}
                  {hasCopied ? 'Copied' : 'Copy full file'}
                </button>
                <button
                  type="button"
                  onClick={() => setWrap((value) => !value)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                >
                  <WrapText className={`w-3.5 h-3.5 ${wrap ? 'text-emerald-400' : 'text-neutral-500'}`} />
                  <span className="flex-1">Line wrap</span>
                  <span className={wrap ? 'text-emerald-400' : 'text-neutral-600'}>{wrap ? 'on' : 'off'}</span>
                </button>

                <div className="my-1 border-t border-neutral-900" />

                <button
                  type="button"
                  onClick={() => {
                    setIsToolsOpen(false);
                    handleDownloadFile();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-neutral-500" />
                  Download this file
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsToolsOpen(false);
                    handleDownloadZip();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Archive className="w-3.5 h-3.5 text-neutral-500" />
                  Export workspace ZIP
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-4 bg-neutral-900 mx-0.5" />

          <button
            type="button"
            onClick={handleDeleteFile}
            disabled={files.length <= 1}
            title={files.length <= 1 ? 'Last file delete nahi ho sakti' : 'Delete file (workspace se hatao)'}
            className="p-1.5 text-neutral-600 hover:text-red-400 disabled:opacity-30 disabled:hover:text-neutral-600 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <CodeMirror
          ref={editorRef}
          value={activeFile.content}
          height="100%"
          theme={THEME}
          extensions={extensions}
          onChange={onChangeContent}
          onCreateEditor={(view) => view.focus()}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            autocompletion: false,
            searchKeymap: false,
            tabSize: 2
          }}
        />
      </div>

      {/* Advanced IDE Status Bar */}
      <footer className="h-6 shrink-0 bg-neutral-950 border-t border-neutral-900 px-3 flex items-center justify-between text-[10px] text-neutral-500 font-mono select-none">
        <div className="flex items-center gap-3">
          <span title="Cursor position">{`Ln ${cursor.line}, Col ${cursor.col}`}</span>
          <span>{lineCount} lines</span>
          <span>{activeFile.content.length} chars</span>
          <span>~{estimateTokens(activeFile.content)} tokens</span>
          {toastMsg && <span className="text-emerald-400 font-sans">{toastMsg}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="uppercase text-neutral-400">{activeFile.language}</span>
          <span>UTF-8</span>
          <span title="Editor ka indent size">Spaces: 2</span>
        </div>
      </footer>
    </div>
  );
}
