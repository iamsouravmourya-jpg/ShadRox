/**
 * Aider-style ranked repo map, ported from aider.
 *
 * Algorithm ported from `aider/repomap.py` (RepoMap.get_ranked_tags,
 * get_ranked_tags_map_uncached, to_tree/render_tree) and `aider/special.py`
 * (filter_important_files / is_important) of https://github.com/Aider-AI/aider
 * — Copyright (c) Paul Gauthier, Apache License 2.0. Rationale: aider's post
 * "Building a better repository map" (website/_posts/2023-10-22-repomap.md) —
 * a whole-repo map whose files and symbols are ranked by a PageRank over the
 * symbol-reference graph lets the model plan cross-file changes without being
 * shown every file, inside a fixed token budget.
 *
 * Port notes (what is 1:1, what is adapted, and why):
 * - 1:1 with aider: the identifier -> definitions graph and the file-node
 *   personalization (update_graph half of get_ranked_tags, including the
 *   `100 / num_files` prior scale, max-not-sum for mentioned files, and the
 *   path-component matching against mentioned identifiers); the edge
 *   multipliers (mentioned ident x10, long snake/kebab/camel names x10,
 *   `_`-prefixed x0.1, more than five definers x0.1, referencer-is-a-chat-file
 *   x50, sqrt(reference count) dampening so high-frequency names do not
 *   dominate); the 0.1 self-edge for definitions nobody references; the
 *   distribution of each node's PageRank across its out-edges into
 *   per-(file, identifier) ranks; the descending (rank, file, ident) sort;
 *   chat-file exclusion from the rendered map; the important-files prefix;
 *   and the binary search that packs ranked tags into the token budget.
 * - 1:1 in semantics: page_rank. This aider release delegates to
 *   networkx.pagerank (alpha/damping 0.85, tol 1e-6, max_iter 100, nodes
 *   missing from the personalization dict get 0, the whole personalization
 *   vector is normalized once, and dangling-node mass is redistributed onto
 *   that vector); the identical power iteration is implemented here in
 *   TypeScript with the same normalization, including aider's
 *   ZeroDivisionError fallback to an unpersonalized run.
 * - Adapted: tree-sitter tag extraction (get_tags_raw) is replaced by the
 *   regex signature extractor from `../repoMap` for definitions plus
 *   identifier tokenization of the file bytes for references. The renderer
 *   ships no native parser, and the tokenized references are exactly
 *   aider's own pygments Name-token backfill applied to every file. The
 *   outline tool is per-file async IPC, so its symbol extraction cannot run
 *   over a whole folder synchronously.
 * - Adapted: aider's older common-file demotion (README, test-ish files,
 *   personal-name files) is ported as a 0.1x multiplier on the demoted
 *   file's prior and on edges pointing definitions into it; the current
 *   aider release only keeps the promotion side (filter_important_files,
 *   ported 1:1) and the many-definers penalty.
 * - Adapted: aider's tiktoken token_count is replaced with a chars/4
 *   estimate, the same billing rate `../repoMap` uses, so both map layers
 *   cut against one budget.
 */

import {
  type MapInputFile,
  type MapTreeEntry,
  type Signature,
  extractSignatures,
  mapCandidates
} from '../repoMap';

/** One symbol occurrence; the TypeScript shape of aider's Tag namedtuple. */
export interface RepoMapTag {
  relFname: string;
  fname: string;
  /** 1-based declaration line (aider's tags are 0-based; the conversion lives here). */
  line: number;
  name: string;
  kind: 'def' | 'ref';
}

/** One reference edge, the (src, dst, ident, weight) tuple aider adds to its MultiDiGraph. */
export interface WeightedEdge {
  src: string;
  dst: string;
  /** The identifier the edge was created for (aider's edge data "ident"). */
  ident: string;
  weight: number;
}

