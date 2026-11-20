import { getDesktopBridge, type ShadRoxDesktopAPI, type WorkspaceTextEdit } from '../desktop';
import { relativeToRoot } from '../diagnostics';
import { groupEditsByFile, planFileEdits } from '../editor/edits';
import type { ToolDefinition, ToolOutcome } from './tools';

/**
 * Compiler-API code intelligence for the agent: find_references,
 * go_to_definition and rename_symbol.
 *
 * The TypeScript language service already lives in the main process
 * (electron/ts-service.cjs, TypeScript compiler API) and the desktop bridge
 * exposes it as definition/references/rename/workspaceSymbols. This module is
 * the agent-facing half: it resolves a symbol or a 1-based file:line into the
 * 0-based position the service wants, calls the real service, and formats
 * honest results. Nothing is guessed: a non-TS/JS file gets an explicit
 * "not supported yet", and a rename returns a multi-file EDIT SET (full new
 * contents + pinned versions + positioned hunks) that the host applies
 * atomically — this tool never writes to disk itself.
 */

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_REFERENCES = 200;
const MAX_OUTPUT_CHARS = 22_000;
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public'
]);

/** The language service answers with absolute paths; the host registers the
 * workspace root so results can be expressed workspace-relative. */
let workspaceRoot: string | null = null;
export function setCodeIntelRoot(rootPath: string | null): void {
  workspaceRoot = rootPath;
}

function refusal(message: string): ToolOutcome {
  return { ok: false, content: '', error: message, refused: true };
}

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isSupportedFile(path: string): boolean {
  return TS_EXTENSIONS.has(extensionOf(path));
}

function notSupported(path: string): ToolOutcome {
  return refusal(`code_intel supports TypeScript/JavaScript files only (.ts/.tsx/.js/.jsx and variants). "${path}" is not supported yet — use search_text and read_file for that file instead. No result was guessed.`);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asLine(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const line = Math.trunc(value);
  return line >= 1 ? line : null;
}

interface Position {
  line: number;
  character: number;
}

/** Identifier occurrences on one line, with their 0-based columns. */
function identifiersOnLine(lineText: string): Array<{ name: string; character: number }> {
  const found: Array<{ name: string; character: number }> = [];
  const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lineText)) !== null) {
    found.push({ name: match[0], character: match.index });
  }
  return found;
}

/**
 * Resolve the 0-based position the language service needs. An explicit symbol
 * on the named line wins; otherwise the first identifier on that line is used
 * (the editor's own go-to-definition convention).
 */
function positionOnLine(lineText: string, symbol: string | null, line: number): Position | null {
  const identifiers = identifiersOnLine(lineText);
  if (identifiers.length === 0) return null;
  const chosen = symbol
    ? identifiers.find((entry) => entry.name === symbol) ?? null
    : identifiers[0];
  if (!chosen) return null;
  return { line: line - 1, character: chosen.character };
}

/** Find a declaration-looking occurrence of `symbol` in the file, else the first. */
function declarationPosition(content: string, symbol: string): Position | null {
  const lines = content.split('\n');
  const declaration = new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum|namespace)\\s+${symbol}\\b`);
  const importExport = new RegExp(`\\b(?:import|export)\\b[^;\\n]*\\b${symbol}\\b`);
  let first: Position | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const identifiers = identifiersOnLine(lines[index]).filter((entry) => entry.name === symbol);
    if (identifiers.length === 0) continue;
    const position = { line: index, character: identifiers[0].character };
    if (!first) first = position;
    if (declaration.test(lines[index]) || importExport.test(lines[index])) return position;
  }
  return first;
}

async function resolveSymbolPosition(
  desktop: ShadRoxDesktopAPI,
  workspaceId: string,
  symbol: string,
  file: string | null
): Promise<{ path: string; position: Position } | null> {
  if (file) {
    const read = await desktop.readFile(workspaceId, file);
    const position = declarationPosition(read.content, symbol);
    return position ? { path: file, position } : null;
  }
  const symbols = await desktop.workspaceSymbols(workspaceId, symbol);
  const exact = symbols.filter((entry) => entry.name === symbol);
  const best = exact[0] ?? symbols[0];
  if (!best) return null;
  const path = relativeToRoot(workspaceRoot, best.file) ?? best.file;
  return { path, position: { line: best.line, character: best.character } };
}

function relativePath(absolute: string): string {
  return relativeToRoot(workspaceRoot, absolute) ?? absolute.replace(/\\/g, '/');
}

function clip(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(output bounded at ${MAX_OUTPUT_CHARS} chars)`;
}

