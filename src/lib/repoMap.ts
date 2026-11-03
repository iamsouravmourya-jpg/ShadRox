/**
 * Signature repo map.
 *
 * A 500-file folder used to reach the model as a list of names plus a handful
 * of retrieved files, which is not enough to plan a change across a codebase.
 * This turns the bytes that are already in memory into the shape of the repo:
 * every path, the signatures it declares, and the paths ranked by how much the
 * rest of the repo points at them, cut to fit a token budget.
 *
 * Pure and synchronous — no I/O, no dependencies, no parser. Regex is cheap
 * enough to re-run over the whole workspace on every request, and it is the
 * determinism guarantee the prompt cache relies on: same files in, same bytes
 * out, so ranking never shifts between turns for an unchanged tree.
 */

export type SignatureKind = 'function' | 'class' | 'type' | 'other';

export interface Signature {
  name: string;
  kind: SignatureKind;
  /** 1-based line the declaration sits on. */
  line: number;
  /** Declaration text, cut to MAX_SIGNATURE_CHARS so one line cannot eat the map. */
  text: string;
  /** Module specifier; only set for import signatures. */
  module?: string;
}

/** Files are passed in already read — this module never touches the disk. */
export interface MapInputFile {
  name: string;
  content: string;
}

export interface RepoMapOptions {
  /** Token allowance for the block; one token is charged as four characters. */
  tokenBudget: number;
  /** Already in the prompt verbatim; emitting them again bills the same bytes twice. */
  pinned?: readonly string[];
  /** The user's request, used to steer which files the walk personalises on. */
  query?: string;
  /** Paths the ranking should pull toward (open tabs, the active file). */
  personalization?: readonly string[];
}

export interface RankedFile {
  file: string;
  score: number;
}

/** file -> referencing file -> how many times it mentions the symbol. */
export type ReferenceCounts = Map<string, number>;
/** exported symbol -> the files that mention it. */
export type SymbolReferences = Map<string, ReferenceCounts>;
export interface GraphNode {
  /** Exported symbol -> who reads it. */
  refs: SymbolReferences;
  /** File -> weight of the references this file points at it with. */
  out: Map<string, number>;
}
/** file -> its reference edges. */
export type ReferenceGraph = Map<string, GraphNode>;

/** Every signature line already fits one prompt line, so it never spills over. */
export const MAX_SIGNATURE_CHARS = 100;

const HELP_PATTERNS: readonly LanguagePattern[] = [];
const ES_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'function', pattern: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,160})?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/ },
  { kind: 'class', pattern: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'class', pattern: /^class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'other', pattern: /^import\b/, module: true },
];

const PY_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'function', pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'class', pattern: /^class\s+([A-Za-z_]\w*)\b/ },
  { kind: 'other', pattern: /^(?:from\s+[\w.]+\s+)?import\s+[\w.]/, module: true },
];