export interface RepoMapOptions {
  /** aider's max_map_tokens. Defaults to DEFAULT_MAP_TOKENS. */
  tokenBudget?: number;
  /** aider's chat_fnames: files already in the prompt (open tabs). Relative or absolute paths. */
  openTabs?: readonly string[];
  /** aider's mentioned_fnames: workspace-relative paths the user named. */
  mentionedPaths?: readonly string[];
  /** aider's mentioned_idents: identifiers the user named. */
  mentionedIdents?: readonly string[];
  /** Raw user request; paths and identifiers are lifted out of it when not supplied. */
  query?: string;
  /** Pre-read bytes. When given, no disk adapter runs. The folder bytes are already read once. */
  files?: readonly MapInputFile[];
  /** Reuse signature extraction someone already paid for, keyed by normalized relative path. */
  signaturesByFile?: ReadonlyMap<string, Signature[]>;
  /** Enumerate the folder (relative paths + byte sizes). Required when `files` is absent. */
  listFiles?: () => Promise<readonly MapTreeEntry[]>;
  /** Read one relative path. Required when `files` is absent. */
  readFile?: (relPath: string) => Promise<string | null>;
}

export const DEFAULT_MAP_TOKENS = 1024;
/** The billing rate of `../repoMap`; changing it here desynchronizes the two map layers. */
export const CHARS_PER_TOKEN = 4;
const MAX_LINE_CHARS = 400;
const MAX_REF_TOKENS_PER_FILE = 20_000;
/** Bounds for the read-from-disk path; the pre-read path is already bounded by useRepoMapFiles. */
const MAX_MAP_FILES = 1_500;
const MAX_MAP_TOTAL_BYTES = 6_000_000;
const DEMOTION = 0.1;
const PAGERANK_DAMPING = 0.85;
const PAGERANK_MAX_ITERATIONS = 100;
const PAGERANK_TOLERANCE = 1e-6;
const AIDER_ERROR_TOLERANCE = 0.15;
/** aider: edges into a chat-file referencer. */
const CHAT_REFERER_MUL = 50;

// ---------------------------------------------------------------------------
// Heuristics (aider special.py, ported 1:1; the older demotion, adapted)
// ---------------------------------------------------------------------------

/**
 * Port of ROOT_IMPORTANT_FILES (aider/special.py), trimmed to the entries a
 * coding map cares about. Only root-level paths match, like aider's
 * normpath comparison.
 */
const ROOT_IMPORTANT_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  'README',
  'README.md',
  'README.txt',
  'README.rst',
  'CONTRIBUTING.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CODEOWNERS',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  '.env',
  '.env.example',
  '.editorconfig',
  'tsconfig.json',
  'jsconfig.json',
  'webpack.config.js',
  'rollup.config.js',
  'jest.config.js',
  'pytest.ini',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'Dockerfile',
  'docker-compose.yml',
  'serverless.yml',
  'netlify.toml',
  'vercel.json',
  'schema.sql',
  'next.config.js',
  'openapi.yaml',
  'openapi.json',
  'mkdocs.yml',
  '_config.yml'
]);

/** Port of is_important(): the root-important list plus the .github/workflows rule. */
export function isImportantFile(relFname: string): boolean {
  const parts = relFname.split('/');
  const base = parts[parts.length - 1];
  if (parts.length === 2 && parts[0] === '.github' && base.endsWith('.yml')) return true;
  if (parts.length === 3 && parts[0] === '.github' && parts[1] === 'workflows' && base.endsWith('.yml')) return true;
  return ROOT_IMPORTANT_FILES.has(relFname);
}

/** Port of filter_important_files(). */
export function filterImportantFiles(relFnames: readonly string[]): string[] {
  return relFnames.filter(isImportantFile);
}

/**
 * Aider's older common-file demotion: README-style docs, files that only
 * hold tests, and files named like a person (`john-smith.ts`, `jane_doe.ts`)
 * say nothing that helps a plan. Adapted, not 1:1 — the current aider
 * release keeps only the promotion side of this idea.
 */