/** One preview line per location, read once per file and cached. */
async function previewLines(desktop: ShadRoxDesktopAPI, workspaceId: string, paths: string[]): Promise<Map<string, string[]>> {
  const cache = new Map<string, string[]>();
  for (const path of [...new Set(paths)].slice(0, 40)) {
    try {
      const file = await desktop.readFile(workspaceId, path);
      cache.set(path, file.content.split('\n'));
    } catch {
      /* unreadable target: the location still stands, without a preview */
    }
  }
  return cache;
}

/* ------------------------------------------------------------------ *
 * find_references
 * ------------------------------------------------------------------ */

export async function handleFindReferences(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const desktop = getDesktopBridge();
  if (!desktop) return refusal('The desktop bridge is unavailable, so code intelligence cannot run.');
  if (!workspaceId) return refusal('find_references needs an opened folder workspace.');
  const symbol = asString(args.symbol);
  const file = asString(args.file);
  const line = asLine(args.line);
  if (!symbol && !(file && line)) return refusal('find_references needs symbol, or file plus line (1-based).');
  if (file && !isSupportedFile(file)) return notSupported(file);
  try {
    let target: { path: string; position: Position } | null = null;
    if (file && line) {
      const read = await desktop.readFile(workspaceId, file);
      const lines = read.content.split('\n');
      if (line > lines.length) return refusal(`${file} has ${lines.length} lines; line ${line} does not exist.`);
      const position = positionOnLine(lines[line - 1], symbol, line);
      if (!position) return refusal(`No identifier found on ${file}:${line}.`);
      target = { path: file, position };
    } else if (symbol) {
      target = await resolveSymbolPosition(desktop, workspaceId, symbol, null);
      if (!target) return refusal(`No symbol named "${symbol}" was found by the language service. Check the spelling with search_text first.`);
      if (!isSupportedFile(target.path)) return notSupported(target.path);
    }
    if (!target) return refusal('find_references could not resolve a position.');
    const references = await desktop.references(workspaceId, target.path, target.position.line, target.position.character);
    if (references.length === 0) {
      return { ok: true, content: `The language service found no references for "${symbol ?? 'the symbol'}" at ${target.path}:${target.position.line + 1}. It may be unused, or declared in a file the project config excludes.` };
    }
    const shown = references.slice(0, MAX_REFERENCES);
    const previews = await previewLines(desktop, workspaceId, shown.map((entry) => relativePath(entry.file)));
    const body = shown.map((entry) => {
      const path = relativePath(entry.file);
      const text = previews.get(path)?.[entry.line]?.trim().slice(0, 160) ?? '';
      return `${entry.isDefinition ? 'def' : 'ref'} ${path}:${entry.line + 1}:${entry.character + 1}${text ? `  ${text}` : ''}`;
    }).join('\n');
    return { ok: true, content: clip(`${references.length} reference(s)${references.length > shown.length ? ` (showing ${shown.length})` : ''} for "${symbol ?? 'symbol'}" at ${target.path}:${target.position.line + 1}:\n${body}`) };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ *
 * go_to_definition
 * ------------------------------------------------------------------ */

export async function handleGoToDefinition(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const desktop = getDesktopBridge();
  if (!desktop) return refusal('The desktop bridge is unavailable, so code intelligence cannot run.');
  if (!workspaceId) return refusal('go_to_definition needs an opened folder workspace.');
  const file = asString(args.file);
  const line = asLine(args.line);
  if (!file || !line) return refusal('go_to_definition needs file and line (1-based).');
  if (!isSupportedFile(file)) return notSupported(file);
  try {
    const read = await desktop.readFile(workspaceId, file);
    const lines = read.content.split('\n');
    if (line > lines.length) return refusal(`${file} has ${lines.length} lines; line ${line} does not exist.`);
    const position = positionOnLine(lines[line - 1], asString(args.symbol), line);
    if (!position) return refusal(`No identifier found on ${file}:${line}.`);
    const definitions = await desktop.definition(workspaceId, file, position.line, position.character);
    if (definitions.length === 0) {
      return { ok: true, content: `No definition found for the identifier at ${file}:${line}. It may be a global, a type the project config excludes, or a non-symbol token.` };
    }
    const shown = definitions.slice(0, 20);
    const previews = await previewLines(desktop, workspaceId, shown.map((entry) => relativePath(entry.file)));
    const body = shown.map((entry) => {
      const path = relativePath(entry.file);
      const target = previews.get(path);
      const snippet = target
        ? target.slice(Math.max(0, entry.line - 1), entry.line + 2).map((text, index) => `  ${entry.line + index}| ${text.slice(0, 160)}`).join('\n')
        : '';
      return `${entry.kind} ${entry.name} — ${path}:${entry.line + 1}:${entry.character + 1}${snippet ? `\n${snippet}` : ''}`;
    }).join('\n');
    return { ok: true, content: clip(`${definitions.length} definition(s):\n${body}`) };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ *
 * rename_symbol — produces an atomic multi-file edit SET, writes nothing.
 * ------------------------------------------------------------------ */

export interface RenameEditSet {
  kind: 'shadrox-edit-set';
  tool: 'rename_symbol';
  symbol: string;
  newName: string;
  /** Full new contents with the version each file had when the set was computed. */
  files: Array<{ path: string; expectedVersion: string; content: string }>;
  /** Positioned hunks (0-based), workspace-relative, for a span-based applier. */
  edits: Array<{ path: string; line: number; character: number; endLine: number; endCharacter: number; newText: string }>;
  apply: string;
}

export async function handleRenameSymbol(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const desktop = getDesktopBridge();
  if (!desktop) return refusal('The desktop bridge is unavailable, so code intelligence cannot run.');
  if (!workspaceId) return refusal('rename_symbol needs an opened folder workspace.');
  const file = asString(args.file);
  const symbol = asString(args.symbol);
  const newName = asString(args.newName);
  if (!file || !symbol || !newName) return refusal('rename_symbol needs file, symbol and newName.');
  if (!isSupportedFile(file)) return notSupported(file);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) return refusal(`newName "${newName}" is not a valid identifier.`);
  if (RESERVED_WORDS.has(newName)) return refusal(`newName "${newName}" is a reserved word.`);
  if (newName === symbol) return { ok: true, content: 'newName equals the current name — nothing to rename.' };
  if (!workspaceRoot) return refusal('The workspace root is not registered with code intelligence yet; reopen the folder and retry.');
  try {
    const read = await desktop.readFile(workspaceId, file);
    const position = declarationPosition(read.content, symbol);
    if (!position) return refusal(`Symbol "${symbol}" does not occur in ${file}. Read the file and check the exact name.`);
    const result = await desktop.rename(workspaceId, file, position.line, position.character, newName);
    if (!result.canRename) {
      return { ok: false, content: '', error: result.reason ?? 'The language service refused this rename.', refused: true };
    }
    if (result.edits.length === 0) return { ok: true, content: 'The language service produced no edits — nothing to rename.' };

    // Absolute service paths -> workspace-relative; anything outside the root
    // is dropped rather than guessed at.
    const relativeEdits: WorkspaceTextEdit[] = [];
    for (const edit of result.edits) {
      const path = relativeToRoot(workspaceRoot, edit.file);
      if (!path) continue;
      relativeEdits.push({ ...edit, file: path.replace(/\\/g, '/') });
    }
    if (relativeEdits.length === 0) return { ok: false, content: '', error: 'Every rename target resolved outside the workspace root; nothing was produced.' };

    // Read every touched file at its current version, then compute full new
    // contents with the same back-to-front applier the editor uses.
    const contents = new Map<string, { content: string; version: string }>();
    for (const path of groupEditsByFile(relativeEdits).keys()) {
      try {
        const current = await desktop.readFile(workspaceId, path);
        contents.set(path.toLowerCase(), { content: current.content, version: current.version });
      } catch {
        return { ok: false, content: '', error: `Could not read rename target ${path}; the edit set would be incomplete, so none was produced.` };
      }
    }
    const planned = planFileEdits(relativeEdits, (path) => contents.get(path.toLowerCase())?.content ?? null);
    const files = planned.map((plan) => ({
      path: plan.file,
      expectedVersion: contents.get(plan.file.toLowerCase())?.version ?? '',
      content: plan.content
    }));
    const editSet: RenameEditSet = {
      kind: 'shadrox-edit-set',
      tool: 'rename_symbol',
      symbol,
      newName,
      files,
      edits: relativeEdits.map((edit) => ({
        path: edit.file,
        line: edit.line,
        character: edit.character,
        endLine: edit.endLine,
        endCharacter: edit.endCharacter,
        newText: edit.newText
      })),
      apply: 'Apply atomically: stageFiles + commitTransaction (or saveFiles with each expectedVersion). Nothing was written by this tool.'
    };
    const json = JSON.stringify(editSet);
    const summary = `Rename "${symbol}" → "${newName}": ${files.length} file(s), ${relativeEdits.length} edit(s). The edit set below is NOT applied — apply it atomically (version-pinned) or discard it.`;
    if (json.length <= MAX_OUTPUT_CHARS) {
      return { ok: true, content: `${summary}\n\`\`\`shadrox:edit-set\n${json}\n\`\`\`` };
    }
    // Too many files for full contents in one result: the positioned hunks are
    // still a complete, applicable set — say so honestly instead of truncating.
    const lean = JSON.stringify({ ...editSet, files: files.map((entry) => ({ path: entry.path, expectedVersion: entry.expectedVersion })) });
    if (lean.length <= MAX_OUTPUT_CHARS) {
      return { ok: true, content: `${summary}\nFull contents exceed the output cap; apply the positioned edits (0-based spans, back-to-front per file) atomically.\n\`\`\`shadrox:edit-set\n${lean}\n\`\`\`` };
    }
    return { ok: false, content: '', error: `The rename touches ${files.length} files — too many for one bounded result. Rename in narrower scopes (per directory) instead.` };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ *
 * Registry surface.
 * ------------------------------------------------------------------ */

export const CODE_INTEL_TOOLS: ToolDefinition[] = [
  {
    name: 'find_references',
    description: 'Every reference to a symbol, from the real TypeScript language service (compiler API). Pass symbol alone to search the project, or file plus 1-based line for a position. TypeScript/JavaScript only; other files are refused honestly.',
    parameters: 'symbol?: string, file?: string (workspace-relative), line?: number (1-based)'
  },
  {
    name: 'go_to_definition',
    description: 'Where the identifier at a file:line is defined, with the declaration snippet. TypeScript/JavaScript only.',
    parameters: 'file: string (required), line: number (required, 1-based), symbol?: string (pick a specific identifier on the line)'
  },
  {
    name: 'rename_symbol',
    description: 'Rename a symbol and every reference the language service can reach, across files. Returns a version-pinned multi-file EDIT SET (full new contents + positioned hunks) inside a shadrox:edit-set fence — it writes NOTHING itself; the host applies the set atomically. TypeScript/JavaScript only.',
    parameters: 'file: string (required, where the symbol is declared), symbol: string (required), newName: string (required, valid identifier)'
  }
];

export const FIND_REFERENCES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'Symbol name; used alone it is resolved project-wide.' },
    file: { type: 'string', description: 'Workspace-relative TypeScript/JavaScript file.' },
    line: { type: 'integer', description: '1-based line holding the symbol.' }
  },
  additionalProperties: false
};

export const GO_TO_DEFINITION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Workspace-relative TypeScript/JavaScript file.' },
    line: { type: 'integer', description: '1-based line holding the identifier.' },
    symbol: { type: 'string', description: 'Optional: which identifier on the line.' }
  },
  required: ['file', 'line'],
  additionalProperties: false
};

export const RENAME_SYMBOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Workspace-relative file where the symbol is declared.' },
    symbol: { type: 'string', description: 'Current symbol name.' },
    newName: { type: 'string', description: 'New identifier; must be a valid, non-reserved name.' }
  },
  required: ['file', 'symbol', 'newName'],
  additionalProperties: false
};

export const CODE_INTEL_SCHEMAS: Record<string, Record<string, unknown>> = {
  find_references: FIND_REFERENCES_SCHEMA,
  go_to_definition: GO_TO_DEFINITION_SCHEMA,
  rename_symbol: RENAME_SYMBOL_SCHEMA
};