const GO_PATTERNS: readonly LanguagePattern[] = [
  {
    kind: 'function',
    pattern: /^func\s+(?:\((?:\s*\w+\s+)?\*?([\w[\].]+)\)\s*)?([A-Za-z_]\w*)\s*\(/,
    name: (match) => (match[1] ? `${match[1]}.${match[2]}` : match[2]),
  },
  { kind: 'class', pattern: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ },
  { kind: 'type', pattern: /^type\s+([A-Za-z_]\w*)\s+\w+/ },
  { kind: 'other', pattern: /^import\s+(?:\(|")/, module: true },
];

const RUST_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'function', pattern: /^(?:pub(?:\([^)]{0,40}\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: 'class', pattern: /^(?:pub\s+)?(?:struct|union)\s+([A-Za-z_]\w*)/ },
  { kind: 'type', pattern: /^(?:pub\s+)?(?:enum|trait)\s+([A-Za-z_]\w*)/ },
  { kind: 'class', pattern: /^impl(?:<[^<>]{0,80}>)?\s+([A-Za-z_][\w:]*)/ },
  { kind: 'other', pattern: /^(?:pub\s+)?use\s/, module: true },
];

const JVM_PATTERNS: readonly LanguagePattern[] = [
  {
    kind: 'class',
    pattern:
      /^(?:(?:public|private|protected|internal)\s+)?(?:(?:static|final|abstract|sealed|readonly|record|data|open|nested)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/,
  },
  {
    kind: 'function',
    pattern:
      /^(?:public|private|protected|internal)\s+(?:(?:static|final|abstract|override|async|readonly|virtual|sealed|partial)\s+)*[\w<>[\],.\s]{1,60}?\s+([A-Za-z_]\w*)\s*\(/,
  },
  { kind: 'other', pattern: /^(?:import|package|using|namespace)\b/, module: true },
];

const PHP_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'class', pattern: /^\s{0,4}(?:(?:abstract|final)\s+)?class\s+([A-Za-z_]\w*)/ },
  { kind: 'type', pattern: /^\s{0,4}(?:interface|trait|enum)\s+([A-Za-z_]\w*)/ },
  { kind: 'function', pattern: /^\s{0,4}function\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'other', pattern: /^\s*(?:use|namespace|require(?:_once)?|include(?:_once)?)\b/, module: true },
];

const KOTLIN_PATTERNS: readonly LanguagePattern[] = [
  {
    kind: 'class',
    pattern:
      /^(?:@[\w.]+(?:\([^)]{0,60}\))?\s+)?(?:(?:data|sealed|open|abstract|inner|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/,
  },
  {
    kind: 'function',
    pattern: /^(?:(?:public|private|internal|protected|open|override|inline|suspend|operator|fun)\s+)*fun\s+(?:[\w.<>,\s]{1,60}\.)?([A-Za-z_]\w*)\s*\(/,
  },
  { kind: 'other', pattern: /^(?:import|package)\b/, module: true },
];

const SWIFT_PATTERNS: readonly LanguagePattern[] = [
  {
    kind: 'class',
    pattern:
      /^(?:@[\w.]+(?:\([^)]{0,60}\))?\s+)?(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(?:class|struct|enum|protocol|actor|extension)\s+([A-Za-z_]\w*)/,
  },
  {
    kind: 'function',
    pattern: /^(?:(?:public|private|internal|fileprivate|open|final|static|class|override|mutating|async)\s+)*func\s+([A-Za-z_]\w*)/,
  },
  { kind: 'other', pattern: /^import\s/, module: true },
];

const RUBY_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'function', pattern: /^\s*def\s+([A-Za-z_]\w*[?!=]?)/ },
  { kind: 'class', pattern: /^\s*(?:class|module)\s+([A-Z][\w:]*)/ },
  { kind: 'other', pattern: /^\s*(?:require|require_relative|load)\b/, module: true },
];

/** Nothing better than a keyword scan: still tells the model the file has shape. */
const GENERIC_PATTERNS: readonly LanguagePattern[] = [
  { kind: 'function', pattern: /^\s*(?:func|function|sub|proc|lambda)\s*[*(]?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'class', pattern: /^\s*(?:class|type)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:interface|struct|union|enum|protocol|trait|record)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'other', pattern: /^\s*(?:import|include|require|use|package)\b/, module: true },
];

interface LanguagePattern {
  kind: SignatureKind;
  pattern: RegExp;
  /** Set when the line is an import whose specifiers should be expanded. */
  module?: boolean;
  /** For declarations whose name spans two capture groups (Go methods). */
  name?: (match: RegExpMatchArray) => string;
}

const SIGNATURE_PATTERNS: Record<string, readonly LanguagePattern[]> = {
  '.ts': ES_PATTERNS,
  '.tsx': ES_PATTERNS,
  '.mts': ES_PATTERNS,
  '.cts': ES_PATTERNS,
  '.js': ES_PATTERNS,
  '.jsx': ES_PATTERNS,
  '.mjs': ES_PATTERNS,
  '.cjs': ES_PATTERNS,
  '.py': PY_PATTERNS,
  '.pyi': PY_PATTERNS,
  '.go': GO_PATTERNS,
  '.rs': RUST_PATTERNS,
  '.java': JVM_PATTERNS,
  '.cs': JVM_PATTERNS,
  '.php': PHP_PATTERNS,
  '.kt': KOTLIN_PATTERNS,
  '.kts': KOTLIN_PATTERNS,
  '.swift': SWIFT_PATTERNS,
  '.rb': RUBY_PATTERNS,
  '.md': HELP_PATTERNS,
  '.markdown': HELP_PATTERNS,
  '.txt': HELP_PATTERNS,
  '.json': HELP_PATTERNS,
  '.jsonc': HELP_PATTERNS,
  '.json5': HELP_PATTERNS,
  '.yaml': HELP_PATTERNS,
  '.yml': HELP_PATTERNS,
  '.toml': HELP_PATTERNS,
  '.ini': HELP_PATTERNS,
  '.env': HELP_PATTERNS,
  '.lock': HELP_PATTERNS,
  '.csv': HELP_PATTERNS,
  '.xml': HELP_PATTERNS,
  '.html': HELP_PATTERNS,
  '.css': HELP_PATTERNS,
  '.scss': HELP_PATTERNS,
  '.less': HELP_PATTERNS,
  '.sql': HELP_PATTERNS,
  '.sh': HELP_PATTERNS,
  '.bash': HELP_PATTERNS,
  '.zsh': HELP_PATTERNS,
  '.ps1': HELP_PATTERNS,
  '.bat': HELP_PATTERNS,
  '.cmd': HELP_PATTERNS,
};

/** The extensions that can be resolved as the target of a relative import. */
const RESOLVE_CANDIDATES = [
  '',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.py', '.go', '.rs', '.java', '.cs', '.php', '.kt', '.swift', '.rb',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
];

/** Above this a single line is minified or generated: nothing to extract, and scanning it is a trap. */
const MAX_LINE_CHARS = 400;
const MAX_SCAN_CHARS = 512_000;
/** One file must not dominate the map; the rest of its signatures stay unseen but counted. */
const MAX_SIGNATURES_PER_FILE = 8;
/** A symbol every other file mentions says nothing about which file matters. */
const MAX_SYMBOL_REACH = 0.5;
const MAX_MENTION_WEIGHT = 3;
const IMPORT_EDGE_WEIGHT = 5;
const PPR_DAMPING = 0.85;
const PPR_MAX_ITERATIONS = 25;
const PPR_CONVERGENCE = 1e-9;
const BUDGET_MIN_TOKENS = 1024;
const BUDGET_MAX_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
const TRAILER_RESERVE = 80;
const MAX_NAMES_PER_IMPORT = 12;

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const IMPORT_SOURCE = /['"]([^'"]{1,200})['"]/;
const IMPORT_BRACES = /\{([^{}]{0,400})\}/;
const RELATIVE_MODULE = /^\.{1,2}[/\\]/;
const ANCHOR_BASENAME = /^(?:readme(?:\.[\w-]*)?|package\.json|tsconfig[\w.-]*\.json)$/i;
const QUERY_STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
  'your', 'you', 'are', 'was', 'will', 'please', 'make', 'add', 'fix', 'change',
  'how', 'why', 'can', 'should', 'into', 'about', 'then', 'than',
]);

const KIND_RANK: Record<SignatureKind, number> = { function: 0, class: 1, type: 2, other: 3 };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const base = basenameOf(path);
  if (base.startsWith('tsconfig') && base.endsWith('.json')) return '.json';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_SIGNATURE_CHARS) return single;
  return `${single.slice(0, MAX_SIGNATURE_CHARS - 3)}...`;
}