export function isDemotedFile(relFname: string): boolean {
  const base = relFname.slice(relFname.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  if (/^(readme|license|changelog|contributing|notice)/i.test(base)) return true;
  if (/\.(test|spec)\.[a-zA-Z]+$/.test(base)) return true;
  if (/(^|\/)(tests?|__tests__|specs?)(\/|$)/i.test(relFname)) return true;
  // Two plain lowercase words joined by one separator: a name, not a code noun.
  return /^[a-z]{2,12}[-_.][a-z]{2,12}$/.test(stem);
}

// ---------------------------------------------------------------------------
// Tag extraction (adapted: regex defs + tokenized refs, no tree-sitter)
// ---------------------------------------------------------------------------

export interface FileTags {
  relFname: string;
  fname: string;
  /** Definitions, one tag per declared name — aider's name.definition.* captures. */
  defs: RepoMapTag[];
  /**
   * identifier -> mention count; aider builds references[ident] as a list of
   * referring files and Counter()s it. The counts carry the same information.
   */
  refs: Map<string, number>;
}

const REF_TOKEN = /[A-Za-z_$][\w$]*/g;

/**
 * Def + ref tags for one file. Definitions come from the existing regex
 * signature extractor (shared with the signature map and the outline-style
 * listings); references are the file's identifier tokens — aider's pygments
 * backfill, applied everywhere because the extractor names only definitions.
 */
export function extractFileTags(
  relFname: string,
  fname: string,
  content: string,
  signatures?: readonly Signature[]
): FileTags {
  const sigs = signatures ?? extractSignatures(fname, content);
  const defs: RepoMapTag[] = [];
  for (const sig of sigs) {
    // aider maps name.definition.* -> def; imports ("other") are not definitions.
    if (sig.kind === 'other' || sig.name.length < 2) continue;
    defs.push({ relFname, fname, line: sig.line, name: sig.name, kind: 'def' });
  }

  const refs = new Map<string, number>();
  let tokens = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.length > MAX_LINE_CHARS || line.indexOf('\u0000') >= 0) continue;
    REF_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REF_TOKEN.exec(line)) !== null) {
      const name = match[0];
      if (name.length < 2) continue;
      refs.set(name, (refs.get(name) ?? 0) + 1);
      tokens += 1;
      if (tokens >= MAX_REF_TOKENS_PER_FILE) break;
    }
    if (tokens >= MAX_REF_TOKENS_PER_FILE) break;
  }
  return { relFname, fname, defs, refs };
}

// ---------------------------------------------------------------------------
// Graph construction (1:1 with the update_graph half of get_ranked_tags)
// ---------------------------------------------------------------------------

export interface RepoMapGraph {
  /** Files that earned at least one edge endpoint; the graph's nodes. */
  nodes: string[];
  edges: WeightedEdge[];
  /** rel -> prior mass, before normalization. */
  personalization: Map<string, number>;
  chatRelFnames: Set<string>;
  /** `${relFname}\u0000${ident}` -> the definition tags at that key. */
  definitions: Map<string, RepoMapTag[]>;
}

export interface GraphInputs {
  mentionedPaths?: ReadonlySet<string>;
  mentionedIdents?: ReadonlySet<string>;
  chatRelFnames?: ReadonlySet<string>;
}

const keyOf = (relFname: string, ident: string): string => `${relFname}\u0000${ident}`;

/**
 * aider's get_ranked_tags, minus the I/O: fold every file's tags into
 * defines / references / definitions / personalization, then lay out the
 * weighted identifier graph. Edge weights and multipliers mirror
 * repomap.py lines 383-514 exactly.
 */
