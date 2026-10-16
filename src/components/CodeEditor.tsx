import { useCallback, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef, oneDark } from '@uiw/react-codemirror';
import { findNext, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { ArrowLeft, FileCode2, FilePlus, Loader2, Save, Search, X } from 'lucide-react';
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
  onSaveAll
}: CodeEditorProps) {
  const activeFile = files[activeFileIndex] ?? null;
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [query, setQuery] = useState('');

  const dirty = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);
  const extensions = useMemo(
    () => [...extensionsFor(activeFile?.language ?? ''), search({ top: true })],
    [activeFile?.language]
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

  const handleSearchChange = (value: string) => {
    setQuery(value);
    runSearch(value);
  };

  const handleOpen = (index: number) => {
    setQuery('');
    onSelectFile(index);
  };

  // Nothing selected yet: the file list comes first, the editor only after a click.
  if (!activeFile) {
    return (
      <div className="flex-1 min-h-0 flex flex-col bg-black">
        <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            Files · {files.length}
          </span>
          <button
            type="button"
            onClick={onNewFile}
            className="flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5" />
            New file
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {files.map((file, index) => (
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
          ))}
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
              className="w-32 sm:w-44 border border-neutral-800 focus:border-neutral-600 bg-black text-[11px] text-neutral-200 pl-6 pr-2 py-1 outline-none placeholder:text-neutral-600"
            />
          </div>

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

          <button
            type="button"
            onClick={onNewFile}
            title="New file"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onDeleteFile(activeFileIndex)}
            title="File ko workspace view se hatao"
            className="p-1.5 text-neutral-600 hover:text-red-400 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
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
            // The toolbar keeps its own single search box, so CodeMirror's panel stays off.
            searchKeymap: false,
            tabSize: 2
          }}
        />
      </div>
    </div>
  );
}