function importSignatures(line: string, lineNo: number): Signature[] {
  const moduleMatch = IMPORT_SOURCE.exec(line);
  const source = moduleMatch
    ? moduleMatch[1]
    : /^(?:from\s+[\w.]+\s+)?(?:import|use|include|require)\s+([.\w]+(?:::[.\w]+)*)/.exec(line)?.[1];

  const braces = IMPORT_BRACES.exec(line);
  const head = braces
    ? braces[1]
    : line
        .split(/\s+from\s+/)[0]
        .replace(/^(?:from\s+[\w.]+\s+)?(?:import|require|require_once|include|include_once|load|use|namespace|package)\s+/, '');

  const names: string[] = [];
  for (const part of head.split(',')) {
    const identifiers = part.match(IDENTIFIER);
    // The last identifier is the local binding: `svc as server` and `a.b.c` both end in what the file can call.
    const local = identifiers ? identifiers[identifiers.length - 1] : '';
    if (local && !names.includes(local)) names.push(local);
    if (names.length >= MAX_NAMES_PER_IMPORT) break;
  }

  const text = truncate(line);
  return names.map((name) => ({ name, kind: 'other' as SignatureKind, line: lineNo, text, module: source }));
}

/** Whether a path can declare anything, so the reader skips pure data files. */
export function isMappablePath(name: string): boolean {
  return (SIGNATURE_PATTERNS[extensionOf(name)] ?? GENERIC_PATTERNS).length > 0;
}