export function buildTagGraph(files: readonly FileTags[], inputs: GraphInputs = {}): RepoMapGraph {
  const mentionedPaths = inputs.mentionedPaths ?? new Set<string>();
  const mentionedIdents = inputs.mentionedIdents ?? new Set<string>();
  const chatRelFnames = new Set<string>(inputs.chatRelFnames ?? []);

  const defines = new Map<string, Set<string>>();
  /** ident -> referring file -> count (Counter(references[ident])). */
  const references = new Map<string, Map<string, number>>();
  const definitions = new Map<string, RepoMapTag[]>();
  const personalization = new Map<string, number>();

  const rels = files.map((file) => file.relFname).sort();
  // aider: "Default personalization for unspecified files is 1/num_nodes",
  // scaled by the 100 he chose empirically.
  const personalize = rels.length > 0 ? 100 / rels.length : 0;

  for (const file of files) {
    const rel = file.relFname;
    let currentPers = 0;
    const isChat = chatRelFnames.has(rel);
    if (isChat) currentPers += personalize;
    if (mentionedPaths.has(rel)) {
      // max, not sum: aider avoids double-counting a chat file that is also mentioned.
      currentPers = Math.max(currentPers, personalize);
    }
    // Any path component, the basename, or the stem matching a mentioned ident personalizes once.
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const stem = base.replace(/\.[^.]+$/, '');
    const components = new Set<string>([...rel.split('/'), base, stem]);
    let identMatched = false;
    for (const component of components) {
      if (mentionedIdents.has(component)) {
        identMatched = true;
        break;
      }
    }
    if (identMatched) currentPers += personalize;
    if (isDemotedFile(rel)) currentPers *= DEMOTION;
    if (currentPers > 0) personalization.set(rel, currentPers);

    for (const tag of file.defs) {
      const owners = defines.get(tag.name);
      if (owners) owners.add(rel);
      else defines.set(tag.name, new Set([rel]));
      const key = keyOf(rel, tag.name);
      const list = definitions.get(key);
      if (list) list.push(tag);
      else definitions.set(key, [tag]);
    }
    for (const [ident, count] of file.refs) {
      const byFile = references.get(ident);
      if (byFile) byFile.set(rel, (byFile.get(rel) ?? 0) + count);
      else references.set(ident, new Map([[rel, count]]));
    }
  }

  // aider line 465: with no references at all, every definition references itself.
  if (references.size === 0) {
    for (const [ident, owners] of defines) {
      const byFile = new Map<string, number>();
      for (const owner of owners) byFile.set(owner, 1);
      references.set(ident, byFile);
    }
  }

  const edges: WeightedEdge[] = [];
  const nodes = new Set<string>();

  // aider lines 472-479: a small self-edge for definitions nobody references.
  for (const [ident, owners] of defines) {
    if (references.has(ident)) continue;
    for (const definer of owners) {
      edges.push({ src: definer, dst: definer, ident, weight: 0.1 });
      nodes.add(definer);
    }
  }

  const idents: string[] = [];
  for (const ident of defines.keys()) {
    if (references.has(ident)) idents.push(ident);
  }
  idents.sort();

  for (const ident of idents) {
    const definers = defines.get(ident) as Set<string>;
    let mul = 1.0;
    const isSnake = ident.includes('_') && /[a-zA-Z]/.test(ident);
    const isKebab = ident.includes('-') && /[a-zA-Z]/.test(ident);
    const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
    if (mentionedIdents.has(ident)) mul *= 10;
    if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
    if (ident.startsWith('_')) mul *= 0.1;
    if (definers.size > 5) mul *= 0.1;

    const byReferencer = references.get(ident) as Map<string, number>;
    for (const [referencer, rawCount] of byReferencer) {
      for (const definer of definers) {
        let useMul = mul;
        if (chatRelFnames.has(referencer)) useMul *= CHAT_REFERER_MUL;
        if (isDemotedFile(definer)) useMul *= DEMOTION;
        // aider: sqrt so high-frequency (low-value) mentions do not dominate.
        const weight = useMul * Math.sqrt(rawCount);
        edges.push({ src: referencer, dst: definer, ident, weight });
        nodes.add(referencer);
        nodes.add(definer);
      }
    }
  }

  return { nodes: [...nodes].sort(), edges, personalization, chatRelFnames, definitions };
}

