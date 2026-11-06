import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import type { Extension, Text } from '@codemirror/state';
import { forceLinting, lintGutter, linter, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  search,
  SearchQuery,
  selectSelectionMatches,
  setSearchQuery
} from '@codemirror/search';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Code2,
  Download,
  Eye,
  FileCode2,
  FileDiff,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Lightbulb,
  Loader2,
  ListTree,
  MoreHorizontal,
  Navigation,
  Pencil,
  Pin,
  PinOff,
  Save,
  Search,
  SearchCode,
  Sparkles,
  Trash2,
  Undo2,
  X,
  Zap
} from 'lucide-react';
import { copyToClipboard, downloadFile, downloadWorkspaceZip, estimateTokens, formatCode } from '../lib/toolUtils';
import { confirmAction } from '../lib/confirm';
import { resolveActiveFileIndex } from '../lib/activeFile';
import { getLanguageExtension, detectLanguage } from '../lib/languages';
import { ghostText } from '../lib/ghostText';
import {
  FIM_FAILURE_HINT_THRESHOLD,
  clearFimHealth,
  getFimHealth,
  subscribeFimHealth
} from '../lib/fimClient';
import { runQuickEdit, sliceQuickEditContext } from '../lib/quickEdit';
import { computeHunks, hunkStats } from '../lib/editor/hunks';
import { semanticHighlighting, setSemanticTokens } from '../lib/editor/semanticLayer';
import { breakpointGutterExtension, setBreakpointLines } from '../lib/editor/breakpoints';
import { debugHoverExtension } from '../lib/editor/hoverValues';
import type { ProviderId } from '../lib/providers';
import type { WorkspaceFile } from '../lib/types';
import type {
  CodeAction,
  DesktopDiagnostic,
  DirectoryPage,
  OutlineSymbol,
  ReferenceLocation,
  SemanticToken
} from '../lib/desktop';
import { formatDiagnosticMessage } from '../lib/diagnostics';
import { OutlinePanel } from './OutlinePanel';
import { ReferencesPanel } from './ReferencesPanel';
import { renderMarkdownContent } from '../lib/markdown';

interface CodeEditorProps {
  files: WorkspaceFile[];
  activeFileIndex: number;
  activeFilePath?: string | null;
  visibleTabIndices?: number[];
  editorGroupIndex?: number;
  editorGroupCount?: number;
  pinnedTabs?: string[];
  hideSidebar?: boolean;
  dirtyFiles: string[];
  canWriteToDisk: boolean;
  isSaving: boolean;
  onSelectFile: (index: number) => void;
  onCloseFile: () => void;
  onCloseTab: (index: number, groupIndex?: number) => void;
  onFocusGroup?: (index: number) => void;
  onSplitEditor?: () => void;
  onCloseEditorGroup?: (index: number) => void;
  onReorderTabs?: (groupIndex: number, fromPath: string, toPath: string) => void;
  onTogglePinnedTab?: (groupIndex: number, path: string) => void;
  onChangeContent: (content: string) => void;
  onDeleteFile: (index: number) => void;
  onNewFile: () => void;
  onCreateDirectory?: (path: string) => Promise<boolean>;
  onDeleteEntry?: (path: string) => Promise<boolean>;
  onSaveAll: () => void;
  onRenameFile: (from: string, to: string) => void;
  onRevertFile: () => void;
  revealTarget?: {
    name: string;
    line: number;
    column?: number;
    /** Optional 1-based end of the range to select (definition navigation). */
    endLine?: number;
    endColumn?: number;
    nonce: number;
  } | null;
  workspaceName?: string;
  /**
   * 'file' means the workspace is a set of loose files picked from disk, not a
   * directory. The explorer then draws them flat: labelling the root with the
   * workspace name would show `form.html` inside a folder called `form.html`,
   * because a single-file mount names the workspace after its only file.
   */
  workspaceKind?: 'folder' | 'file';
  nativeDirectoryPages?: Record<string, DirectoryPage>;
  loadingDirectories?: string[];
  /**
   * How many files the workspace holds on disk, which is what the explorer
   * header counts. Until a file is opened the app only holds the directory
   * listings, so `files` (open buffers) would report 0 for a full folder.
   */
  diskFileCount?: number;
  /** True when `diskFileCount` is a capped listing, rendered as `(123+)`. */
  diskFileCountTruncated?: boolean;
  onLoadDirectory?: (path: string, cursor?: number) => void;
  onOpenPath?: (path: string) => void;
  editorAi?: EditorAiConfig | null;
  /** Language-service diagnostics for the active file (absolute paths resolved by App). */
  diagnostics?: DesktopDiagnostic[];
  /**
   * Language-service semantic classification for the active file. Painted as a
   * colour layer on top of the syntax highlighter; absent in the browser build.
   */
  semanticTokens?: SemanticToken[];
  /** F12 / Ctrl+Click target, 0-based. Resolves when the target is in this file. */
  onDefinitionRequest?: (line: number, character: number) => Promise<DefinitionNavigation | null>;
  outlineSymbols?: OutlineSymbol[];
  isOutlineLoading?: boolean;
  outlineError?: string | null;
  /** False for non-script files or when the desktop bridge is absent. */
  outlineAvailable?: boolean;
  onSelectOutlineSymbol?: (symbol: OutlineSymbol) => void;
  /**
   * Rename and Find-all-references, both driven by the desktop language
   * service. Absent in the browser build, which is why every entry point is
   * gated on `symbols?.available` rather than on a separate boolean.
   */
  symbols?: EditorSymbolActions;
  /**
   * Deterministic quick fixes computed by the language service, offered with
   * Ctrl+./Cmd+. The caller owns the bridge and the disk write; the editor
   * only presents the menu and hands back the chosen action.
   */
  quickFixes?: EditorQuickFixActions;
  /**
   * Replaces the Explorer tree inside the sidebar column — how the rail's
   * Search view docks into the same slot instead of covering the screen.
   */
  sidebarPanel?: ReactNode;
  /**
   * Debugger breakpoints for the active file. `enabled` is false when no
   * shadrox.debug.json configuration exists, which turns the gutter into a
   * plain spacer instead of accepting clicks that would go nowhere.
   */
  breakpoints?: {
    enabled: boolean;
    /** Breakpoint lines for the active file; absent means none. */
    lines?: number[];
    onToggle: (line: number) => void;
  };
  /** Where the debugger is paused, shown as a compact header chip. */
  pausedAt?: { file: string; line: number; column?: number | null } | null;
  /** Reveals the paused location through the app's navigation path. */
  onOpenPaused?: (file: string, line: number, column?: number | null) => void;
  /**
   * Hover values while paused. The editor asks for one identifier at a time;
   * the caller owns the frame id and the adapter call.
   */
  debugHover?: {
    enabled: boolean;
    evaluate: (expression: string) => Promise<string | null>;
  };
}

/** What the editor needs to offer language-service quick fixes. */
export interface EditorQuickFixActions {
  /** False when no language service is reachable for the active file. */
  available: boolean;
  /** Collects the fixes that apply to a 0-based range in the active file. */
  onRequestFixes: (
    line: number,
    character: number,
    endLine: number,
    endCharacter: number
  ) => Promise<CodeAction[]>;
  /** Applies a chosen fix and resolves to a short, user-facing message. */
  onApplyFix: (action: CodeAction) => Promise<string>;
}

/** What the editor needs to offer rename and find-references. */
export interface EditorSymbolActions {
  /** False when no language service is reachable for the active file. */
  available: boolean;
  /**
   * Results for the reference list, or `null` when the panel is closed. The
   * caller owns this state so the panel survives the editor's re-renders.
   */
  references: ReferenceLocation[] | null;
  referencesLoading: boolean;
  referencesError?: string | null;
  /** The symbol the results belong to, shown in the panel header. */
  referencesSymbol?: string | null;
  /** Shift+F12: resolve every reference to the symbol at a 0-based position. */
  onFindReferences: (line: number, character: number) => void;
  onSelectReference: (reference: ReferenceLocation) => void;
  onCloseReferences: () => void;
  /** F2: rename the symbol at a 0-based position across the workspace. */
  onRename: (line: number, character: number, newName: string) => Promise<RenameOutcome>;
}