export interface MapTreeEntry {
  path: string;
  size: number;
}

/** Past this size extractSignatures is never reached, so reading the file is waste. */
export const MAX_MAP_FILE_BYTES = 512_000;
export const MAX_MAP_TOTAL_BYTES = 6_000_000;
export const MAX_MAP_FILES = 1_500;

/**
 * Which paths of a folder deserve a read, decided from the tree the folder
 * already returned. Sizes come free with the tree, so the expensive judgement
 * — is this file big enough to swallow the budget — happens before any I/O.
 */
export function mapCandidates(
  tree: readonly MapTreeEntry[],
  limits: { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number } = {}
): string[] {
  const maxFiles = limits.maxFiles ?? MAX_MAP_FILES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_MAP_TOTAL_BYTES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_MAP_FILE_BYTES;
  const paths: string[] = [];
  let bytes = 0;
  for (const entry of tree) {
    if (paths.length >= maxFiles || bytes >= maxTotalBytes) break;
    if (!entry.path || !isMappablePath(entry.path) || entry.size > maxFileBytes) continue;
    bytes += entry.size;
    paths.push(entry.path);
  }
  return paths;
}

/** Regex per language over the lines already in memory; one pass per file. */
export function extractSignatures(name: string, content: string): Signature[] {
  const patterns = SIGNATURE_PATTERNS[extensionOf(name)] ?? GENERIC_PATTERNS;
  const signatures: Signature[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > MAX_LINE_CHARS) continue;
    if (line.indexOf('\u0000') >= 0) break;

    for (const entry of patterns) {
      if (entry.kind === 'other' && !entry.module && line.charCodeAt(0) > 32 && !/^\s/.test(line)) continue;
      const match = line.match(entry.pattern);
      if (!match) continue;

      for (const signature of entry.module ? importSignatures(line, index + 1) : []) {
        const key = `${signature.kind}:${signature.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signatures.push(signature);
      }
      if (entry.module) break;

      const declared = entry.name ? entry.name(match) : match[1];
      if (!declared) continue;
      const key = `${entry.kind}:${declared}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signatures.push({ name: declared, kind: entry.kind, line: index + 1, text: truncate(line) });
      break;
    }
  }

  return signatures;
}

function isScannable(file: MapInputFile, lines: readonly string[]): boolean {
  if (file.content.length === 0 || file.content.length > MAX_SCAN_CHARS) return false;
  for (const line of lines) {
    if (line.length > MAX_LINE_CHARS) return false;
    if (line.indexOf('\u0000') >= 0) return false;
  }
  return true;
}

function isExported(sig: Signature): boolean {
  return sig.text.startsWith('export ') || sig.kind !== 'other';
}

/** Symbols are the graph's vertices; imports and prose mentions are the edges. */
function isGraphSymbol(sig: Signature): boolean {
  return sig.kind !== 'other' && !sig.name.startsWith('_') && sig.name.length >= 3;
}