// ---------------------------------------------------------------------------
// PageRank (networkx.pagerank semantics, damping 0.85, same normalization)
// ---------------------------------------------------------------------------

/**
 * Power iteration identical in behavior to the networkx.pagerank call aider
 * makes: damping 0.85, tol 1e-6, max 100 sweeps, parallel edge weights
 * summed (self-loops included in both totals), missing personalization keys
 * treated as 0, the vector normalized once, and dangling mass redistributed
 * onto the personalization vector. When the prior sums to zero, the
 * unpersonalized run (uniform 1/n prior) is used — aider's ZeroDivisionError
 * fallback, Issue #1536.
 */
export function pageRank(
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
  personalization?: ReadonlyMap<string, number>
): Map<string, number> {
  const n = nodes.length;
  if (n === 0) return new Map();
  const index = new Map<string, number>(nodes.map((node, position) => [node, position]));

  const targets: number[][] = nodes.map(() => []);
  const shares: number[][] = nodes.map(() => []);
  const outTotal = new Float64Array(n);
  const outWeight = new Map<string, number>();
  for (const edge of edges) {
    const src = index.get(edge.src);
    const dst = index.get(edge.dst);
    if (src === undefined || dst === undefined) continue;
    const pair = `${src}\u0000${dst}`;
    outWeight.set(pair, (outWeight.get(pair) ?? 0) + edge.weight);
    outTotal[src] += edge.weight;
  }
  for (const [pair, weight] of outWeight) {
    const [srcText, dstText] = pair.split('\u0000');
    const src = Number(srcText);
    targets[src].push(Number(dstText));
    shares[src].push(weight / outTotal[src]);
  }

  let prior = new Float64Array(n);
  let sum = 0;
  if (personalization) {
    for (const [node, value] of personalization) {
      const position = index.get(node);
      if (position === undefined || !(value > 0)) continue;
      prior[position] = value;
      sum += value;
    }
  }
  if (sum <= 0) prior.fill(1 / n);
  else for (let i = 0; i < n; i += 1) prior[i] /= sum;

  let s = new Float64Array(n).fill(1 / n);
  for (let iteration = 0; iteration < PAGERANK_MAX_ITERATIONS; iteration += 1) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let src = 0; src < n; src += 1) {
      const mass = s[src];
      if (mass === 0) continue;
      if (outTotal[src] === 0) {
        dangling += mass;
        continue;
      }
      const carried = PAGERANK_DAMPING * mass;
      const row = targets[src];
      for (let e = 0; e < row.length; e += 1) next[row[e]] += carried * shares[src][e];
    }
    const rest = 1 - PAGERANK_DAMPING + PAGERANK_DAMPING * dangling;
    let error = 0;
    for (let i = 0; i < n; i += 1) {
      next[i] += rest * prior[i];
      error += (next[i] - s[i]) * (next[i] - s[i]);
    }
    s = next;
    if (error < PAGERANK_TOLERANCE) break;
  }

  return new Map(nodes.map((node, position) => [node, s[position]]));
}

// ---------------------------------------------------------------------------
// Rank distribution + tag ranking (1:1 with repomap.py lines 533-572)
// ---------------------------------------------------------------------------

/** A ranked map entry: a definition line of one file, or the file alone (aider's `(fname,)` tuple). */
export interface RankedEntry {
  relFname: string;
  /** null marks a name-only entry: the file contributes its path, not code lines. */
  line: number | null;
  name: string;
}

export interface RankedResult {
  entries: RankedEntry[];
  nodeRank: Map<string, number>;
}

/**
 * Spread each file's PageRank over its out-edges by edge share, collect the
 * mass into (file, ident) definition ranks, expand them in aider's order,
 * then append graph nodes and unreferenced files as name-only entries.
 */