/** Result of a rename attempt; a failure still carries a readable reason. */
export interface RenameOutcome {
  ok: boolean;
  message: string;
}

/** A definition range inside the file that is already open. */
export interface DefinitionNavigation {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

/** BYOK settings the editor spends on inline AI work (tab completion, Ctrl+K). */
export interface EditorAiConfig {
  provider: ProviderId;
  /** Base URL of a BYOK custom endpoint; ignored by the built-in providers. */
  baseUrl?: string;
  model: string;
  apiKey?: string;
  completionEnabled: boolean;
  onToggleCompletion: () => void;
  /** Fires when the user accepts a ghost suggestion, so it can be billed. */
  onCompletionAccepted?: () => void;
  /**
   * The user's chat temperature, forwarded to Ctrl+K and clamped there —
   * inline edits have a tighter safe band than chat (see clampInlineTemperature).
   * Tab completion intentionally ignores it: a completion continues the code on
   * screen and wants near-deterministic output.
   */
  temperature?: number;
  /** False when BYOK is on but no key is saved, so the editor can say so. */
  hasCredential?: boolean;
}

interface QuickEditTarget {
  from: number;
  to: number;
  top: number;
  left: number;
}

/** The model's rewrite, held back until the user reviews the diff. */
interface QuickEditPreview {
  from: number;
  to: number;
  original: string;
  replacement: string;
}

/** Where the F2 rename prompt is anchored, and which symbol it will rewrite. */
interface RenameTarget {
  top: number;
  left: number;
  /** 0-based position of the symbol's first character. */
  line: number;
  character: number;
  /** The symbol as it reads now, so an unchanged name is a no-op. */
  original: string;
}

/** Where the Ctrl+. quick-fix menu is anchored and what it currently offers. */
interface QuickFixMenu {
  top: number;
  left: number;
  loading: boolean;
  error: string | null;
  actions: CodeAction[];
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface PathPromptRequest {
  title: string;
  description: string;
  initialValue: string;
  placeholder: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
}

/**
 * In-app replacement for window.prompt. `ConfirmHost` is confirm-only (no text
 * field) and belongs to another owner, so rename/create use this dialog styled
 * from the same tokens: rounded-panel, ink-900, white/10 border. It never blocks
 * the renderer and Escape/backdrop cancel like every other dialog in the app.
 */
export function PathPromptDialog({
  request,
  onCancel
}: {
  request: PathPromptRequest;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(request.initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the file name but keep the parent path, so a rename starts editable.
    const slash = request.initialValue.lastIndexOf('/');
    input.setSelectionRange(slash + 1, request.initialValue.length);
  }, [request.initialValue]);

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    request.onSubmit(next);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-full max-w-sm rounded-panel border border-white/10 bg-ink-900 p-4 shadow-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="text-sm font-semibold text-neutral-100">{request.title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{request.description}</p>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={request.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={request.title}
          className="mt-3 w-full rounded-xl border border-white/[0.09] bg-ink-950 px-3 py-2 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-300/40"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-white/[0.08] hover:text-white cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="rounded-xl bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-400 disabled:opacity-40 cursor-pointer"
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Bridge diagnostics are 0-based line/character (same as CodeMirror). Positions
 * are clamped to the current document so a response computed against an older
 * buffer can never throw; zero-length ranges are widened because the lint
 * extension only paints ranges with `from < to`.
 */
function toLintDiagnostics(list: DesktopDiagnostic[], doc: Text): LintDiagnostic[] {
  if (list.length === 0 || doc.length === 0) return [];
  const result: LintDiagnostic[] = [];
  for (const item of list) {
    const startLineNumber = clamp(item.line + 1, 1, doc.lines);
    const startLine = doc.line(startLineNumber);
    let from = clamp(startLine.from + Math.max(0, item.character), startLine.from, startLine.to);

    const rawEndLine = Math.max(item.line, item.endLine ?? item.line);
    const endLineNumber = clamp(rawEndLine + 1, startLineNumber, doc.lines);
    const endLine = doc.line(endLineNumber);
    const rawEndCharacter = item.endCharacter ?? item.character;
    let to = clamp(endLine.from + Math.max(0, rawEndCharacter), endLine.from, endLine.to);

    if (to <= from) {
      if (from < doc.length) {
        to = from + 1;
      } else if (from > 0) {
        from -= 1;
        to = from + 1;
      } else {
        continue;
      }
    }

    const severity: LintDiagnostic['severity'] =
      item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'info';
    result.push({
      from,
      to,
      severity,
      message: formatDiagnosticMessage(item),
      source: 'TypeScript'
    });
  }
  return result;
}

/**
 * Semantic highlighting is stateless and never depends on props, so it is built
 * once: a fresh array on every render would make CodeMirror reconfigure its
 * extensions for no reason.
 */
const SEMANTIC_EXTENSION = semanticHighlighting();

/**
 * Multi-cursor is mostly already there: the basic setup enables multiple
 * selections, Ctrl+Alt+Up/Down adds a cursor above/below, Mod+d adds the next
 * occurrence and Alt+Click (via `clickAddsSelectionRange`) drops one wherever
 * the user clicks. The one shortcut it leaves unbound is "select all
 * occurrences of the selection", which is the one VS Code users reach for, so
 * only that is added. The list is static, so it is built once.
 */
const MULTI_CURSOR_EXTENSION = [
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  keymap.of([{ key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true }])
];

export function CodeEditor({
  files,
  activeFileIndex,
  activeFilePath,
  visibleTabIndices,
  editorGroupIndex = 0,
  editorGroupCount = 1,
  pinnedTabs = [],
  hideSidebar = false,
  dirtyFiles,
  canWriteToDisk,
  isSaving,
  onSelectFile,
  onCloseFile,
  onCloseTab,
  onFocusGroup,
  onSplitEditor,
  onCloseEditorGroup,
  onReorderTabs,
  onTogglePinnedTab,
  onChangeContent,
  onDeleteFile,
  onNewFile,
  onCreateDirectory,
  onDeleteEntry,
  onSaveAll,
  onRenameFile,
  onRevertFile,
  revealTarget,
  workspaceName,
  workspaceKind = 'folder',
  nativeDirectoryPages,
  loadingDirectories = [],
  diskFileCount,
  diskFileCountTruncated = false,
  onLoadDirectory,
  onOpenPath,
  editorAi,
  diagnostics,
  semanticTokens,
  onDefinitionRequest,
  outlineSymbols,
  isOutlineLoading = false,
  outlineError,
  outlineAvailable = false,
  onSelectOutlineSymbol,
  symbols,
  quickFixes,
  sidebarPanel,
  breakpoints,
  pausedAt,
  onOpenPaused,
  debugHover
}: CodeEditorProps) {
  const activeFile = activeFilePath === undefined
    ? files[resolveActiveFileIndex(activeFileIndex, files.length)] ?? null
    : files.find((file) => file.name === activeFilePath) ?? null;
  const tabIndices = visibleTabIndices ?? files.map((_, index) => index);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [markdownPreviewPath, setMarkdownPreviewPath] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['']));
  const [hasCopied, setHasCopied] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [quickEdit, setQuickEdit] = useState<QuickEditTarget | null>(null);
  const [quickEditPrompt, setQuickEditPrompt] = useState('');
  const [isQuickEditing, setIsQuickEditing] = useState(false);
  const [quickEditError, setQuickEditError] = useState<string | null>(null);
  const [quickEditPreview, setQuickEditPreview] = useState<QuickEditPreview | null>(null);
  const quickEditAbort = useRef<AbortController | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isSymbolMenuOpen, setIsSymbolMenuOpen] = useState(false);
  /**
   * The toolbar row is a horizontal scroll container, so `absolute` would put
   * the code-action menu inside the scrollport and clip it. Anchoring it to the
   * viewport keeps the popup whole at every editor width.
   */
  const [symbolMenuAnchor, setSymbolMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const symbolMenuRef = useRef<HTMLDivElement>(null);
  const [quickFixMenu, setQuickFixMenu] = useState<QuickFixMenu | null>(null);
  const quickFixMenuRef = useRef<HTMLDivElement>(null);
  const quickFixRequestId = useRef(0);
  /** One-line, dismissible notice about why Tab may be doing nothing. */
  const [dismissedCompletionHint, setDismissedCompletionHint] = useState<string | null>(null);
  /** Rename / New Folder input; replaces the blocking window.prompt. */
  const [pathPrompt, setPathPrompt] = useState<PathPromptRequest | null>(null);
  const fimHealth = useSyncExternalStore(subscribeFimHealth, getFimHealth);

  const dirty = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);
  const filePathSignature = useMemo(() => files.map((file) => file.name).join('\n'), [files]);
  const explorerTree = useMemo(() => buildExplorerTree(files, fileFilter), [files, fileFilter]);
  const allFoldersExpanded = fileFilter.trim().length > 0;

  // Lint reads the latest diagnostics through a ref so the extension itself
  // stays stable (reconfiguring CodeMirror on every diagnostic response would
  // reset its scroll/selection state).
  const diagnosticsRef = useRef<DesktopDiagnostic[]>([]);
  diagnosticsRef.current = activeFile ? diagnostics ?? [] : [];
  const lintSource = useCallback(
    (view: EditorView) => toLintDiagnostics(diagnosticsRef.current, view.state.doc),
    []
  );
  const lintExtensions = useMemo(
    () => [linter(lintSource, { delay: 0 }), lintGutter()],
    [lintSource]
  );

  /**
   * The breakpoint gutter reads its click handler through a ref so the
   * extension instance never changes: toggling a dot must not reconfigure
   * CodeMirror and discard scroll or selection state.
   */
  const breakpointToggleRef = useRef<(line: number) => void>(() => {});
  breakpointToggleRef.current = breakpoints?.onToggle ?? (() => {});
  const breakpointExtension = useMemo(
    () => breakpointGutterExtension({ onToggle: (line) => breakpointToggleRef.current(line) }),
    []
  );

  // Same ref pattern for hover evaluate: the extension stays one instance while
  // the paused frame and adapter call change underneath it.
  const debugHoverEnabledRef = useRef(false);
  debugHoverEnabledRef.current = debugHover?.enabled === true;
  const debugHoverEvaluateRef = useRef<(expression: string) => Promise<string | null>>(async () => null);
  debugHoverEvaluateRef.current = debugHover?.evaluate ?? (async () => null);
  const debugHoverExtensionInstance = useMemo(
    () => debugHoverExtension({
      enabled: () => debugHoverEnabledRef.current,
      evaluate: (expression) => debugHoverEvaluateRef.current(expression)
    }),
    []
  );

  // Go-to-definition is installed even when inline AI is not configured.
  const definitionRequestRef = useRef<CodeEditorProps['onDefinitionRequest']>(undefined);
  definitionRequestRef.current = onDefinitionRequest;

  const requestDefinition = useCallback((view: EditorView, position: number) => {
    const handler = definitionRequestRef.current;
    if (!handler) return;
    const doc = view.state.doc;
    const clamped = clamp(position, 0, doc.length);
    const line = doc.lineAt(clamped);
    const character = clamped - line.from;
    void handler(line.number - 1, character)
      .then((target) => {
        if (!target) return;
        const current = view.state.doc;
        const targetLineNumber = clamp(target.line + 1, 1, current.lines);
        const targetLine = current.line(targetLineNumber);
        const anchor = clamp(targetLine.from + Math.max(0, target.character), targetLine.from, targetLine.to);
        view.dispatch({
          selection: { anchor, head: anchor },
          effects: EditorView.scrollIntoView(anchor, { y: 'center' })
        });
        view.focus();
      })
      .catch(() => {
        // Navigation failures are a silent no-op; the service already logged.
      });
  }, []);

  const definitionExtensions = useMemo(
    () => [
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.key !== 'F12' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
          event.preventDefault();
          requestDefinition(view, view.state.selection.main.head);
          return true;
        },
        mousedown: (event, view) => {
          if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.button !== 0) return false;
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position === null) return false;
          event.preventDefault();
          requestDefinition(view, position);
          return true;
        }
      })
    ],
    [requestDefinition]
  );

  /**
   * Rename and find-references are read through a ref, for the same reason as
   * the lint source: the keymap has to stay stable so CodeMirror does not
   * reconfigure its extensions on every render, while still invoking the
   * callbacks from the latest render.
   */
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  const findReferencesAt = useCallback((view: EditorView) => {
    const actions = symbolsRef.current;
    if (!actions?.available) return;
    const doc = view.state.doc;
    const position = clamp(view.state.selection.main.head, 0, doc.length);
    const line = doc.lineAt(position);
    actions.onFindReferences(line.number - 1, position - line.from);
  }, []);

  const openRename = useCallback((view: EditorView) => {
    const actions = symbolsRef.current;
    if (!actions?.available) return;
    const doc = view.state.doc;
    const position = clamp(view.state.selection.main.head, 0, doc.length);
    const line = doc.lineAt(position);
    const wordBefore = /[A-Za-z0-9_$]*$/.exec(doc.sliceString(line.from, position))?.[0] ?? '';
    const wordAfter = /^[A-Za-z0-9_$]*/.exec(doc.sliceString(position, line.to))?.[0] ?? '';
    if (!wordBefore && !wordAfter) {
      // Nothing to rename: say so instead of opening a prompt the service
      // would immediately reject.
      setToastMsg('Put the caret on a symbol to rename it');
      window.setTimeout(() => setToastMsg(null), 2500);
      return;
    }
    const start = position - wordBefore.length;
    const caret = view.coordsAtPos(position);
    const box = view.dom.getBoundingClientRect();
    setRenameError(null);
    setRenameValue(doc.sliceString(start, position + wordAfter.length));
    setRenameTarget({
      top: Math.max(6, (caret?.bottom ?? box.top + 22) - box.top + 6),
      left: Math.min(Math.max(6, (caret?.left ?? box.left + 12) - box.left), Math.max(6, box.width - 300)),
      line: line.number - 1,
      character: start - line.from,
      original: doc.sliceString(start, position + wordAfter.length)
    });
  }, []);

  const symbolExtensions = useMemo(
    () => [
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (!symbolsRef.current?.available) return false;
          const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
          if (event.key === 'F2' && plain && !event.shiftKey) {
            event.preventDefault();
            openRename(view);
            return true;
          }
          // Shift+F12 is Find All References; plain F12 belongs to the
          // definition handler above, which ignores the shifted variant.
          if (event.key === 'F12' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            findReferencesAt(view);
            return true;
          }
          return false;
        }
      })
    ],
    [findReferencesAt, openRename]
  );

  /**
   * Quick fixes are read through a ref for the same reason as the symbols: the
   * keymap must stay stable while still calling the newest callbacks. The menu
   * itself is anchored to the caret so the offer appears where the user is
   * already looking, exactly like the F2 prompt.
   */
  const quickFixesRef = useRef(quickFixes);
  quickFixesRef.current = quickFixes;

  const closeQuickFixes = useCallback(() => {
    quickFixRequestId.current += 1;
    setQuickFixMenu(null);
  }, []);

  const openQuickFixes = useCallback((view: EditorView) => {
    const actions = quickFixesRef.current;
    if (!actions?.available) return;
    const doc = view.state.doc;
    const selection = view.state.selection.main;
    const from = clamp(Math.min(selection.from, selection.to), 0, doc.length);
    const to = clamp(Math.max(selection.from, selection.to), 0, doc.length);
    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to);
    const caret = view.coordsAtPos(from);
    const box = view.dom.getBoundingClientRect();
    const requestId = ++quickFixRequestId.current;
    setQuickFixMenu({
      top: Math.max(6, (caret?.bottom ?? box.top + 22) - box.top + 6),
      left: Math.min(Math.max(6, (caret?.left ?? box.left + 12) - box.left), Math.max(6, box.width - 320)),
      loading: true,
      error: null,
      actions: []
    });
    void actions
      .onRequestFixes(startLine.number - 1, from - startLine.from, endLine.number - 1, to - endLine.from)
      .then((result) => {
        if (requestId !== quickFixRequestId.current) return;
        if (result.length === 0) {
          setQuickFixMenu(null);
          setToastMsg('No quick fixes available here');
          window.setTimeout(() => setToastMsg(null), 2500);
          return;
        }
        setQuickFixMenu((menu) => (menu ? { ...menu, loading: false, actions: result } : menu));
      })
      .catch((error) => {
        if (requestId !== quickFixRequestId.current) return;
        setQuickFixMenu((menu) =>
          menu
            ? { ...menu, loading: false, error: error instanceof Error ? error.message : 'Quick fixes failed.' }
            : menu
        );
      });
  }, []);

  /**
   * Applies the chosen fix. The caller rewrites the buffers and the disk; this
   * only reports the outcome, and closes the menu first so a slow save cannot
   * be re-triggered by a second click.
   */
  const applyQuickFix = useCallback(async (action: CodeAction) => {
    const fixes = quickFixesRef.current;
    if (!fixes) return;
    closeQuickFixes();
    try {
      const message = await fixes.onApplyFix(action);
      setToastMsg(message);
      window.setTimeout(() => setToastMsg(null), 3000);
    } catch (error) {
      setToastMsg(error instanceof Error ? error.message : 'Quick fix failed.');
      window.setTimeout(() => setToastMsg(null), 4000);
    }
  }, [closeQuickFixes]);

  const quickFixExtensions = useMemo(
    () => [
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          // Ctrl+. / Cmd+. matches the shortcut every TypeScript IDE uses for
          // "show me the fixes here".
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
          if (event.code !== 'Period' && event.key !== '.') return false;
          if (!quickFixesRef.current?.available) return false;
          event.preventDefault();
          openQuickFixes(view);
          return true;
        }
      })
    ],
    [openQuickFixes]
  );

  // The quick-fix menu behaves like a native popup: any click outside closes it,
  // and Escape dismisses it without touching the document.
  useEffect(() => {
    if (!quickFixMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (quickFixMenuRef.current?.contains(event.target as Node)) return;
      closeQuickFixes();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeQuickFixes();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [quickFixMenu, closeQuickFixes]);

  // Repaint squiggles as soon as a new language-service response lands.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    forceLinting(view);
  }, [diagnostics, activeFile?.name]);

  /**
   * Hand the latest semantic tokens to the decoration layer. Tokens for the
   * previous file are cleared on a tab switch rather than left to bleed into
   * the next document's offsets.
   */
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    view.dispatch({ effects: setSemanticTokens.of(activeFile ? semanticTokens ?? [] : []) });
  }, [semanticTokens, activeFile?.name]);

  // Breakpoint dots for the active file; cleared when the debug config is gone.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: setBreakpointLines.of({
        enabled: breakpoints?.enabled === true,
        lines: breakpoints?.lines ?? []
      })
    });
  }, [breakpoints?.enabled, breakpoints?.lines, activeFile?.name]);

  useEffect(() => {
    const firstLevel = new Set(['', ...files
      .map((file) => file.name.split('/').filter(Boolean).slice(0, 1)[0])
      .filter((name): name is string => Boolean(name) && files.some((file) => file.name.startsWith(`${name}/`)))]);
    setExpandedFolders(firstLevel);
  }, [workspaceName, filePathSignature]);

  const extensions = useMemo(() => {
    const list: Extension[] = [
      search({ top: true }),
      ...lintExtensions,
      ...definitionExtensions,
      ...symbolExtensions,
      ...quickFixExtensions,
      breakpointExtension,
      debugHoverExtensionInstance,
      SEMANTIC_EXTENSION,
      MULTI_CURSOR_EXTENSION
    ];
    if (activeFile) {
      const ext = getLanguageExtension(activeFile.name, activeFile.language);
      if (ext) list.push(ext);
    }
    if (editorAi?.completionEnabled) {
      list.push(
        ghostText({
          provider: editorAi.provider,
          baseUrl: editorAi.baseUrl,
          model: editorAi.model,
          apiKey: editorAi.apiKey,
          language: activeFile?.language,
          onAccepted: editorAi.onCompletionAccepted
          // editorAi.temperature is deliberately NOT forwarded: completions are
          // continuations of existing code and must stay near-deterministic.
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
  }, [activeFile?.name, activeFile?.language, editorAi, lintExtensions, definitionExtensions, symbolExtensions, quickFixExtensions, breakpointExtension, debugHoverExtensionInstance]);

  // Ctrl+K edits, the F2 prompt and the Ctrl+. menu are all scoped to the open
  // buffer, so a tab switch drops them along with the abort controller behind a
  // running request.
  useEffect(() => {
    quickEditAbort.current?.abort();
    quickEditAbort.current = null;
    setQuickEdit(null);
    setQuickEditError(null);
    setQuickEditPreview(null);
    setIsQuickEditing(false);
    setRenameTarget(null);
    setRenameError(null);
    setIsRenaming(false);
    setIsSymbolMenuOpen(false);
    quickFixRequestId.current += 1;
    setQuickFixMenu(null);
  }, [activeFile?.name]);

  const closeQuickEdit = useCallback(() => {
    quickEditAbort.current?.abort();
    quickEditAbort.current = null;
    setIsQuickEditing(false);
    setQuickEditPreview(null);
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
        {
          provider: editorAi.provider,
          baseUrl: editorAi.baseUrl,
          model: editorAi.model,
          apiKey: editorAi.apiKey,
          // The user's chat temperature, clamped inside runQuickEdit to the
          // band that is still safe for writing straight into a document.
          temperature: editorAi.temperature
        },
        controller.signal
      );
      const original = doc.sliceString(from, to);
      if (replacement === original) {
        setQuickEditError('The model returned the same code — nothing to apply.');
        return;
      }
      // Nothing touches the document until the user has seen the diff.
      setQuickEditPreview({ from, to, original, replacement });
      setQuickEditPrompt('');
    } catch (error) {
      if (!controller.signal.aborted) {
        setQuickEditError(error instanceof Error ? error.message : 'Quick edit failed.');
      }
    } finally {
      quickEditAbort.current = null;
      setIsQuickEditing(false);
    }
  }, [activeFile, editorAi, isQuickEditing, quickEdit, quickEditPrompt]);

  const commitQuickEdit = useCallback(() => {
    const view = editorRef.current?.view;
    if (!view || !quickEditPreview) return;
    const { from, to, replacement } = quickEditPreview;
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
      userEvent: 'input.replace'
    });
    setQuickEditPreview(null);
    setQuickEdit(null);
    setQuickEditPrompt('');
    setToastMsg('Quick edit applied · Ctrl+Z to undo');
    window.setTimeout(() => setToastMsg(null), 3500);
  }, [quickEditPreview]);

  /** Drop the diff but keep the prompt so the instruction can be reworded. */
  const discardQuickEdit = useCallback(() => {
    setQuickEditPreview(null);
  }, []);

  const quickEditDiff = useMemo(() => {
    if (!quickEditPreview) return null;
    const hunks = computeHunks(quickEditPreview.original, quickEditPreview.replacement);
    return {
      hunks,
      beforeLines: quickEditPreview.original.split('\n'),
      stats: hunkStats(hunks)
    };
  }, [quickEditPreview]);

  const closeRename = useCallback(() => {
    setIsRenaming(false);
    setRenameError(null);
    setRenameTarget(null);
  }, []);

  /**
   * Apply the F2 rename. The service rewrites every file it can reach, so the
   * work is handed to the caller and the outcome is reported back here; an
   * unchanged name never leaves the prompt.
   */
  const applyRename = useCallback(async () => {
    const action = symbolsRef.current;
    const target = renameTarget;
    const next = renameValue.trim();
    if (!action || !target || isRenaming) return;
    if (!next) {
      setRenameError('A new name is required.');
      return;
    }
    if (next === target.original) {
      closeRename();
      return;
    }

    setIsRenaming(true);
    setRenameError(null);
    const outcome = await action.onRename(target.line, target.character, next);
    setIsRenaming(false);
    if (!outcome.ok) {
      setRenameError(outcome.message);
      return;
    }
    setRenameTarget(null);
    setToastMsg(outcome.message || 'Symbol renamed');
    window.setTimeout(() => setToastMsg(null), 3000);
  }, [closeRename, isRenaming, renameTarget, renameValue]);

  // The symbol menu closes on any click outside it, the way a native menu does.
  useEffect(() => {
    if (!isSymbolMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (symbolMenuRef.current?.contains(event.target as Node)) return;
      setIsSymbolMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isSymbolMenuOpen]);

  const toggleSymbolMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (isSymbolMenuOpen) {
        setIsSymbolMenuOpen(false);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setSymbolMenuAnchor({
        top: Math.round(rect.bottom + 4),
        right: Math.max(8, Math.round(window.innerWidth - rect.right))
      });
      setIsSymbolMenuOpen(true);
    },
    [isSymbolMenuOpen]
  );

  const runDefinitionFromMenu = useCallback(() => {
    const view = editorRef.current?.view;
    setIsSymbolMenuOpen(false);
    if (view) requestDefinition(view, view.state.selection.main.head);
  }, [requestDefinition]);

  const runFindReferencesFromMenu = useCallback(() => {
    const view = editorRef.current?.view;
    setIsSymbolMenuOpen(false);
    if (view) findReferencesAt(view);
  }, [findReferencesAt]);

  const runRenameFromMenu = useCallback(() => {
    const view = editorRef.current?.view;
    setIsSymbolMenuOpen(false);
    if (view) openRename(view);
  }, [openRename]);

  const runQuickFixFromMenu = useCallback(() => {
    const view = editorRef.current?.view;
    setIsSymbolMenuOpen(false);
    if (view) openQuickFixes(view);
  }, [openQuickFixes]);

  /**
   * Tab completion failures used to be invisible: the client cached an empty
   * completion after one HTTP failure, so the ghost text never came back and
   * the user had no idea why. The client now counts failures instead of caching
   * them, and this is the line that tells the user.
   */
  const completionHint = useMemo<{ id: string; text: string } | null>(() => {
    if (!editorAi?.completionEnabled) return null;
    if (editorAi.hasCredential === false) {
      return {
        id: `no-key-${editorAi.provider}`,
        text: 'Tab completion is on but no API key is saved — add one in Settings → Models & Keys.'
      };
    }
    if (fimHealth.consecutiveFailures >= FIM_FAILURE_HINT_THRESHOLD) {
      return {
        id: `failing-${editorAi.model}-${fimHealth.consecutiveFailures}`,
        text: `Tab completion has failed ${fimHealth.consecutiveFailures} times in a row — check the key and model in Settings → Models & Keys. ShadRox is pausing those requests and will retry on its own.`
      };
    }
    return null;
  }, [editorAi, fimHealth.consecutiveFailures]);

  const dismissCompletionHint = useCallback(() => {
    if (!completionHint) return;
    setDismissedCompletionHint(completionHint.id);
    // Reset the counter so a fresh run of failures can raise the notice again.
    if (completionHint.id.startsWith('failing-')) clearFimHealth();
  }, [completionHint]);

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

  const handleDeleteFile = async (index: number) => {
    const target = files[index];
    if (!target) return;
    if (target.content.trim()) {
      const confirmed = await confirmAction({
        title: `Delete "${target.name}"?`,
        body: 'The file is removed from the workspace.',
        confirmLabel: 'Delete',
        tone: 'danger'
      });
      if (!confirmed) return;
    }
    onDeleteFile(index);
  };

  const handleRename = () => {
    if (!activeFile) return;
    const current = activeFile.name;
    setPathPrompt({
      title: 'Rename file',
      description: 'Workspace-relative path. The file is moved on disk and its tab follows.',
      initialValue: current,
      placeholder: 'src/utils/helper.ts',
      confirmLabel: 'Rename',
      onSubmit: (next) => {
        setPathPrompt(null);
        if (next === current) return;
        onRenameFile(current, next);
      }
    });
  };

  const parentFolderForNew = () => {
    const open = [...expandedFolders].filter((path) => path !== '');
    return open[open.length - 1] ?? '';
  };

  const handleNewFolder = () => {
    if (!onCreateDirectory) return;
    const parent = parentFolderForNew();
    setPathPrompt({
      title: parent ? `New folder in ${parent}` : 'New folder',
      description: 'Workspace-relative path. Dot-names and generated folders are refused by the bridge.',
      initialValue: parent ? `${parent}/` : '',
      placeholder: 'src/components',
      confirmLabel: 'Create folder',
      onSubmit: (next) => {
        setPathPrompt(null);
        const clean = next.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        if (!clean || clean === parent) return;
        void onCreateDirectory(!clean.includes('/') && parent ? `${parent}/${clean}` : clean);
      }
    });
  };

  const handleDeleteEntry = async (path: string, label: string, kind: 'file' | 'folder') => {
    if (!onDeleteEntry) return;
    const confirmed = await confirmAction({
      title: `Delete ${kind} "${label}"?`,
      body: 'It is removed from disk. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!confirmed) return;
    await onDeleteEntry(path);
  };

  const handleRevert = async () => {
    if (!activeFile || !dirty.has(activeFile.name)) return;
    const confirmed = await confirmAction({
      title: `Reload "${activeFile.name}" from disk?`,
      body: 'Local edits to this file are lost. The version on disk is kept.',
      confirmLabel: 'Discard changes',
      tone: 'danger'
    });
    if (!confirmed) return;
    onRevertFile();
  };

  useEffect(() => {
    if (!revealTarget || !activeFile || revealTarget.name !== activeFile.name) return;
    const frame = requestAnimationFrame(() => {
      const view = editorRef.current?.view;
      if (!view) return;
      const doc = view.state.doc;
      const lineNumber = Math.min(Math.max(1, revealTarget.line), doc.lines);
      const line = doc.line(lineNumber);
      const position = Math.min(line.from + Math.max(0, (revealTarget.column ?? 1) - 1), line.to);
      let head = position;
      if (typeof revealTarget.endLine === 'number') {
        const endLineNumber = Math.min(Math.max(lineNumber, revealTarget.endLine), doc.lines);
        const endLine = doc.line(endLineNumber);
        head = Math.min(
          Math.max(position, endLine.from + Math.max(0, (revealTarget.endColumn ?? 1) - 1)),
          endLine.to
        );
      }
      view.dispatch({
        selection: { anchor: position, head },
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
  const isMarkdownFile = (name: string, language?: string) =>
    (language ?? detectLanguage(name)).toLowerCase() === 'markdown';
  const isMarkdownPreview = Boolean(activeFile && markdownPreviewPath === activeFile.name);

  return (
    <div
      className="flex-1 min-w-0 min-h-0 flex bg-ink-950 overflow-hidden relative"
      onMouseDownCapture={() => onFocusGroup?.(editorGroupIndex)}
    >
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-12 right-6 z-30 rounded-lg border border-violet-300/30 bg-violet-500/15 px-3 py-1 font-mono text-xs text-violet-200 shadow-lg transition-opacity">
          {toastMsg}
        </div>
      )}

      {pathPrompt && (
        <PathPromptDialog
          key={`${pathPrompt.title}:${pathPrompt.initialValue}`}
          request={pathPrompt}
          onCancel={() => setPathPrompt(null)}
        />
      )}

      {/* Left Column: Vertical Files Explorer Sidebar */}
      <div
        className={`${
          hideSidebar ? 'hidden' : sidebarPanel ? 'w-72 sm:w-80' : isSidebarOpen ? 'w-60 sm:w-64' : 'w-0'
        } shrink-0 border-r border-white/[0.07] bg-ink-950 flex flex-col transition-all duration-200 overflow-hidden select-none`}
      >
        {sidebarPanel ? (
          sidebarPanel
        ) : (
          <>
        {/* Explorer Header */}
        <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-white/[0.07]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400 flex items-center gap-1.5">
            <FolderTree className="w-3.5 h-3.5 text-neutral-500" />
            Explorer
            <span className="text-neutral-600 font-normal">({diskFileCount ?? files.length}{diskFileCountTruncated ? '+' : ''})</span>
          </span>
          <div className="flex items-center gap-1">
            {outlineAvailable && (
              <button
                type="button"
                onClick={() => setIsOutlineOpen((open) => !open)}
                aria-pressed={isOutlineOpen}
                title={isOutlineOpen ? 'Hide document outline' : 'Show document outline'}
                aria-label={isOutlineOpen ? 'Hide document outline' : 'Show document outline'}
                className={`p-1 transition-colors cursor-pointer ${
                  isOutlineOpen ? 'text-violet-300' : 'text-neutral-400 hover:text-white'
                }`}
              >
                <ListTree className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onNewFile}
              title="Create new file"
              aria-label="Create new file"
              className="p-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <FilePlus className="w-3.5 h-3.5" />
            </button>
            {canWriteToDisk && onCreateDirectory && (
              <button
                type="button"
                onClick={handleNewFolder}
                title="Create new folder"
                aria-label="Create new folder"
                className="p-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={handleDownloadZip}
              title="Export workspace as ZIP"
              aria-label="Export workspace as ZIP"
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
                title="Clear file filter"
                aria-label="Clear file filter"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-white cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Hierarchical workspace tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {nativeDirectoryPages ? (
            renderNativeFolder('', 0, workspaceName || 'Workspace')
          ) : files.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-neutral-600 italic">
              No files in workspace
            </div>
          ) : explorerTree.files.length + explorerTree.folders.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-neutral-600 italic">No matching files</div>
          ) : workspaceKind === 'file' ? (
            renderLooseRootFiles(explorerTree)
          ) : (
            renderFolder(explorerTree, 0, workspaceName || 'Workspace')
          )}
        </div>

        {outlineAvailable && isOutlineOpen && (
          <OutlinePanel
            symbols={outlineSymbols ?? []}
            isLoading={isOutlineLoading}
            error={outlineError}
            onSelect={(symbol) => onSelectOutlineSymbol?.(symbol)}
          />
        )}

        {/* Null means the panel is closed; an empty list means "none found". */}
        {symbols?.references && (
          <ReferencesPanel
            references={symbols.references}
            isLoading={symbols.referencesLoading}
            error={symbols.referencesError}
            symbolName={symbols.referencesSymbol}
            onSelect={symbols.onSelectReference}
            onClose={symbols.onCloseReferences}
          />
        )}
          </>
        )}
      </div>

      {/* Sidebar Toggle Tab */}
      {!sidebarPanel && (
      <button
        type="button"
        onClick={() => setIsSidebarOpen((open) => !open)}
        title={isSidebarOpen ? 'Collapse file tree' : 'Expand file tree'}
        className="w-3.5 hover:w-4 bg-ink-950 border-r border-white/[0.07] flex items-center justify-center text-neutral-600 hover:text-white transition-all cursor-pointer z-10"
      >
        {isSidebarOpen ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      )}

      {/* Right Column: Code Editor Beside File List */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-ink-950">
        {/*
          The toolbar is contained: the column clips at its own width and the
          action row scrolls horizontally instead of spilling over the chat
          column. The scrollbar stays invisible to keep the 36px strip clean.
        */}
        <div className="h-9 shrink-0 flex min-w-0 items-center justify-between gap-2 overflow-x-auto px-3 border-b border-white/[0.07] bg-ink-900/70 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Active file metadata */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
                {pausedAt && (
                  <button
                    type="button"
                    onClick={() => onOpenPaused?.(pausedAt.file, pausedAt.line, pausedAt.column)}
                    title={`Debugger paused at ${pausedAt.file}:${pausedAt.line}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-200 transition-colors hover:bg-rose-500/20 cursor-pointer"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                    paused at {pausedAt.file.split('/').pop()}:{pausedAt.line}
                  </button>
                )}
                {isMarkdownFile(activeFile.name, activeFile.language) && (
                  <button
                    type="button"
                    onClick={() => setMarkdownPreviewPath(isMarkdownPreview ? null : activeFile.name)}
                    aria-pressed={isMarkdownPreview}
                    title={isMarkdownPreview ? 'Show Markdown source' : 'Preview Markdown'}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer ${
                      isMarkdownPreview
                        ? 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                        : 'border-white/[0.09] text-neutral-400 hover:border-white/[0.14] hover:text-white'
                    }`}
                  >
                    {isMarkdownPreview ? <Code2 className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {isMarkdownPreview ? 'Source' : 'Preview'}
                  </button>
                )}
              </>
            ) : (
              <span className="text-xs text-neutral-500">No file selected</span>
            )}
          </div>

          {/* Action buttons toolbar */}
          {activeFile && (
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Search in active file */}
              <div className="relative hidden xl:block">
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

              {/*
                One entry point for the language-service actions: definition,
                references, rename and quick fixes. The keybindings exist too,
                but a menu keeps them findable without reading a shortcut list.
              */}
              {(symbols?.available || quickFixes?.available) && (
                <div className="relative" ref={symbolMenuRef}>
                  <button
                    type="button"
                    onClick={toggleSymbolMenu}
                    aria-haspopup="menu"
                    aria-expanded={isSymbolMenuOpen}
                    title="Code actions — definition, references, rename, quick fix"
                    className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                      isSymbolMenuOpen
                        ? 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                        : 'border-white/[0.09] text-neutral-400 hover:border-white/[0.14] hover:text-white'
                    }`}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                    <span className="hidden lg:inline">Code</span>
                  </button>
                  {isSymbolMenuOpen && (
                    <div
                      role="menu"
                      className="fixed z-40 w-52 overflow-hidden rounded-lg border border-white/[0.12] bg-ink-900/95 py-1 shadow-2xl backdrop-blur"
                      style={{
                        top: symbolMenuAnchor?.top ?? 44,
                        right: symbolMenuAnchor?.right ?? 12
                      }}
                    >
                      {quickFixes?.available && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={runQuickFixFromMenu}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        >
                          <Lightbulb className="w-3.5 h-3.5 text-amber-300" />
                          Quick Fix
                          <span className="ml-auto font-mono text-[9px] text-neutral-600">⌃.</span>
                        </button>
                      )}
                      {symbols?.available && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={runDefinitionFromMenu}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        >
                          <Navigation className="w-3.5 h-3.5 text-violet-300" />
                          Go to Definition
                          <span className="ml-auto font-mono text-[9px] text-neutral-600">F12</span>
                        </button>
                      )}
                      {symbols?.available && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={runFindReferencesFromMenu}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        >
                          <SearchCode className="w-3.5 h-3.5 text-violet-300" />
                          Find All References
                          <span className="ml-auto font-mono text-[9px] text-neutral-600">⇧F12</span>
                        </button>
                      )}
                      {symbols?.available && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={runRenameFromMenu}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5 text-violet-300" />
                          Rename Symbol
                          <span className="ml-auto font-mono text-[9px] text-neutral-600">F2</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

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
                aria-label={hasCopied ? 'Copied to clipboard' : 'Copy file contents'}
                className="flex items-center gap-1 rounded-lg border border-white/[0.09] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
              >
                {hasCopied ? (
                  <Check className="w-3.5 h-3.5 text-violet-300" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-neutral-400" />
                )}
                <span className="hidden xl:inline">{hasCopied ? 'Copied' : 'Copy'}</span>
              </button>

              {/* Download single file */}
              <button
                type="button"
                onClick={handleDownloadFile}
                title="Download this file"
                aria-label="Download this file"
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
                    aria-label="Rename file on disk"
                    className="rounded-lg border border-white/[0.09] p-1 text-neutral-400 transition-colors hover:border-white/[0.14] hover:text-white cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleRevert}
                    disabled={!isDirty}
                    title="Discard local edits and reload from disk"
                    aria-label="Discard local edits and reload from disk"
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
        {(tabIndices.length > 0 || onSplitEditor || editorGroupCount > 1) && (
          <div className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-white/[0.07] bg-ink-950">
            {tabIndices.map((index) => {
              const file = files[index];
              if (!file) return null;
              const isActive = index === activeFileIndex;
              const hasUnsaved = dirty.has(file.name);
              const isPinned = pinnedTabs.includes(file.name);
              return (
                <div
                  key={`${file.name}-${index}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', file.name);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const fromPath = event.dataTransfer.getData('text/plain');
                    if (fromPath) onReorderTabs?.(editorGroupIndex, fromPath, file.name);
                  }}
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
                    {isPinned
                      ? <Pin className={`h-3 w-3 shrink-0 ${isActive ? 'text-violet-300' : 'text-neutral-600'}`} />
                      : <FileCode2 className={`h-3 w-3 shrink-0 ${isActive ? 'text-violet-300' : 'text-neutral-600'}`} />}
                    <span className="truncate">{file.name.split('/').pop()}</span>
                    {hasUnsaved && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
                  </button>
                  {onTogglePinnedTab && (
                    <button
                      type="button"
                      onClick={() => onTogglePinnedTab(editorGroupIndex, file.name)}
                      title={isPinned ? `Unpin ${file.name}` : `Pin ${file.name}`}
                      aria-label={isPinned ? `Unpin ${file.name}` : `Pin ${file.name}`}
                      aria-pressed={isPinned}
                      className="rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:text-violet-300 group-hover:opacity-100 cursor-pointer"
                    >
                      {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCloseTab(index, editorGroupIndex)}
                    title={`Close ${file.name}`}
                    aria-label={`Close ${file.name}`}
                    className="rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:text-white group-hover:opacity-100 cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <div className="ml-auto flex shrink-0 items-center gap-1 px-1">
              {onSplitEditor && (
                <button
                  type="button"
                  onClick={onSplitEditor}
                  title="Split editor"
                  aria-label="Split editor"
                  className="rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </button>
              )}
              {editorGroupCount > 1 && onCloseEditorGroup && (
                <button
                  type="button"
                  onClick={() => onCloseEditorGroup(editorGroupIndex)}
                  title="Close editor group"
                  aria-label="Close editor group"
                  className="rounded p-1 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Sticky File Path Breadcrumb Bar */}
        {activeFile && (
          <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-white/[0.04] bg-ink-950/70 px-3 text-[10px] font-mono text-neutral-400">
            <span className="flex items-center gap-1 text-neutral-500">
              <Folder className="h-3 w-3 text-neutral-500" />
              {activeFile.name.split('/').slice(0, -1).join(' / ') || '.'}
            </span>
            <span className="text-neutral-600">/</span>
            <span className="text-neutral-200 font-semibold flex items-center gap-1">
              <FileCode2 className="h-3 w-3 text-violet-300" />
              {activeFile.name.split('/').pop()}
            </span>
            {diagnostics && diagnostics.length > 0 && (
              <span className="ml-auto text-[9.5px] font-mono text-amber-400 flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-400" />
                {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {/* One-line, dismissible inline-AI notice. Non-blocking by design. */}
        {completionHint && dismissedCompletionHint !== completionHint.id && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-amber-300/15 bg-amber-400/[0.07] px-3 py-1 text-[10.5px] text-amber-200/90"
          >
            <Zap className="w-3 h-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={completionHint.text}>
              {completionHint.text}
            </span>
            <button
              type="button"
              onClick={dismissCompletionHint}
              aria-label="Dismiss completion hint"
              className="rounded p-0.5 text-amber-200/60 transition-colors hover:text-white cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
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
                  {quickEditPreview ? (
                    <FileDiff className="w-3 h-3 text-violet-300" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-violet-300" />
                  )}
                  {quickEditPreview ? 'Review change' : 'Quick edit'}
                  {!quickEditPreview && quickEdit.from !== quickEdit.to && (
                    <span className="normal-case tracking-normal">selection</span>
                  )}
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
              {quickEditPreview && quickEditDiff ? (
                <div>
                  <div className="mb-1.5 text-[10px] text-neutral-500">
                    <span className="text-emerald-300">+{quickEditDiff.stats.added}</span>
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="text-rose-300">−{quickEditDiff.stats.removed}</span>
                    <span className="ml-1.5">
                      in {quickEditDiff.hunks.length} change{quickEditDiff.hunks.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="max-h-60 overflow-auto rounded-lg border border-white/[0.08] bg-ink-950/80 font-mono text-[11px] leading-5">
                    {quickEditDiff.hunks.map((hunk) => (
                      <div key={hunk.id} className="border-b border-white/[0.05] last:border-b-0">
                        {quickEditDiff.beforeLines.slice(hunk.beforeStart, hunk.beforeEnd).map((lineText, i) => (
                          <div key={`rm${i}`} className="flex gap-1.5 bg-rose-500/10 px-2 text-rose-200">
                            <span className="select-none text-rose-400/70">−</span>
                            <span className="whitespace-pre-wrap break-all">{lineText === '' ? '\u00a0' : lineText}</span>
                          </div>
                        ))}
                        {hunk.afterLines.map((lineText, i) => (
                          <div key={`ad${i}`} className="flex gap-1.5 bg-emerald-500/10 px-2 text-emerald-200">
                            <span className="select-none text-emerald-400/70">+</span>
                            <span className="whitespace-pre-wrap break-all">{lineText === '' ? '\u00a0' : lineText}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {quickEditError && <p className="mt-1.5 text-[10px] text-rose-400">{quickEditError}</p>}
                  <div className="mt-1.5 flex items-center justify-end gap-2 text-[10px]">
                    <button
                      type="button"
                      onClick={discardQuickEdit}
                      className="rounded-md border border-white/[0.1] px-2 py-1 text-neutral-300 transition-colors hover:border-white/20 hover:text-white cursor-pointer"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={commitQuickEdit}
                      className="flex items-center gap-1 rounded-md bg-violet-300 px-2 py-1 font-semibold text-[#16121f] transition-colors hover:bg-violet-200 cursor-pointer"
                    >
                      <Check className="w-3 h-3" />
                      Apply
                    </button>
                  </div>
                </div>
              ) : (
                <>
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
                    <span className="font-mono">Enter to review · Esc to cancel</span>
                    <button
                      type="button"
                      onClick={() => void applyQuickEdit()}
                      disabled={!quickEditPrompt.trim() || isQuickEditing}
                      className="flex items-center gap-1 rounded-md bg-violet-300 px-2 py-1 font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-40 cursor-pointer"
                    >
                      {isQuickEditing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {isQuickEditing ? 'Writing' : 'Review'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {renameTarget && (
            <div
              role="dialog"
              aria-label="Rename symbol"
              className="absolute z-30 w-[300px] rounded-xl border border-white/[0.12] bg-ink-900/95 p-2 shadow-2xl backdrop-blur"
              style={{ top: renameTarget.top, left: renameTarget.left }}
            >
              <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <Pencil className="w-3 h-3 text-violet-300" />
                  Rename symbol
                  <span className="font-mono normal-case tracking-normal text-violet-300">{renameTarget.original}</span>
                </span>
                <button
                  type="button"
                  onClick={closeRename}
                  className="text-neutral-600 transition-colors hover:text-white cursor-pointer"
                  aria-label="Close rename"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onFocus={(event) => event.target.select()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void applyRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeRename();
                  }
                }}
                placeholder="New name"
                spellCheck={false}
                className="w-full rounded-lg border border-white/[0.09] bg-ink-950 px-2 py-1.5 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-300/40"
              />
              {renameError && <p className="mt-1.5 text-[10px] text-rose-400">{renameError}</p>}
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-neutral-600">
                <span className="font-mono">Enter to rename · Esc to cancel</span>
                <button
                  type="button"
                  onClick={() => void applyRename()}
                  disabled={!renameValue.trim() || isRenaming}
                  className="flex items-center gap-1 rounded-md bg-violet-300 px-2 py-1 font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-40 cursor-pointer"
                >
                  {isRenaming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pencil className="w-3 h-3" />}
                  {isRenaming ? 'Renaming' : 'Rename'}
                </button>
              </div>
            </div>
          )}
          {quickFixMenu && (
            <div
              role="menu"
              aria-label="Quick fixes"
              ref={quickFixMenuRef}
              className="absolute z-30 w-[320px] overflow-hidden rounded-xl border border-white/[0.12] bg-ink-900/95 shadow-2xl backdrop-blur"
              style={{ top: quickFixMenu.top, left: quickFixMenu.left }}
            >
              <div className="flex items-center justify-between border-b border-white/[0.07] px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <Lightbulb className="w-3 h-3 text-amber-300" />
                  Quick fixes
                </span>
                <button
                  type="button"
                  onClick={closeQuickFixes}
                  className="text-neutral-600 transition-colors hover:text-white cursor-pointer"
                  aria-label="Close quick fixes"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              {quickFixMenu.loading ? (
                <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-neutral-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-300" />
                  Looking for fixes…
                </div>
              ) : quickFixMenu.error ? (
                <p className="px-3 py-2.5 text-[11px] text-rose-400">{quickFixMenu.error}</p>
              ) : (
                quickFixMenu.actions.map((action, index) => (
                  <button
                    key={`${action.name}-${index}`}
                    type="button"
                    role="menuitem"
                    onClick={() => void applyQuickFix(action)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                  >
                    <Lightbulb className="mt-[1px] w-3.5 h-3.5 shrink-0 text-amber-300" />
                    <span className="min-w-0 flex-1">{action.description}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {activeFile && isMarkdownPreview ? (
            <div className="h-full overflow-auto bg-ink-950 px-5 py-4 sm:px-8">
              <article className="mx-auto max-w-4xl rounded-xl border border-white/[0.07] bg-ink-900/60 p-5 sm:p-8">
                {renderMarkdownContent(activeFile.content)}
              </article>
            </div>
          ) : activeFile ? (
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
          <div className="h-6 shrink-0 border-t border-white/[0.07] bg-ink-950 px-3 flex min-w-0 items-center justify-between gap-2 text-[10px] font-mono text-neutral-500 select-none whitespace-nowrap">
            <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
              <span className="shrink-0">{lineCount} lines</span>
              <span className="hidden shrink-0 lg:inline">{charCount} chars</span>
              <span className="hidden shrink-0 xl:inline">~{tokenEst} tokens</span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="uppercase text-neutral-400">{activeFile.language}</span>
              <span>UTF-8</span>
              <span className="hidden lg:inline">Spaces: 2</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /**
   * Loose files picked from disk have no parent folder of their own, so the
   * explorer must not invent one: render the root's children without its
   * header row. Files sit at the left edge; any real subfolder keeps its own
   * expander.
   */
  function renderLooseRootFiles(folder: ExplorerFolder): ReactNode {
    return (
      <div key="loose-root">
        {folder.files.map(({ file, index }) => renderExplorerFile({ file, index }, -1))}
        {folder.folders.map((child) => renderFolder(child, 0))}
      </div>
    );
  }

  function renderExplorerFile({ file, index }: ExplorerFile, depth: number): ReactNode {
    const isActive = index === activeFileIndex;
    const hasUnsaved = dirty.has(file.name);
    const isMarkdown = isMarkdownFile(file.name, file.language);
    return (
      <div
        key={`${file.name}-${index}`}
        className="group flex items-center min-w-0 pr-2"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '24px' }}
      >
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
          {isMarkdown && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMarkdownPreviewPath(file.name);
                onSelectFile(index);
              }}
              title={`Preview ${file.name}`}
              aria-label={`Preview ${file.name}`}
              className="rounded p-0.5 text-neutral-500 opacity-0 transition-opacity hover:text-violet-200 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
            >
              <Eye className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleDeleteFile(index);
            }}
            title="Delete file"
            className="opacity-0 group-hover:opacity-100 p-0.5 text-neutral-600 hover:text-red-400 transition-opacity cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  function renderFolder(folder: ExplorerFolder, depth: number, label?: string): ReactNode {
    const isExpanded = allFoldersExpanded || expandedFolders.has(folder.path);
    const folderLabel = label ?? folder.name;
    const isRoot = folder.path === '';
    const folderFiles = folder.files.map(({ file, index }) => renderExplorerFile({ file, index }, depth));
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
          style={{
            paddingLeft: `${8 + depth * 14}px`,
            contentVisibility: 'auto',
            containIntrinsicSize: '24px'
          }}
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
        <div className="group flex items-center min-w-0 pr-2">
          <button
            type="button"
            onClick={() => {
              toggleFolder(path);
              if (!isExpanded && !page) onLoadDirectory?.(path);
            }}
            aria-expanded={isExpanded}
            className="flex flex-1 min-w-0 items-center gap-1.5 py-1 text-left text-[11px] text-neutral-300 hover:bg-white/[0.03] cursor-pointer"
            style={{
              paddingLeft: `${8 + depth * 14}px`,
              contentVisibility: 'auto',
              containIntrinsicSize: '24px'
            }}
          >
            <ChevronRight className={`w-3 h-3 shrink-0 text-neutral-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            {isExpanded ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-300" /> : <Folder className="w-3.5 h-3.5 shrink-0 text-amber-300" />}
            <span className="truncate font-medium">{folderLabel}</span>
            {isLoading && <Loader2 className="ml-auto w-3 h-3 animate-spin text-neutral-500" />}
          </button>
          {canWriteToDisk && onDeleteEntry && path !== '' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleDeleteEntry(path, folderLabel, 'folder');
              }}
              title="Delete folder from disk"
              className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 text-neutral-600 hover:text-red-400 transition-opacity cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {isExpanded && (page?.entries ?? []).map((entry) => {
          if (entry.kind === 'directory') {
            return renderNativeFolder(entry.path, depth + 1, entry.name);
          }
          const index = files.findIndex((file) => file.name === entry.path);
          const isActive = index >= 0 && index === activeFileIndex;
          const isDirty = dirty.has(entry.path);
          const isMarkdown = isMarkdownFile(entry.path);
          return (
            <div key={entry.path} className="group flex items-center min-w-0 pr-2">
              <button
                type="button"
                onClick={() => index >= 0 ? onSelectFile(index) : onOpenPath?.(entry.path)}
                title={entry.path}
                className={`flex flex-1 min-w-0 items-center gap-1.5 rounded-md py-1 text-left transition-colors cursor-pointer ${isActive ? 'bg-violet-500/[.12] text-white' : 'text-neutral-400 hover:bg-white/[0.04]'}`}
                style={{
                  paddingLeft: `${22 + depth * 14}px`,
                  contentVisibility: 'auto',
                  containIntrinsicSize: '24px'
                }}
              >
                <FileCode2 className={`w-3 h-3 shrink-0 ${isActive ? 'text-violet-300' : 'text-neutral-500'}`} />
                <span className="font-mono text-[11px] truncate">{entry.name}</span>
                {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
              </button>
              {isMarkdown && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMarkdownPreviewPath(entry.path);
                    if (index >= 0) onSelectFile(index);
                    else onOpenPath?.(entry.path);
                  }}
                  title={`Preview ${entry.path}`}
                  aria-label={`Preview ${entry.path}`}
                  className="rounded p-0.5 text-neutral-500 opacity-0 transition-opacity hover:text-violet-200 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                >
                  <Eye className="h-3 w-3" />
                </button>
              )}
              {canWriteToDisk && onDeleteEntry && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteEntry(entry.path, entry.name, 'file');
                  }}
                  title="Delete file from disk"
                  className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 text-neutral-600 hover:text-red-400 transition-opacity cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
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