function addEdge(
  edges: Map<string, Map<string, number>>,
  from: string,
  to: string,
  weight: number
): void {
  if (from === to) return;
  const out = edges.get(from) ?? new Map<string, number>();
  out.set(to, (out.get(to) ?? 0) + weight);
  edges.set(from, out);
}

/**
 * Who references whose symbols, and how often.
 *
 * `signaturesByFile` lets the map renderer hand over the extraction it already
 * paid for; scanning a workspace twice per request is the one cost this feature
 * cannot pass on.
 */
export function buildGraph(
  files: readonly MapInputFile[],
  signaturesByFile?: ReadonlyMap<string, Signature[]>
): ReferenceGraph {
  const paths = files.map((file) => normalizePath(file.name));
  const symbols = signaturesByFile ?? indexSignatures(files);
  const ownerBySymbol = new Map<string, string[]>();
  const refs = new Map<string, Map<string, ReferenceCounts>>();
  const edges = new Map<string, Map<string, number>>();
  const known = new Set(paths);

  for (const path of paths) {
    for (const sig of symbols.get(path) ?? []) {
      if (!isGraphSymbol(sig)) continue;
      const owners = ownerBySymbol.get(sig.name);
      if (owners) owners.push(path);
      else ownerBySymbol.set(sig.name, [path]);
    }
  }

  for (let index = 0; index < files.length; index += 1) {
    const path = paths[index];
    const file = files[index];
    const own = new Map<string, number>();
    const fileRefs = new Map<string, ReferenceCounts>();
    refs.set(path, fileRefs);

    for (const sig of symbols.get(path) ?? []) {
      if (!isGraphSymbol(sig)) continue;
      if (!fileRefs.has(sig.name)) fileRefs.set(sig.name, new Map<string, number>());
    }

    if (!isScannable(file, file.content.split('\n'))) continue;

    // Mentions and imports become file->file edges on the spot: a second pass to
    // pair every file against every symbol is quadratic, and this is not.
    const tokens = file.content.split(/[^A-Za-z0-9_$]+/);
    const seenSelf = new Set((symbols.get(path) ?? []).map((sig) => sig.name));
    for (const token of tokens) {
      if (token.length < 3 || seenSelf.has(token)) continue;
      own.set(token, (own.get(token) ?? 0) + 1);
    }

    for (const [symbol, count] of own) {
      const owners = ownerBySymbol.get(symbol);
      if (!owners || owners.length === 0) continue;
      if (owners.length > 1 && owners.length > files.length * MAX_SYMBOL_REACH) continue;
      for (const owner of owners) {
        if (owner === path) continue;
        const byFile = refs.get(owner)?.get(symbol);
        if (byFile) byFile.set(path, (byFile.get(path) ?? 0) + 1);
        addEdge(edges, path, owner, Math.min(count, MAX_MENTION_WEIGHT));
      }
    }

    for (const sig of symbols.get(path) ?? []) {
      if (sig.kind !== 'other' || !sig.module || !RELATIVE_MODULE.test(sig.module)) continue;
      const owner = resolveImport(path, sig.module, known);
      if (!owner) continue;
      const byName = refs.get(owner)?.get(sig.name)
        ? sig.name
        : [...(refs.get(owner)?.keys() ?? [])][0] ?? '*';
      const byFile = refs.get(owner)?.get(byName);
      if (byFile) byFile.set(path, (byFile.get(path) ?? 0) + IMPORT_EDGE_WEIGHT);
      addEdge(edges, path, owner, IMPORT_EDGE_WEIGHT);
    }
  }

  const graph: ReferenceGraph = new Map();
  for (const path of paths) {
    graph.set(path, {
      refs: refs.get(path) ?? new Map<string, ReferenceCounts>(),
      out: edges.get(path) ?? new Map<string, number>()
    });
  }
  return graph;
}

export function indexSignatures(files: readonly MapInputFile[]): Map<string, Signature[]> {
  const out = new Map<string, Signature[]>();
  for (const file of files) out.set(normalizePath(file.name), extractSignatures(file.name, file.content));
  return out;
}