export function rankTags(graph: RepoMapGraph): RankedResult {
  const nodeRank = pageRank(graph.nodes, graph.edges, graph.personalization);

  // (dst, ident) -> accumulated rank, from every source's out-edge share.
  const rankedDefinitions = new Map<string, number>();
  const outWeight = new Map<string, number>();
  const bySrc = new Map<string, WeightedEdge[]>();
  for (const edge of graph.edges) {
    outWeight.set(edge.src, (outWeight.get(edge.src) ?? 0) + edge.weight);
    const row = bySrc.get(edge.src);
    if (row) row.push(edge);
    else bySrc.set(edge.src, [edge]);
  }
  for (const src of bySrc.keys()) {
    const srcRank = nodeRank.get(src) ?? 0;
    const total = outWeight.get(src) ?? 0;
    if (total <= 0) continue;
    for (const edge of bySrc.get(src) as WeightedEdge[]) {
      const key = keyOf(edge.dst, edge.ident);
      rankedDefinitions.set(key, (rankedDefinitions.get(key) ?? 0) + (srcRank * edge.weight) / total);
    }
  }

  // aider: reverse sort on (rank, (fname, ident)) — ties fall to descending path/ident.
  const sorted = [...rankedDefinitions.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ka = a[0].split('\u0000');
    const kb = b[0].split('\u0000');
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? 1 : -1;
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? 1 : -1;
    return 0;
  });

  const entries: RankedEntry[] = [];
  const filesIncluded = new Set<string>();
  for (const [key] of sorted) {
    const [fname] = key.split('\u0000');
    if (graph.chatRelFnames.has(fname)) continue;
    const tags = graph.definitions.get(key);
    if (!tags) continue;
    filesIncluded.add(fname);
    for (const tag of tags) entries.push({ relFname: tag.relFname, line: tag.line, name: tag.name });
  }

  // Bare graph nodes, best-ranked first (aider's top_rank loop).
  const topRank = [...nodeRank.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : (a[0] < b[0] ? 1 : -1)));
  for (const [fname] of topRank) {
    if (filesIncluded.has(fname) || graph.chatRelFnames.has(fname)) continue;
    filesIncluded.add(fname);
    entries.push({ relFname: fname, line: null, name: '' });
  }

  return { entries, nodeRank };
}

// ---------------------------------------------------------------------------
// Rendering + budget packing (1:1 to_tree/render_tree/binary search, adapted TreeContext)
// ---------------------------------------------------------------------------

/** aider truncates long lines "in case we get minified js or something else crazy". */
const MAX_RENDER_LINE_CHARS = 100;

/**
 * The rendered map of the first `count` ranked entries: `path:` headers over
 * the ranked definition lines read out of the file bytes, bare paths for
 * name-only entries. This is aider's to_tree + render_tree minus the
 * TreeContext scope-growing: the definitions themselves are the snippets.
 * aider sorts the included tags by filename inside the render (ranking only
 * decides inclusion); here the first rank position decides block order, so
 * the strongest file stays on top even after the slice cut.
 */
export function renderRankedEntries(
  entries: readonly RankedEntry[],
  contents: ReadonlyMap<string, string>,
  chatRelFnames: ReadonlySet<string>
): string {
  const order: string[] = [];
  const seen = new Set<string>();
  const lois = new Map<string, number[]>();
  for (const entry of entries) {
    const rel = entry.relFname;
    if (chatRelFnames.has(rel)) continue;
    if (!seen.has(rel)) {
      seen.add(rel);
      order.push(rel);
      // An empty row marks the bare entry: the file shows its path only.
      lois.set(rel, entry.line === null ? [] : [entry.line]);
      continue;
    }
    if (entry.line === null) continue;
    lois.get(rel)?.push(entry.line);
  }

  const blocks: string[] = [];
  for (const rel of order) {
    const lines = lois.get(rel) ?? [];
    if (lines.length === 0) {
      blocks.push(rel);
      continue;
    }
    const text = (contents.get(rel) ?? '').split('\n');
    const out = [`${rel}:`];
    for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
      out.push((text[line - 1] ?? '').trimEnd().slice(0, MAX_RENDER_LINE_CHARS));
    }
    blocks.push(out.join('\n'));
  }
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** aider's token_count with chars/4 billing (see the port notes). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Port of the binary search in get_ranked_tags_map_uncached: find how many
 * top ranked entries fit the budget, accept within 15% error, keep the
 * largest fitting render otherwise.
 */
