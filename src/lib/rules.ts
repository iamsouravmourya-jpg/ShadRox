/**
 * Project rules: the instructions a folder writes about itself.
 *
 * Pure and synchronous over the tree the workspace already returned — no I/O,
 * so discovery stays testable and the Electron layer keeps owning the disk.
 * Everything here is deterministic: same files in, same bytes out, because the
 * compiled section is billed against the provider prompt cache and any reorder
 * costs the whole instruction again.
 */

import { matchesGlob } from './plugins/hook-engine';

export interface RuleSource {
  path: string;
  content: string;
}

export interface RuleGlobSection {
  pattern: string;
  body: string;
}

export interface ParsedRuleFile {
  always: string;
  globs: RuleGlobSection[];
  description: string;
}

export interface CompiledRules {
  text: string;
  used: string[];
  dropped: string[];
}

/** Past this a "rule" file is a log dump or a vendored copy, not instructions. */
export const MAX_RULE_FILE_BYTES = 64 * 1024;

export const RULES_SECTION_HEADER =
  'PROJECT RULES — instructions this folder asks the assistant to follow. Where two rules disagree, the later one wins; the user\'s own request always wins.';

const SHADROX_RULES_FILE = /^\.shadrox\/rules\/[^/]+\.md$/i;
/** General first, specific last, so a nested rule can override the project-wide one. */
const ROOT_RULE_NAMES: readonly string[] = ['SHADROX.md', 'AGENTS.md', 'QODER.md', '.cursorrules'];
const NESTED_RULE_BASENAME = 'agents.md';

const IGNORED_SEGMENTS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist_staging', 'dist_desktop',
  'build', '.next', 'out', 'coverage', '.cache', '.vercel', '.turbo', 'vendor', '__pycache__'
]);

const APPLY_TO_HEADING = /^ {0,3}#{1,6}[ \t]*apply-to:[ \t]*(\S.*?)[ \t]*$/i;
const APPLY_TO_LINE = /^ {0,3}apply-to:[ \t]*(\S.*?)[ \t]*$/i;
const APPLY_TO_INFO = /^apply-to:[ \t]*(\S.*?)[ \t]*$/i;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const KEY_VALUE_LINE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/;
const QUOTES = /^["']|["']$/g;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Workspace-relative and forward-slashed; null for anything that is not a usable path. */
function normalizeEntryPath(value: string): string | null {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path === '' || path.length > 1024 || path.includes('\0')) return null;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return path;
}

/** Directory segments only: `.cursorrules` at the root is a rule, not a dotfolder. */
function isVendored(path: string): boolean {
  const segments = path.split('/');
  return segments.slice(0, -1).some((segment, index) =>
    IGNORED_SEGMENTS.has(segment.toLowerCase()) ||
    (segment.startsWith('.') && !(index === 0 && segment === '.shadrox')));
}

function depthOf(path: string): number {
  return path.split('/').length - 1;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rootSlot(path: string): number {
  const index = ROOT_RULE_NAMES.findIndex((name) => name.toLowerCase() === path.toLowerCase());
  return index;
}

/**
 * The precedence bucket of a rule path: app rules, then the project-wide
 * manifests, then per-folder AGENTS.md. Unknown paths sort last but still load,
 * so a caller that hands over an extra file is never silently ignored.
 */
export function rulePrecedence(path: string): number {
  const normalized = normalizeEntryPath(path);
  if (!normalized) return 3;
  if (SHADROX_RULES_FILE.test(normalized)) return 0;
  if (normalized.includes('/')) return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase() === NESTED_RULE_BASENAME ? 2 : 3;
  return rootSlot(normalized) >= 0 ? 1 : 3;
}

function precedenceKey(path: string): [number, number, string] {
  const normalized = normalizeEntryPath(path) ?? path;
  const bucket = rulePrecedence(normalized);
  // The four root manifests keep their declared order; every other bucket is
  // ordered shallow-first so a folder rule sits after the rule above it.
  const rank = bucket === 1 && !normalized.includes('/') ? rootSlot(normalized) : depthOf(normalized);
  return [bucket, rank, normalized];
}

function compareByPrecedence(a: string, b: string): number {
  const left = precedenceKey(a);
  const right = precedenceKey(b);
  return left[0] - right[0] || left[1] - right[1] || compare(left[2], right[2]);
}

/** Rule paths worth loading, least specific first so a later rule wins. */
export function findRuleFiles(tree: ReadonlyArray<{ path: string; size: number }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of tree) {
    const path = normalizeEntryPath(entry.path);
    if (!path || seen.has(path)) continue;
    if (entry.size > MAX_RULE_FILE_BYTES || isVendored(path)) continue;
    if (rulePrecedence(path) === 3) continue;
    seen.add(path);
    found.push(path);
  }
  return found.sort(compareByPrecedence);
}

function stripFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return { meta: {}, body: content };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = KEY_VALUE_LINE.exec(line);
    if (!match) continue;
    meta[match[1].toLowerCase()] = match[2].trim().replace(QUOTES, '');
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

interface MutableSection {
  pattern: string | null;
  lines: string[];
}

/**
 * `apply-to` sections, in file order. A fence whose info string names a pattern
 * is a section body; a plain fence is content and keeps its delimiters, so the
 * markdown that reaches the model still parses.
 */
function scanSections(body: string): MutableSection[] {
  const sections: MutableSection[] = [{ pattern: null, lines: [] }];
  let current = sections[0];
  let capture: MutableSection | null = null;
  let fenceMarker: string | null = null;
  let fenceLength = 0;

  for (const line of body.split('\n')) {
    if (fenceMarker !== null) {
      const closing = FENCE_CLOSE.exec(line);
      if (closing && closing[1][0] === fenceMarker && closing[1].length >= fenceLength) {
        if (!capture) current.lines.push(line);
        fenceMarker = null;
        fenceLength = 0;
        capture = null;
        continue;
      }
      (capture ?? current).lines.push(line);
      continue;
    }

    const fence = FENCE_LINE.exec(line);
    if (fence) {
      const info = fence[2].trim();
      const applyTo = APPLY_TO_INFO.exec(info);
      if (applyTo) {
        capture = { pattern: applyTo[1].trim(), lines: [] };
        sections.push(capture);
        fenceMarker = fence[1][0];
        fenceLength = fence[1].length;
        continue;
      }
      current.lines.push(line);
      fenceMarker = fence[1][0];
      fenceLength = fence[1].length;
      continue;
    }

    const marker = APPLY_TO_HEADING.exec(line) ?? APPLY_TO_LINE.exec(line);
    if (marker) {
      current = { pattern: marker[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }

    current.lines.push(line);
  }

  return sections;
}

function firstHeading(body: string): string {
  for (const match of body.matchAll(/^ {0,3}#{1,6}[ \t]+(\S.*)$/gm)) {
    const text = match[1].trim();
    if (!APPLY_TO_INFO.test(text)) return text;
  }
  return '';
}

/** Lenient: anything unreadable comes back as one `always` section holding the body. */
export function parseRuleFile(content: string): ParsedRuleFile {
  const text = normalizeNewlines(typeof content === 'string' ? content : '');
  const { meta, body } = stripFrontMatter(text);
  const description = meta.description ?? firstHeading(body);

  const always: string[] = [];
  const globs: RuleGlobSection[] = [];
  for (const section of scanSections(body)) {
    const rendered = section.lines.join('\n').trim();
    if (!rendered) continue;
    if (section.pattern === null) {
      always.push(rendered);
      continue;
    }
    const existing = globs.find((entry) => entry.pattern === section.pattern);
    if (existing) existing.body = `${existing.body}\n\n${rendered}`;
    else globs.push({ pattern: section.pattern, body: rendered });
  }

  return { always: always.join('\n\n'), globs, description };
}

function applicableSections(parsed: ParsedRuleFile, activePaths: readonly string[]): string[] {
  const parts: string[] = [];
  if (parsed.always) parts.push(parsed.always);
  for (const section of parsed.globs) {
    if (activePaths.some((path) => matchesGlob(path, section.pattern))) parts.push(section.body);
  }
  return parts;
}

/**
 * The system-instruction section, cut at rule-file boundaries.
 *
 * The over-budget tail is dropped whole rather than trimmed: half a rule is
 * worse than none, because the model follows whatever survived and the user
 * cannot tell which clause went missing.
 */
export function compileRules(
  sources: RuleSource[],
  activePaths: readonly string[],
  budgetChars: number
): CompiledRules {
  const ordered = sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) =>
      compareByPrecedence(a.source.path, b.source.path) || a.index - b.index);

  const normalizedActive = activePaths
    .map((path) => normalizeEntryPath(path))
    .filter((path): path is string => path !== null);

  const chunks: Array<{ path: string; text: string }> = [];
  for (const entry of ordered) {
    const parts = applicableSections(parseRuleFile(entry.source.content), normalizedActive);
    if (parts.length === 0) continue;
    chunks.push({ path: entry.source.path, text: `RULES FROM ${entry.source.path}:\n${parts.join('\n\n')}` });
  }

  const used: string[] = [];
  const dropped: string[] = [];
  const kept: string[] = [];
  let size = RULES_SECTION_HEADER.length;

  for (let index = 0; index < chunks.length; index += 1) {
    const addition = chunks[index].text.length + 2;
    if (size + addition > budgetChars) {
      for (const rest of chunks.slice(index)) dropped.push(rest.path);
      break;
    }
    kept.push(chunks[index].text);
    used.push(chunks[index].path);
    size += addition;
  }

  return { text: kept.length === 0 ? '' : [RULES_SECTION_HEADER, ...kept].join('\n\n'), used, dropped };
}
