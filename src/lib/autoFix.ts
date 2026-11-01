import type { DesktopDiagnostic } from './desktop';
import type { FilePatch } from './markdown';

export interface WorkspaceTextFile {
  name: string;
  content: string;
}

export interface ExportEntry {
  file: string;
  name: string;
  kind: 'named' | 'default' | 'type';
}

export interface AutoImportResult {
  patches: FilePatch[];
  resolved: Array<{ file: string; symbol: string; importPath: string }>;
  unresolved: DesktopDiagnostic[];
  notes: string[];
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const IDENTIFIER_RE = new RegExp('^' + IDENTIFIER + '$');

const DECLARATION_RE = new RegExp(
  '^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?' +
    '(const|let|var|function\\*?|class|interface|type|enum)\\s+(' +
    IDENTIFIER +
    ')'
);
const DEFAULT_DECLARATION_RE = new RegExp(
  '^export\\s+default\\s+(?:async\\s+)?(?:function\\*?|abstract\\s+class|class)\\s+(' +
    IDENTIFIER +
    ')'
);
const DEFAULT_NAME_RE = new RegExp(
  '^export\\s+default\\s+(' + IDENTIFIER + ')\\s*;?\\s*$'
);
const BRACED_EXPORT_RE = /^export\s+(type\s+)?\{([^}]*)\}/;
const AS_ALIAS_RE = new RegExp('\\sas\\s+(' + IDENTIFIER + ')\\s*$');
const LEADING_IDENT_RE = new RegExp('^(' + IDENTIFIER + ')');
const TYPE_PREFIX_RE = /^type\s+/;
const DIAGNOSTIC_MESSAGE_RE = /Cannot find name '([A-Za-z_$][\w$]*)'/;
const DIRECTIVE_RE = /^(?:'use client'|"use client"|'use strict'|"use strict");?\s*$/;

function kindRank(kind: ExportEntry['kind']): number {
  if (kind === 'named') return 0;
  if (kind === 'type') return 1;
  return 2;
}

function registerExport(
  found: Map<string, ExportEntry>,
  file: string,
  name: string,
  kind: ExportEntry['kind']
): void {
  if (!IDENTIFIER_RE.test(name) || name === 'default') return;
  const existing = found.get(name);
  if (existing && kindRank(existing.kind) <= kindRank(kind)) return;
  found.set(name, { file, name, kind });
}

export function buildExportIndex(
  files: WorkspaceTextFile[]
): Map<string, ExportEntry[]> {
  const index = new Map<string, ExportEntry[]>();

  for (const file of files) {
    const found = new Map<string, ExportEntry>();

    for (const rawLine of file.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!/^export\b/.test(line)) continue;

      const declaration = line.match(DECLARATION_RE);
      if (declaration) {
        const keyword = declaration[1];
        const name = declaration[2];
        const kind: ExportEntry['kind'] =
          keyword === 'interface' || keyword === 'type' ? 'type' : 'named';
        registerExport(found, file.name, name, kind);
        continue;
      }

      const defaultDeclaration = line.match(DEFAULT_DECLARATION_RE);
      if (defaultDeclaration) {
        registerExport(found, file.name, defaultDeclaration[1], 'default');
        continue;
      }

      const braced = line.match(BRACED_EXPORT_RE);
      if (braced) {
        const typeOnly = Boolean(braced[1]);
        for (const rawSpecifier of braced[2].split(',')) {
          let specifier = rawSpecifier.trim();
          if (!specifier) continue;
          let kind: ExportEntry['kind'] = typeOnly ? 'type' : 'named';
          if (TYPE_PREFIX_RE.test(specifier)) {
            kind = 'type';
            specifier = specifier.replace(TYPE_PREFIX_RE, '');
          }
          const alias = specifier.match(AS_ALIAS_RE);
          const leading = specifier.match(LEADING_IDENT_RE);
          const name = alias ? alias[1] : leading ? leading[1] : null;
          if (name) registerExport(found, file.name, name, kind);
        }
        continue;
      }

      const defaultName = line.match(DEFAULT_NAME_RE);
      if (defaultName) {
        registerExport(found, file.name, defaultName[1], 'default');
      }
    }

    for (const entry of Array.from(found.values())) {
      const existing = index.get(entry.name);
      if (existing) existing.push(entry);
      else index.set(entry.name, [entry]);
    }
  }

  return index;
}

function isImportStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === 'import' || /^import[\s{]/.test(trimmed);
}

function importStatementEnd(lines: string[], start: number): number {
  let depth = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth > 0) continue;

    const trimmed = line.trim();
    if (trimmed.endsWith(';')) return i;

    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    const continues =
      trimmed.endsWith(',') ||
      trimmed.endsWith('\\') ||
      /\bfrom$/.test(trimmed) ||
      /^import(?:\s+type)?$/.test(trimmed) ||
      next === 'from' ||
      next.startsWith('from ') ||
      next.startsWith('from{') ||
      next.startsWith('} from') ||
      next.startsWith("'") ||
      next.startsWith('"');

    if (continues) continue;
    return i;
  }

  return lines.length - 1;
}

function hasImportBinding(content: string, name: string): boolean {
  const lines = content.split(/\r?\n/);
  const binding = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

  for (let i = 0; i < lines.length; i++) {
    if (!isImportStart(lines[i])) continue;
    const end = importStatementEnd(lines, i);
    if (binding.test(lines.slice(i, end + 1).join('\n'))) return true;
    i = end;
  }

  return false;
}