export function fitToBudget(
  entries: readonly RankedEntry[],
  contents: ReadonlyMap<string, string>,
  chatRelFnames: ReadonlySet<string>,
  maxMapTokens: number
): string {
  if (entries.length === 0 || maxMapTokens <= 0) return '';
  let lowerBound = 0;
  let upperBound = entries.length;
  let bestTree = '';
  let bestTreeTokens = 0;
  let middle = Math.min(Math.floor(maxMapTokens / 25), entries.length);

  while (lowerBound <= upperBound) {
    const tree = renderRankedEntries(entries.slice(0, middle), contents, chatRelFnames);
    const numTokens = estimateTokens(tree);
    const pctErr = Math.abs(numTokens - maxMapTokens) / maxMapTokens;
    if ((numTokens <= maxMapTokens && numTokens > bestTreeTokens) || pctErr < AIDER_ERROR_TOLERANCE) {
      bestTree = tree;
      bestTreeTokens = numTokens;
      if (pctErr < AIDER_ERROR_TOLERANCE) break;
    }
    if (numTokens < maxMapTokens) lowerBound = middle + 1;
    else upperBound = middle - 1;
    middle = Math.floor((lowerBound + upperBound) / 2);
  }
  return bestTree;
}

// ---------------------------------------------------------------------------
// Mention extraction (aider derives these from the chat; adapted for one query)
// ---------------------------------------------------------------------------

const QUERY_PATH = /(?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,7}/g;
const QUERY_IDENT = /[A-Za-z_$][\w$]{2,}/g;

