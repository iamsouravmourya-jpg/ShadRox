import { useEffect, useRef } from 'react';
import { FilePlus, X } from 'lucide-react';
import type { WorkspaceFile } from '../lib/types';

interface CodeEditorProps {
  files: WorkspaceFile[];
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  onChangeContent: (content: string) => void;
  onDeleteFile: (index: number) => void;
  onNewFile: () => void;
}

/**
 * Lightweight textarea editor. Deliberately dependency-free — a full editor
 * (CodeMirror/Monaco) can be layered on later without touching the app shell.
 */
export function CodeEditor({
  files,
  activeFileIndex,
  onSelectFile,
  onChangeContent,
  onDeleteFile,
  onNewFile
}: CodeEditorProps) {
  const activeFile = files[activeFileIndex] ?? null;
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (gutterRef.current) gutterRef.current.scrollTop = 0;
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
  }, [activeFileIndex]);

  const handleScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const lineCount = activeFile ? activeFile.content.split('\n').length : 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-black">
      <div className="h-9 shrink-0 flex items-stretch border-b border-neutral-900 overflow-x-auto">
        {files.map((file, index) => (
          <div
            key={`${file.name}-${index}`}
            className={`group flex items-center gap-2 px-3 border-r border-neutral-900 text-[11px] whitespace-nowrap transition-colors ${
              index === activeFileIndex ? 'bg-neutral-950 text-white' : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            <button type="button" onClick={() => onSelectFile(index)} className="font-mono cursor-pointer">
              {file.name}
            </button>
            {files.length > 1 && (
              <button
                type="button"
                onClick={() => onDeleteFile(index)}
                aria-label={`Close ${file.name}`}
                className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-opacity cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={onNewFile}
          title="New file"
          className="px-3 text-neutral-600 hover:text-white transition-colors cursor-pointer"
        >
          <FilePlus className="w-3.5 h-3.5" />
        </button>
      </div>

      {activeFile ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="w-12 shrink-0 overflow-hidden bg-neutral-950 border-r border-neutral-900 py-3 select-none"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i} className="px-2 text-right text-[11px] leading-5 font-mono text-neutral-700">
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            value={activeFile.content}
            onChange={(event) => onChangeContent(event.target.value)}
            onScroll={handleScroll}
            spellCheck={false}
            className="flex-1 min-w-0 resize-none bg-black text-neutral-100 font-mono text-[12px] leading-5 px-3 py-3 outline-none"
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-neutral-600">
          Koi file open nahi hai. Left panel se file select karo.
        </div>
      )}
    </div>
  );
}