function resolveImport(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const joined = joinPath(dir, normalizePath(specifier));
  for (const candidate of RESOLVE_CANDIDATES) {
    const probe = joined + candidate;
    if (known.has(probe)) return probe;
  }
  return null;
}

function joinPath(dir: string, specifier: string): string {
  // The trailing slash of `dir` shows up as an empty segment; keeping it would
  // turn 'src/' + 'helper' into 'src//helper' and silently drop the edge.
  const segments = dir.split('/').filter((segment) => segment !== '');
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) {
    if (!QUERY_STOP_TERMS.has(match[0])) terms.add(match[0]);
  }
  return [...terms].sort();
}

function personalizationFor(
  nodes: readonly string[],
  personalization: readonly string[],
  query: string
): Float64Array {
  const weights = new Float64Array(nodes.length);
  const index = new Map<string, number>(nodes.map((node, position) => [node, position]));
  for (const path of personalization) {
    const position = index.get(normalizePath(path));
    if (position === undefined) continue;
    weights[position] += 1;
  }
  for (const term of queryTerms(query)) {
    for (let position = 0; position < nodes.length; position += 1) {
      const node = nodes[position];
      if (basenameOf(node).toLowerCase().includes(term)) weights[position] += 1;
      else if (node.toLowerCase().includes(term)) weights[position] += 0.5;
    }
  }
  return weights;
}

/**
 * Personalized PageRank over the reference graph (aider's ranking, simplified).
 *
 * Mass starts on the files the request is about and only ever walks to the
 * files they reference, so a hub the query never mentions cannot climb in.
 * A graph with no edges carries no information, so the order falls back to the
 * one thing that is always stable: the path.
 */
export function rankFiles(
  graph: ReferenceGraph,
  personalization: readonly string[] = [],
  query = ''
): RankedFile[] {
  const nodes = [...graph.keys()].sort();
  if (nodes.length === 0) return [];

  const position = new Map<string, number>(nodes.map((node, index) => [node, index]));
  const targets: number[][] = nodes.map(() => []);
  const shares: number[][] = nodes.map(() => []);
  let hasEdges = false;

  for (const [from, entry] of graph) {
    const source = position.get(from);
    if (source === undefined) continue;
    const total = [...entry.out.values()].reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) continue;
    hasEdges = true;
    for (const [to, weight] of entry.out) {
      const target = position.get(to);
      if (target === undefined) continue;
      targets[source].push(target);
      shares[source].push(weight / total);
    }
  }

  if (!hasEdges) return nodes.map((file) => ({ file, score: 0 }));

  const teleport = personalizationFor(nodes, personalization, query);
  let sum = teleport.reduce((total, value) => total + value, 0);
  if (sum <= 0) {
    teleport.fill(1 / nodes.length);
    sum = 1;
  } else {
    for (let i = 0; i < teleport.length; i += 1) teleport[i] /= sum;
  }

  let rank = Float64Array.from(teleport);
  const next = new Float64Array(nodes.length);

  for (let iteration = 0; iteration < PPR_MAX_ITERATIONS; iteration += 1) {
    next.fill(0);
    let dangling = 0;
    for (let source = 0; source < nodes.length; source += 1) {
      const mass = rank[source];
      if (mass === 0) continue;
      if (targets[source].length === 0) {
        dangling += mass;
        continue;
      }
      const carried = PPR_DAMPING * mass;
      for (let edge = 0; edge < targets[source].length; edge += 1) {
        next[targets[source][edge]] += carried * shares[source][edge];
      }
    }
    const rest = (1 - PPR_DAMPING) + dangling * PPR_DAMPING;
    let delta = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      next[i] += rest * teleport[i];
      delta += Math.abs(next[i] - rank[i]);
    }
    rank = Float64Array.from(next);
    if (delta < PPR_CONVERGENCE) break;
  }

  return nodes
    .map((file, index) => ({ file, score: rank[index] }))
    .sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function signaturePriority(sig: Signature): number {
  return (isExported(sig) ? 0 : 4) + KIND_RANK[sig.kind];
}