/** Paths and identifiers lifted from the user's request, aider's mentioned_* inputs. */
export function parseMentions(query: string): { paths: Set<string>; idents: Set<string> } {
  const paths = new Set<string>();
  const idents = new Set<string>();
  for (const match of query.matchAll(QUERY_PATH)) {
    const token = match[0].replace(/\\/g, '/');
    paths.add(token);
    // aider: get_ident_filename_matches — the stem of a cited file is a mentioned ident too.
    const base = token.slice(token.lastIndexOf('/') + 1);
    const stem = base.replace(/\.[^.]+$/, '');
    if (stem.length >= 3) idents.add(stem);
  }
  const dotted = [...paths];
  for (const match of query.matchAll(QUERY_IDENT)) {
    const word = match[0];
    if (dotted.some((p) => p.includes(word))) continue;
    idents.add(word);
  }
  return { paths, idents };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function toRel(path: string, rootPath: string): string {
  const normalized = path.replace(/\\/g, '/');
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\//, '');
}

/**
 * Build the aider-style ranked repo map for the folder at `rootPath`.
 *
 * Files arrive either pre-read (`opts.files` — the zero-open-tab invariant is
 * fed by the folder bytes `useRepoMapFiles` already loaded once per tree
 * change) or through the disk adapters (`opts.listFiles` + `opts.readFile`),
 * which keeps this module free of node/electron imports and renderer-safe.
 *
 * Returns the packed map string: ranked definitions of the files the rest
 * of the repo points at, cut to `tokenBudget`; '' when there is nothing to
 * rank. Files named in `openTabs` are excluded — their contents are already
 * in the prompt, exactly like aider's chat_fnames.
 */
export async function buildRepoMap(rootPath: string, opts: RepoMapOptions = {}): Promise<string> {
  const tokenBudget = Math.floor(opts.tokenBudget ?? DEFAULT_MAP_TOKENS);
  if (tokenBudget <= 0) return '';

  let inputs: readonly MapInputFile[];
  if (opts.files) {
    inputs = opts.files;
  } else if (opts.listFiles && opts.readFile) {
    const tree = await opts.listFiles();
    const paths = mapCandidates(tree).slice(0, MAX_MAP_FILES);
    const collected: MapInputFile[] = [];
    let read = 0;
    for (const path of paths) {
      if (collected.length >= MAX_MAP_FILES || read >= MAX_MAP_TOTAL_BYTES) break;
      const content = await opts.readFile(path);
      if (content === null) continue;
      if (read + content.length > MAX_MAP_TOTAL_BYTES) break;
      read += content.length;
      collected.push({ name: path, content });
    }
    inputs = collected;
  } else {
    return '';
  }
  if (inputs.length === 0) return '';

  const relSet = new Set<string>();
  const contents = new Map<string, string>();
  for (const file of inputs) {
    const rel = toRel(file.name, rootPath);
    if (!rel || relSet.has(rel)) continue;
    relSet.add(rel);
    contents.set(rel, file.content);
  }

  const chatRelFnames = new Set<string>((opts.openTabs ?? []).map((tab) => toRel(tab, rootPath)));
  const mentions = opts.query ? parseMentions(opts.query) : { paths: new Set<string>(), idents: new Set<string>() };
  const mentionedPaths = new Set<string>([
    ...mentions.paths,
    ...(opts.mentionedPaths ?? []).map((p) => toRel(p, rootPath))
  ]);
  // A path cited without its folder ("core.ts" for "src/core.ts") still personalizes.
  for (const token of [...mentionedPaths]) {
    if (token.includes('/')) continue;
    for (const rel of relSet) {
      if (rel.slice(rel.lastIndexOf('/') + 1) === token) mentionedPaths.add(rel);
    }
  }
  const mentionedIdents = new Set<string>([...mentions.idents, ...(opts.mentionedIdents ?? [])]);

  const files: FileTags[] = [];
  for (const rel of [...relSet].sort()) {
    const content = contents.get(rel) as string;
    files.push(extractFileTags(rel, rel, content, opts.signaturesByFile?.get(rel)));
  }

  const graph = buildTagGraph(files, {
    mentionedPaths,
    mentionedIdents,
    chatRelFnames: new Set([...chatRelFnames].filter((rel) => relSet.has(rel)))
  });
  // An empty graph is not an empty map: aider still emits the bare-name
  // inventory, which is the zero-open-tab promise this layer keeps.
  const { entries } = rankTags(graph);

  // aider's special_fnames prefix: root-important files not already shown earn a bare path line.
  const rankedFiles = new Set(entries.map((entry) => entry.relFname));
  const otherRelFnames = [...relSet].filter((rel) => !chatRelFnames.has(rel)).sort();
  const specials = filterImportantFiles(otherRelFnames)
    .filter((rel) => !rankedFiles.has(rel))
    .map((rel): RankedEntry => ({ relFname: rel, line: null, name: '' }));

  // Ungraphed files last, by path: the inventory promise for files the graph never touched.
  const graphed = new Set(graph.nodes);
  const alreadyShown = new Set<string>([...rankedFiles, ...specials.map((entry) => entry.relFname), ...chatRelFnames]);
  const stragglers = otherRelFnames
    .filter((rel) => !graphed.has(rel) && !alreadyShown.has(rel))
    .map((rel): RankedEntry => ({ relFname: rel, line: null, name: '' }));

  // aider widens the map when nothing is in the chat (map_mul_no_files), but only against
  // max_context_window, which this layer does not know; the caller bills one fixed budget.
  return fitToBudget([...specials, ...entries, ...stragglers], contents, chatRelFnames, tokenBudget);
}