function findInsertionLine(lines: string[]): number {
  let insertion = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!isImportStart(lines[i])) continue;
    const end = importStatementEnd(lines, i);
    insertion = end + 1;
    i = end;
  }

  if (insertion > 0) return insertion;

  let start = 0;
  if (lines.length > 0 && lines[0].startsWith('#!')) start = 1;
  while (start < lines.length && DIRECTIVE_RE.test(lines[start].trim())) start++;
  return start;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function relativeModuleSpecifier(fromFile: string, toFile: string): string {
  const fromDirectory = normalizePath(fromFile).split('/').slice(0, -1);
  const target = normalizePath(toFile).split('/');
  const targetBase = target[target.length - 1] ?? '';
  const targetDirectory = target.slice(0, -1);

  let common = 0;
  while (
    common < fromDirectory.length &&
    common < targetDirectory.length &&
    fromDirectory[common] === targetDirectory[common]
  ) {
    common++;
  }

  const parts: string[] = [];
  for (let i = common; i < fromDirectory.length; i++) parts.push('..');
  parts.push(...targetDirectory.slice(common));

  const baseWithoutExtension = targetBase.replace(/\.(?:tsx?|jsx?|mjs)$/, '');
  if (baseWithoutExtension !== 'index') parts.push(baseWithoutExtension);

  let specifier = parts.join('/');
  if (!specifier) specifier = 'index';
  if (!specifier.startsWith('.')) specifier = './' + specifier;
  return specifier;
}

function buildImportStatement(
  symbol: string,
  kind: ExportEntry['kind'],
  specifier: string
): string {
  if (kind === 'default') return `import ${symbol} from '${specifier}';`;
  if (kind === 'type') return `import type { ${symbol} } from '${specifier}';`;
  return `import { ${symbol} } from '${specifier}';`;
}

export function planAutoImportFixes(
  diagnostics: DesktopDiagnostic[],
  files: WorkspaceTextFile[]
): AutoImportResult {
  const patches: FilePatch[] = [];
  const resolved: AutoImportResult['resolved'] = [];
  const unresolved: DesktopDiagnostic[] = [];
  const notes: string[] = [];
  const index = buildExportIndex(files);
  const fileByName = new Map<string, WorkspaceTextFile>();
  for (const file of files) fileByName.set(normalizePath(file.name), file);

  interface FilePlan {
    imports: Map<string, string>;
    resolved: Array<{ file: string; symbol: string; importPath: string }>;
  }
  const plans = new Map<string, FilePlan>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'TS2304') {
      unresolved.push(diagnostic);
      continue;
    }

    const messageMatch = diagnostic.message.match(DIAGNOSTIC_MESSAGE_RE);
    if (!messageMatch) {
      unresolved.push(diagnostic);
      continue;
    }
    const symbol = messageMatch[1];

    const diagnosticFile = fileByName.get(normalizePath(diagnostic.file));
    if (!diagnosticFile) {
      unresolved.push(diagnostic);
      notes.push(`No workspace file found for '${diagnostic.file}'.`);
      continue;
    }

    const candidates = index.get(symbol) ?? [];
    if (candidates.length === 0) {
      unresolved.push(diagnostic);
      notes.push(`No workspace export found for '${symbol}'.`);
      continue;
    }

    const candidateFiles = new Set<string>();
    for (const candidate of candidates) candidateFiles.add(normalizePath(candidate.file));
    if (candidateFiles.size > 1) {
      unresolved.push(diagnostic);
      notes.push(
        `Ambiguous import for '${symbol}': exported by ${Array.from(candidateFiles).join(', ')}.`
      );
      continue;
    }

    const normalizedCandidate = Array.from(candidateFiles)[0];
    if (normalizedCandidate === normalizePath(diagnostic.file)) {
      unresolved.push(diagnostic);
      notes.push(`'${symbol}' is declared in '${diagnostic.file}'; skipping self-import.`);
      continue;
    }

    if (hasImportBinding(diagnosticFile.content, symbol)) {
      notes.push(`'${symbol}' is already imported in '${diagnostic.file}'.`);
      continue;
    }

    let chosen = candidates[0];
    for (const candidate of candidates) {
      if (kindRank(candidate.kind) < kindRank(chosen.kind)) chosen = candidate;
    }

    const importPath = relativeModuleSpecifier(diagnostic.file, chosen.file);
    const statement = buildImportStatement(symbol, chosen.kind, importPath);

    let plan = plans.get(diagnosticFile.name);
    if (!plan) {
      plan = { imports: new Map(), resolved: [] };
      plans.set(diagnosticFile.name, plan);
    }
    if (plan.imports.has(symbol)) continue;

    plan.imports.set(symbol, statement);
    plan.resolved.push({ file: diagnostic.file, symbol, importPath });
  }

  for (const [fileName, plan] of Array.from(plans.entries())) {
    const file = fileByName.get(normalizePath(fileName));
    if (!file) continue;

    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const lines = file.content.split(/\r?\n/);
    const insertion = findInsertionLine(lines);
    const importLines = Array.from(plan.imports.values()).sort();
    const newContent = [
      ...lines.slice(0, insertion),
      ...importLines,
      ...lines.slice(insertion),
    ].join(eol);

    if (newContent === file.content) continue;

    patches.push({ path: file.name, content: newContent });
    resolved.push(...plan.resolved);
  }

  return { patches, resolved, unresolved, notes };
}