function pickSignatures(sigs: readonly Signature[]): Signature[] {
  const declared = sigs.filter((sig) => sig.kind !== 'other');
  const pool = declared.length > 0 ? declared : sigs;
  return pool
    .slice()
    .sort((a, b) => signaturePriority(a) - signaturePriority(b) || a.line - b.line)
    .slice(0, MAX_SIGNATURES_PER_FILE);
}

/**
 * aider's repo-map allowance: an eighth of the window, clamped.
 *
 * One number in, one number out, so no caller has to remember why the clamp
 * exists — a map that outranks the conversation itself is worse than no map.
 */
export function repoMapBudgetFor(contextWindowTokens: number): number {
  const share = Math.floor(contextWindowTokens / 8);
  return Math.max(BUDGET_MIN_TOKENS, Math.min(BUDGET_MAX_TOKENS, share));
}

/**
 * The map the system instruction gets.
 *
 * Anchors go first even when pinned: they cost one metadata line, not their
 * bytes, and a model that cannot see which project it is in plans badly
 * whatever else it can see. Everything else is ranked, then cut, and a file
 * that will not fit still shows its path and size so it can be asked for.
 */
/**
 * `signaturesByFile` carries the extraction across calls: it depends only on
 * the file bytes, so a new question re-ranks without re-scanning the folder.
 */
export function buildSignatureMap(
  files: readonly MapInputFile[],
  options: RepoMapOptions,
  signaturesByFile?: ReadonlyMap<string, Signature[]>
): string {
  if (files.length === 0) return '';

  const budget = CHARS_PER_TOKEN * Math.max(0, Math.floor(options.tokenBudget));
  if (budget <= 0) return '';

  const signatures = signaturesByFile ?? indexSignatures(files);
  const sizes = new Map<string, number>();
  const anchors: string[] = [];
  const paths = new Map<string, MapInputFile>();
  for (const file of files) {
    const path = normalizePath(file.name);
    paths.set(path, file);
    sizes.set(path, file.content.length);
    if (ANCHOR_BASENAME.test(basenameOf(path))) anchors.push(path);
  }
  anchors.sort();

  const pinned = new Set((options.pinned ?? []).map(normalizePath));
  const ranked = rankFiles(buildGraph(files, signatures), options.personalization ?? [], options.query ?? '');
  const included = new Set(anchors);
  const lines: string[] = [];
  let used = 0;
  let emitted = 0;
  let reserve = TRAILER_RESERVE;

  const push = (line: string): boolean => {
    if (used + line.length + 1 + reserve > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const path of anchors) push(`${path} · ${sizes.get(path) ?? 0} B`);

  for (const entry of ranked) {
    const path = entry.file;
    if (included.has(path) || pinned.has(path)) continue;
    const file = paths.get(path);
    const sigs = signatures.get(path) ?? [];
    if (!file) continue;
    included.add(path);
    emitted += 1;

    const size = sizes.get(path) ?? 0;
    const head = `${path} · ${file.content.split('\n').length} lines · ${size} B`;
    if (!push(head)) {
      included.delete(path);
      emitted -= 1;
      break;
    }

    reserve = 0;
    const shown = pickSignatures(sigs);
    for (const sig of shown) push(`  ${sig.text}`);
    if (shown.length > 0 || sigs.length === 0) {
      const hidden = Math.max(0, sigs.length - shown.length);
      if (hidden > 0) push(`  · ${hidden} more signature(s)`);
    } else {
      push(`  · ${sigs.length} signature(s) · ${size} B`);
    }
    reserve = TRAILER_RESERVE;
  }

  const omitted = files.length - included.size;
  if (omitted > 0) {
    const trailer = `… ${omitted} file(s) not shown — ask for them by path.`;
    if (used + trailer.length + 1 <= budget) lines.push(trailer);
  }

  return lines.join('\n');
}
