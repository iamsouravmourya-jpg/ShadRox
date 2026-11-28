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
import { countConceptClusterHits } from './conceptSynonyms';
import {
  fnv1aHash,
  loadWorkspaceIndexCache,
  saveWorkspaceIndexCache
} from './indexPersistence';

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
  /** Currently focused editor file (used for Active-Package Enterprise scoping). */
  activeFile?: string;
  /** True total file count when `files` / `diskFileTree` is truncated at 5,000. */
  totalFileCount?: number;
  /** Whether the workspace explorer tree walk hit its limit. */
  treeTruncated?: boolean;
  /** Optional full/discovered path list for computing the lightweight directory summary. */
  allTreePaths?: readonly string[];
}

export const DEFAULT_MAP_TOKENS = 1024;
/** The billing rate of `../repoMap`; changing it here desynchronizes the two map layers. */
export const CHARS_PER_TOKEN = 4;
/** Above this discovered file count, switch automatically to Active-Package + Priority-Root mode. */
export const LARGE_REPO_THRESHOLD = 3_000;
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
// Incremental content-hash cache (fixes the O(n^2) token x symbol rebuild)
// ---------------------------------------------------------------------------

/**
 * A file's tags depend only on its bytes, so re-tokenizing every file on every
 * turn is the quadratic cost that makes a 1,500-file repo slow. Keying the
 * extraction by `relFname + contentHash` lets an unchanged file reuse the tags
 * (and exported-symbol list) it already paid for; a changed file gets a fresh
 * key. The map bytes stay deterministic, so the prompt-cache prefix is stable.
 */
interface CachedFileTags {
  hash: string;
  tags: FileTags;
  /** Top exported symbol names, in declaration order (the OryTree badges). */
  exports: string[];
}
const fileTagsCache = new Map<string, CachedFileTags>();
const FILE_TAGS_CACHE_MAX = 3_500;
const ORY_TAGS_STORE_PREFIX = 'shadrox.oryTags.v1:';

/** FNV-1a over the file bytes; delegates to shared indexPersistence hash. */
function contentHash(content: string): string {
  return fnv1aHash(content);
}

const JS_TS_EXT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;

/** Exported / public (non-`other`) declaration names, de-duplicated, in source order. */
function exportedSymbolNames(signatures: readonly Signature[], relFname = ''): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const isJsTs = !relFname || JS_TS_EXT.test(relFname);
  const lower = relFname.toLowerCase();
  const isGo = lower.endsWith('.go');
  const isRust = lower.endsWith('.rs');
  for (const sig of signatures) {
    if (sig.kind === 'other') continue;
    if (isJsTs) {
      if (!sig.text.startsWith('export ')) continue;
    } else if (isGo) {
      const bare = sig.name.includes('.') ? sig.name.split('.').pop() ?? sig.name : sig.name;
      if (!/^[A-Z]/.test(bare)) continue;
    } else if (isRust) {
      if (!/^pub(?:\s|\()/.test(sig.text)) continue;
    } else {
      if (sig.name.startsWith('_')) continue;
    }
    if (seen.has(sig.name)) continue;
    seen.add(sig.name);
    names.push(sig.name);
  }
  return names;
}

/**
 * `extractFileTags` with a content-hash cache. Unchanged files return the
 * cached tags object (===) so a rebuild only re-folds references, never
 * re-tokenizes. `signaturesByFile` is honoured when the bytes are unchanged.
 */
export function extractFileTagsCached(
  relFname: string,
  content: string,
  signatures?: readonly Signature[]
): FileTags {
  const hash = contentHash(content);
  const cached = fileTagsCache.get(relFname);
  if (cached && cached.hash === hash) {
    fileTagsCache.delete(relFname);
    fileTagsCache.set(relFname, cached);
    return cached.tags;
  }
  const sigs = signatures ?? extractSignatures(relFname, content);
  const tags = extractFileTags(relFname, relFname, content, sigs);
  if (fileTagsCache.size >= FILE_TAGS_CACHE_MAX) {
    const oldest = fileTagsCache.keys().next().value;
    if (oldest !== undefined) fileTagsCache.delete(oldest);
  }
  fileTagsCache.set(relFname, { hash, tags, exports: exportedSymbolNames(sigs, relFname) });
  return tags;
}

/** Exported symbol names for a file, reusing the cached extraction. */
export function cachedExportedSymbols(
  relFname: string,
  content: string,
  signatures?: readonly Signature[]
): string[] {
  extractFileTagsCached(relFname, content, signatures);
  return fileTagsCache.get(relFname)?.exports ?? [];
}

/** Number of files held in the incremental cache (test/observability seam). */
export function repoMapCacheSize(): number {
  return fileTagsCache.size;
}

/** Drop the incremental cache (test seam; a long session is otherwise bounded). */
export function clearRepoMapCache(): void {
  fileTagsCache.clear();
}

interface SerializedFileTagEntry {
  relFname: string;
  hash: string;
  defs: RepoMapTag[];
  refs: Array<[string, number]>;
  exports: string[];
}

interface SerializedFileTagsSnapshot {
  v: 1;
  updatedAt: number;
  entries: SerializedFileTagEntry[];
}

/** Serialize the incremental FileTags cache (including >1.5 MB snapshots) for persistent storage. */
export function serializeFileTagsCache(): string {
  const entries: SerializedFileTagEntry[] = [];
  for (const [relFname, cached] of fileTagsCache) {
    entries.push({
      relFname,
      hash: cached.hash,
      defs: cached.tags.defs,
      refs: [...cached.tags.refs.entries()],
      exports: cached.exports
    });
  }
  const snapshot: SerializedFileTagsSnapshot = {
    v: 1,
    updatedAt: Date.now(),
    entries
  };
  return JSON.stringify(snapshot);
}

/**
 * Restore FileTags entries from JSON snapshot into `fileTagsCache`, validating
 * schema and optional expected FNV-1a file hashes so changed files never reuse
 * stale tags.
 */
export function hydrateFileTagsFromJson(
  raw: string,
  expectedHashes?: ReadonlyMap<string, string>
): number {
  let parsed: Partial<SerializedFileTagsSnapshot>;
  try {
    parsed = JSON.parse(raw) as Partial<SerializedFileTagsSnapshot>;
  } catch {
    return 0;
  }
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return 0;

  let restored = 0;
  for (const item of parsed.entries) {
    if (
      !item ||
      typeof item.relFname !== 'string' ||
      !item.relFname ||
      typeof item.hash !== 'string' ||
      !/^[0-9a-f]{8}$/i.test(item.hash) ||
      !Array.isArray(item.defs) ||
      !Array.isArray(item.refs) ||
      !Array.isArray(item.exports)
    ) {
      continue;
    }
    if (expectedHashes && expectedHashes.has(item.relFname) && expectedHashes.get(item.relFname) !== item.hash) {
      continue;
    }
    const refs = new Map<string, number>();
    for (const pair of item.refs) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number' && pair[1] > 0) {
        refs.set(pair[0], pair[1]);
      }
    }
    if (fileTagsCache.size >= FILE_TAGS_CACHE_MAX && !fileTagsCache.has(item.relFname)) {
      const oldest = fileTagsCache.keys().next().value;
      if (oldest !== undefined) fileTagsCache.delete(oldest);
    }
    fileTagsCache.set(item.relFname, {
      hash: item.hash,
      tags: {
        relFname: item.relFname,
        fname: item.relFname,
        defs: item.defs,
        refs
      },
      exports: item.exports.filter((sym): sym is string => typeof sym === 'string')
    });
    restored += 1;
  }
  return restored;
}

/** Persist the incremental FileTags cache beyond `localStorage` limits via Electron disk / IndexedDB. */
export async function persistFileTagsCache(workspaceId: string): Promise<void> {
  if (!workspaceId || fileTagsCache.size === 0) return;
  const json = serializeFileTagsCache();
  await saveWorkspaceIndexCache(workspaceId, 'ory-tags', json, `${ORY_TAGS_STORE_PREFIX}${workspaceId}`);
}

/** Restore persisted FileTags entries from Electron userData cache / IndexedDB / localStorage. */
export async function hydrateFileTagsCache(
  workspaceId: string,
  expectedHashes?: ReadonlyMap<string, string>
): Promise<number> {
  if (!workspaceId) return 0;
  const raw = await loadWorkspaceIndexCache(workspaceId, 'ory-tags', `${ORY_TAGS_STORE_PREFIX}${workspaceId}`);
  if (!raw) return 0;
  return hydrateFileTagsFromJson(raw, expectedHashes);
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

export interface OryDirectorySummary {
  dir: string;
  fileCount: number;
}

function directoryBucket(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  if (/^(?:packages|apps|services|modules|libs)$/i.test(parts[0]) && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}/`;
  }
  return `${parts[0]}/`;
}

export function buildDirectoryIndex(allPaths: readonly string[]): OryDirectorySummary[] {
  const counts = new Map<string, number>();
  for (const raw of allPaths) {
    const bucket = directoryBucket(raw);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, fileCount]) => ({ dir, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

function activePackagePrefixes(seeds: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const raw of seeds) {
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length <= 1) continue;
    if (/^(?:packages|apps|services|modules|libs)$/i.test(parts[0]) && parts.length >= 2) {
      prefixes.add(`${parts[0]}/${parts[1]}/`);
    } else if (parts.length >= 3) {
      prefixes.add(`${parts[0]}/${parts[1]}/`);
      prefixes.add(`${parts[0]}/`);
    } else {
      prefixes.add(`${parts[0]}/`);
    }
  }
  return [...prefixes];
}

const RELATIVE_IMPORT_SPEC = /(?:import|export)\s+(?:[^'"]{0,200}\s+from\s+)?['"](\.[^'"]{1,160})['"]|require\(\s*['"](\.[^'"]{1,160})['"]\s*\)/g;
const RELATIVE_TARGET_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function resolveOneHopImports(
  seedPaths: readonly string[],
  contents: ReadonlyMap<string, string>,
  availablePaths: ReadonlySet<string>
): string[] {
  const targets = new Set<string>();
  for (const seed of seedPaths) {
    const text = contents.get(seed);
    if (!text) continue;
    const baseParts = seed.split('/').slice(0, -1);
    RELATIVE_IMPORT_SPEC.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIVE_IMPORT_SPEC.exec(text)) !== null) {
      const spec = match[1] ?? match[2] ?? '';
      if (!spec.startsWith('.')) continue;
      const combined = [...baseParts];
      for (const seg of spec.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') combined.pop();
        else combined.push(seg);
      }
      const normalizedBase = combined.join('/');
      for (const ext of RELATIVE_TARGET_EXTS) {
        const candidate = `${normalizedBase}${ext}`;
        if (availablePaths.has(candidate)) {
          targets.add(candidate);
          break;
        }
      }
    }
  }
  return [...targets];
}

export interface EnterprisePartition {
  scopedPaths: string[];
  directoryIndex: OryDirectorySummary[];
  isEnterprise: boolean;
  totalFiles: number;
}

/**
 * Scope huge (>3,000-file) enterprise repositories down to Active-Package +
 * Priority-Root paths (max `MAX_MAP_FILES = 1,500`) while summarizing every
 * remaining directory in a lightweight path-only directory index.
 */
export function partitionEnterprisePaths(
  allPaths: readonly string[],
  options: {
    activeFile?: string;
    openTabs?: readonly string[];
    mentionedPaths?: readonly string[];
    maxFiles?: number;
    totalFileCount?: number;
    treeTruncated?: boolean;
  } = {}
): EnterprisePartition {
  const normalized = [...new Set(allPaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
  const totalFiles = Math.max(normalized.length, options.totalFileCount ?? 0);
  const isEnterprise = totalFiles > LARGE_REPO_THRESHOLD || Boolean(options.treeTruncated);
  const directoryIndex = buildDirectoryIndex(normalized);
  const maxFiles = options.maxFiles ?? MAX_MAP_FILES;
  if (!isEnterprise && normalized.length <= maxFiles) {
    return { scopedPaths: normalized, directoryIndex, isEnterprise, totalFiles };
  }

  const exactSeeds = new Set<string>(
    [options.activeFile, ...(options.openTabs ?? []), ...(options.mentionedPaths ?? [])]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
  );
  const pkgPrefixes = activePackagePrefixes([...exactSeeds]);

  const tierOf = (rel: string): number => {
    if (exactSeeds.has(rel)) return 0;
    if (pkgPrefixes.some((prefix) => rel.startsWith(prefix))) return 1;
    if (isImportantFile(rel)) return 2;
    if (/^(?:src|server|app|api)\//i.test(rel)) return 3;
    if (/^(?:packages|apps)\/[^/]+\/(?:src|server|app|api)\//i.test(rel)) return 4;
    return isDemotedFile(rel) ? 6 : 5;
  };

  const ordered = normalized.slice().sort((a, b) => {
    const diff = tierOf(a) - tierOf(b);
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return {
    scopedPaths: ordered.slice(0, maxFiles),
    directoryIndex,
    isEnterprise,
    totalFiles
  };
}

interface CollectedMapInputs {
  relSet: Set<string>;
  contents: Map<string, string>;
  enterpriseMode: boolean;
  totalWorkspaceFiles: number;
  directoryIndex?: OryDirectorySummary[];
}

/**
 * Resolve the folder bytes both map layers read: either pre-read `opts.files`
 * (the zero-open-tab invariant fed by `useRepoMapFiles`) or the disk adapters
 * `opts.listFiles` + `opts.readFile` (which keeps this module free of
 * node/electron imports and renderer-safe). Returns null when nothing is
 * readable. Automatically engages Active-Package + Priority-Root Enterprise
 * Mode above `LARGE_REPO_THRESHOLD` (3,000 files).
 */
async function collectMapInputs(
  rootPath: string,
  opts: RepoMapOptions
): Promise<CollectedMapInputs | null> {
  const mentions = opts.query ? parseMentions(opts.query) : { paths: new Set<string>(), idents: new Set<string>() };
  const seedOptions = {
    activeFile: opts.activeFile ? toRel(opts.activeFile, rootPath) : undefined,
    openTabs: (opts.openTabs ?? []).map((p) => toRel(p, rootPath)),
    mentionedPaths: [...mentions.paths, ...(opts.mentionedPaths ?? []).map((p) => toRel(p, rootPath))],
    totalFileCount: opts.totalFileCount,
    treeTruncated: opts.treeTruncated
  };

  if (opts.files) {
    if (opts.files.length === 0) return null;
    const byRel = new Map<string, string>();
    for (const file of opts.files) {
      const rel = toRel(file.name, rootPath);
      if (!rel || byRel.has(rel)) continue;
      byRel.set(rel, file.content);
    }
    const allPaths = opts.allTreePaths
      ? [...new Set([...opts.allTreePaths.map((p) => toRel(p, rootPath)), ...byRel.keys()])]
      : [...byRel.keys()];
    const partition = partitionEnterprisePaths(allPaths, seedOptions);
    if (!partition.isEnterprise) {
      return {
        relSet: new Set(byRel.keys()),
        contents: byRel,
        enterpriseMode: false,
        totalWorkspaceFiles: partition.totalFiles
      };
    }

    const availableKeys = new Set(byRel.keys());
    const activeSeedList = [seedOptions.activeFile, ...seedOptions.openTabs, ...seedOptions.mentionedPaths].filter(
      (v): v is string => Boolean(v && byRel.has(v))
    );
    const oneHop = resolveOneHopImports(activeSeedList, byRel, availableKeys);
    const chosen = new Set<string>();
    for (const rel of [...activeSeedList, ...oneHop, ...partition.scopedPaths]) {
      if (!byRel.has(rel)) continue;
      chosen.add(rel);
      if (chosen.size >= MAX_MAP_FILES) break;
    }
    const scopedContents = new Map<string, string>();
    for (const rel of chosen) {
      scopedContents.set(rel, byRel.get(rel) as string);
    }
    return {
      relSet: chosen,
      contents: scopedContents,
      enterpriseMode: true,
      totalWorkspaceFiles: partition.totalFiles,
      directoryIndex: partition.directoryIndex
    };
  }

  if (opts.listFiles && opts.readFile) {
    const tree = await opts.listFiles();
    const totalDiscovered = Math.max(tree.length, opts.totalFileCount ?? 0);
    const enterpriseMode = totalDiscovered > LARGE_REPO_THRESHOLD || Boolean(opts.treeTruncated);
    const allTreeRelPaths = tree.map((entry) => toRel(entry.path, rootPath));
    const directoryIndex = enterpriseMode ? buildDirectoryIndex(allTreeRelPaths) : undefined;

    let paths: string[];
    if (enterpriseMode) {
      const mappableSet = new Set(
        mapCandidates(tree, { maxFiles: tree.length, maxTotalBytes: Number.MAX_SAFE_INTEGER })
      );
      const partition = partitionEnterprisePaths([...mappableSet], {
        ...seedOptions,
        totalFileCount: totalDiscovered
      });
      paths = partition.scopedPaths;
    } else {
      paths = mapCandidates(tree).slice(0, MAX_MAP_FILES);
    }

    const relSet = new Set<string>();
    const contents = new Map<string, string>();
    let read = 0;
    for (const path of paths) {
      if (relSet.size >= MAX_MAP_FILES || read >= MAX_MAP_TOTAL_BYTES) break;
      const content = await opts.readFile(path);
      if (content === null) continue;
      if (read + content.length > MAX_MAP_TOTAL_BYTES) break;
      read += content.length;
      const rel = toRel(path, rootPath);
      if (!rel || relSet.has(rel)) continue;
      relSet.add(rel);
      contents.set(rel, content);
    }

    if (enterpriseMode && relSet.size < MAX_MAP_FILES && read < MAX_MAP_TOTAL_BYTES) {
      const allAvailable = new Set(allTreeRelPaths);
      const seedRel = [seedOptions.activeFile, ...seedOptions.openTabs, ...seedOptions.mentionedPaths].filter(
        (v): v is string => Boolean(v && contents.has(v))
      );
      const oneHop = resolveOneHopImports(seedRel, contents, allAvailable);
      for (const hop of oneHop) {
        if (relSet.has(hop) || relSet.size >= MAX_MAP_FILES || read >= MAX_MAP_TOTAL_BYTES) continue;
        const content = await opts.readFile(hop);
        if (content === null || read + content.length > MAX_MAP_TOTAL_BYTES) continue;
        read += content.length;
        relSet.add(hop);
        contents.set(hop, content);
      }
    }

    if (relSet.size === 0) return null;
    return {
      relSet,
      contents,
      enterpriseMode,
      totalWorkspaceFiles: totalDiscovered,
      ...(directoryIndex ? { directoryIndex } : {})
    };
  }

  return null;
}

/**
 * Build the aider-style ranked repo map for the folder at `rootPath`.
 *
 * Files arrive either pre-read (`opts.files` — the zero-open-tab invariant is
 * fed by the folder bytes `useRepoMapFiles` already loaded once per tree
 * change) or through the disk adapters (`opts.listFiles` + `opts.readFile`).
 *
 * Returns the packed map string: ranked definitions of the files the rest
 * of the repo points at, cut to `tokenBudget`; '' when there is nothing to
 * rank. Files named in `openTabs` are excluded — their contents are already
 * in the prompt, exactly like aider's chat_fnames.
 */
export async function buildRepoMap(rootPath: string, opts: RepoMapOptions = {}): Promise<string> {
  const tokenBudget = Math.floor(opts.tokenBudget ?? DEFAULT_MAP_TOKENS);
  if (tokenBudget <= 0) return '';

  const collected = await collectMapInputs(rootPath, opts);
  if (!collected) return '';
  const { relSet, contents } = collected;

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

  // Reuse the incremental cache: unchanged files keep their cached tags, so a
  // 1,500-file rebuild only re-folds references instead of re-tokenizing bytes.
  const files: FileTags[] = [];
  for (const rel of [...relSet].sort()) {
    files.push(extractFileTagsCached(rel, contents.get(rel) as string, opts.signaturesByFile?.get(rel)));
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

// ===========================================================================
// OryTree — unified RepoMap + Feature-Grouped Architecture Tree
// ===========================================================================
//
// The ranked repo map answers "which definitions matter most". OryTree adds the
// other half a refactor needs: which PRODUCT DOMAIN a file belongs to, and how
// big its blast radius is. It reuses the same aider graph (so the incremental
// FileTags cache and PageRank are shared, not duplicated) and renders each
// domain as a compact tree whose nodes carry a `[refs: N]` badge and top
// exported symbols — feature locality and blast-radius awareness in one budget.

export const ORY_DOMAIN_ORDER = ['LANDING', 'AUTH', 'DASHBOARD', 'BILLING', 'SETTINGS', 'API', 'SHARED'] as const;
export type OryDomainId = (typeof ORY_DOMAIN_ORDER)[number];

export const ORY_DOMAIN_LABELS: Record<OryDomainId, string> = {
  LANDING: '[LANDING / HOME]',
  AUTH: '[AUTH]',
  DASHBOARD: '[DASHBOARD]',
  BILLING: '[BILLING / PRICING]',
  SETTINGS: '[SETTINGS]',
  API: '[API / BACKEND]',
  SHARED: '[SHARED CORE]'
};

/** Path/symbol keyword probes per domain; SHARED is the unmatched fallback. */
const DOMAIN_KEYWORDS: Record<Exclude<OryDomainId, 'SHARED'>, RegExp> = {
  LANDING: /(?:^|\/)(?:landing|marketing|public|home|hero|cta)(?:\/|\.|$)|landing|marketing|hero|call[-_]?to[-_]?action/i,
  AUTH: /(?:^|\/)(?:auth|login|signin|sign-in|signup|sign-up|logout|session|oauth|jwt|password|credentials?|rbac|permissions?)(?:\/|\.|$)|auth|login|signin|signup|logout|session|oauth|jwt|password|credential|permission|rbac/i,
  DASHBOARD: /(?:^|\/)(?:dashboard|overview|analytics|feed|timeline|activity|reports?|charts?|metrics?)(?:\/|\.|$)|dashboard|overview|analytics|feed|timeline|report|chart|metric/i,
  BILLING: /(?:^|\/)(?:billing|pricing|price|payment|checkout|subscription|invoice|stripe|plans?|quota|usage)(?:\/|\.|$)|billing|pricing|payment|checkout|subscription|invoice|stripe|quota/i,
  SETTINGS: /(?:^|\/)(?:settings|preferences|prefs|profile|account|config)(?:\/|\.|$)|settings|preference|profile|account/i,
  API: /(?:^|\/)(?:api|server|backend|routes?|controllers?|handlers?|middleware|endpoints?|graphql|trpc|resolvers?|schema|services?|prisma|migrations?|routers?|webhooks?|workers?|jobs?|models?|repositories?)(?:\/|\.|$)|controller|middleware|resolver|endpoint|handler|webhook|repository/i
};

export interface OryFileNode {
  relFname: string;
  /** Reference count = distinct files that point at this one (blast radius). */
  refs: number;
  /** PageRank importance over the symbol graph (0..1). */
  rank: number;
  /** Top exported symbol names, declaration order, capped. */
  symbols: string[];
}

export interface OryDomain {
  id: OryDomainId;
  label: string;
  files: OryFileNode[];
  totalRefs: number;
}

export interface OryTree {
  domains: OryDomain[];
  /** The aider graph this tree was built from, cached for `get_dependents`. */
  graph: RepoMapGraph;
  nodeRank: Map<string, number>;
  refCounts: Map<string, number>;
  fileCount: number;
  truncated: boolean;
  /** True when discovered files exceeded `LARGE_REPO_THRESHOLD` (Active-Package Mode). */
  enterpriseMode?: boolean;
  /** Total discovered file count across the whole repo (e.g. 50,000). */
  totalWorkspaceFiles?: number;
  /** Lightweight path-only directory index for the unindexed remainder of the repo. */
  directoryIndex?: OryDirectorySummary[];
}

export type OryTreeOptions = RepoMapOptions;

/** Max exported symbols shown per node; keeps one file from eating the budget. */
const ORY_MAX_SYMBOLS = 4;

const DOMAIN_CLUSTER_MAP: Partial<Record<Exclude<OryDomainId, 'SHARED'>, readonly ('auth' | 'billing' | 'db' | 'api')[]>> = {
  AUTH: ['auth'],
  BILLING: ['billing'],
  API: ['api', 'db']
};

/**
 * Classify one file into a product domain from its path, exported symbols,
 * and shared Concept-Synonym Graph clusters (so hidden semantic names like
 * `session_gatekeeper.ts` classify as `AUTH` and `razorpay_webhook.ts` as `BILLING`).
 * `importDomains` breaks ties toward the feature it actually serves.
 */
export function classifyOryDomain(
  relFname: string,
  symbols: readonly string[],
  importDomains: readonly OryDomainId[] = []
): OryDomainId {
  // Normalize Windows separators so a raw `src\auth\login.ts` classifies the
  // same as the `/`-form the build loop passes in.
  const lower = relFname.replace(/\\/g, '/').toLowerCase();
  const symbolText = symbols.join(' ').toLowerCase();
  let best: OryDomainId = 'SHARED';
  let bestScore = 0;
  for (const id of ORY_DOMAIN_ORDER) {
    if (id === 'SHARED') continue;
    const probe = DOMAIN_KEYWORDS[id];
    const clusters = DOMAIN_CLUSTER_MAP[id];
    let score = 0;
    if (probe.test(lower)) score += 2;
    if (probe.test(symbolText)) score += 1;
    if (clusters) {
      score += 2 * Math.min(countConceptClusterHits(lower, clusters), 3);
      score += Math.min(countConceptClusterHits(symbolText, clusters), 3);
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (bestScore > 0) return best;
  // Import-edge inheritance: a SHARED file that only points at one feature
  // domain is part of that feature.
  const counts = new Map<OryDomainId, number>();
  for (const domain of importDomains) {
    if (domain === 'SHARED') continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let inherited: OryDomainId = 'SHARED';
  let inheritedCount = 0;
  for (const [domain, count] of counts) {
    if (count > inheritedCount) {
      inheritedCount = count;
      inherited = domain;
    }
  }
  return inherited;
}

/** Distinct files that reference each file, from the aider edge list. */
function referenceCountsFromGraph(graph: RepoMapGraph): Map<string, number> {
  const referencers = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.src === edge.dst) continue;
    const set = referencers.get(edge.dst);
    if (set) set.add(edge.src);
    else referencers.set(edge.dst, new Set([edge.src]));
  }
  const counts = new Map<string, number>();
  for (const [file, set] of referencers) counts.set(file, set.size);
  return counts;
}

/**
 * Build the unified OryTree for the folder at `rootPath`. Reads the same bytes
 * as `buildRepoMap` (pre-read `files` or the disk adapters) and reuses the
 * incremental FileTags cache, so a 1,500-file repo rebuilds in milliseconds.
 */
export async function buildOryTree(rootPath: string, opts: OryTreeOptions = {}): Promise<OryTree> {
  const collected = await collectMapInputs(rootPath, opts);
  if (!collected) {
    return { domains: [], graph: { nodes: [], edges: [], personalization: new Map(), chatRelFnames: new Set(), definitions: new Map() }, nodeRank: new Map(), refCounts: new Map(), fileCount: 0, truncated: false };
  }
  const { relSet, contents, enterpriseMode, totalWorkspaceFiles, directoryIndex } = collected;
  const chatRelFnames = new Set<string>((opts.openTabs ?? []).map((tab) => toRel(tab, rootPath)));

  const files: FileTags[] = [];
  const exportsByFile = new Map<string, string[]>();
  for (const rel of [...relSet].sort()) {
    const content = contents.get(rel) as string;
    const signatures = opts.signaturesByFile?.get(rel);
    files.push(extractFileTagsCached(rel, content, signatures));
    exportsByFile.set(rel, cachedExportedSymbols(rel, content, signatures));
  }

  const graph = buildTagGraph(files, {
    chatRelFnames: new Set([...chatRelFnames].filter((rel) => relSet.has(rel)))
  });
  const { nodeRank } = rankTags(graph);
  const refCounts = referenceCountsFromGraph(graph);

  // File -> the domains of the files it references (one hop), for tie-breaking.
  const importDomainsByFile = new Map<string, OryDomainId[]>();
  const domainByFile = new Map<string, OryDomainId>();
  for (const file of files) domainByFile.set(file.relFname, classifyOryDomain(file.relFname, exportsByFile.get(file.relFname) ?? []));
  const outNeighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.src === edge.dst) continue;
    const row = outNeighbors.get(edge.src);
    if (row) row.push(edge.dst);
    else outNeighbors.set(edge.src, [edge.dst]);
  }
  for (const file of files) {
    const neighbors = outNeighbors.get(file.relFname) ?? [];
    importDomainsByFile.set(file.relFname, neighbors.map((neighbor) => domainByFile.get(neighbor) ?? 'SHARED'));
  }
  // Second pass: SHARED files inherit the dominant domain of what they reference.
  for (const file of files) {
    if (domainByFile.get(file.relFname) !== 'SHARED') continue;
    domainByFile.set(file.relFname, classifyOryDomain(file.relFname, exportsByFile.get(file.relFname) ?? [], importDomainsByFile.get(file.relFname) ?? []));
  }

  const chatFiltered = new Set([...chatRelFnames].filter((rel) => relSet.has(rel)));
  const grouped = new Map<OryDomainId, OryFileNode[]>();
  for (const id of ORY_DOMAIN_ORDER) grouped.set(id, []);
  const MAX_TOTAL_NODES = 1_500;
  const priorityDirScore = (rel: string): number => {
    const norm = rel.replace(/\\/g, '/').toLowerCase();
    if (/^(?:src|server|app|api)\//.test(norm)) return 0;
    if (/^(?:packages|apps)\/[^/]+\/(?:src|server|app|api)\//.test(norm)) return 1;
    if (/^[^/]+\.[a-z0-9]+$/i.test(norm)) return 2;
    return 3;
  };
  const candidates = [...relSet]
    .filter((rel) => !chatFiltered.has(rel))
    .sort((a, b) => {
      const demoDiff = (isDemotedFile(a) ? 1 : 0) - (isDemotedFile(b) ? 1 : 0);
      if (demoDiff !== 0) return demoDiff;
      const rankDiff = (nodeRank.get(b) ?? 0) - (nodeRank.get(a) ?? 0);
      if (rankDiff !== 0) return rankDiff;
      const refDiff = (refCounts.get(b) ?? 0) - (refCounts.get(a) ?? 0);
      if (refDiff !== 0) return refDiff;
      const dirDiff = priorityDirScore(a) - priorityDirScore(b);
      if (dirDiff !== 0) return dirDiff;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const truncated = candidates.length > MAX_TOTAL_NODES;
  for (const rel of candidates.slice(0, MAX_TOTAL_NODES)) {
    const id = domainByFile.get(rel) ?? 'SHARED';
    const node: OryFileNode = {
      relFname: rel,
      refs: refCounts.get(rel) ?? 0,
      rank: nodeRank.get(rel) ?? 0,
      symbols: (exportsByFile.get(rel) ?? []).slice(0, ORY_MAX_SYMBOLS)
    };
    (grouped.get(id) as OryFileNode[]).push(node);
  }

  const domains: OryDomain[] = [];
  for (const id of ORY_DOMAIN_ORDER) {
    const nodes = grouped.get(id) as OryFileNode[];
    if (nodes.length === 0) continue;
    nodes.sort((a, b) => b.rank - a.rank || b.refs - a.refs || (a.relFname < b.relFname ? -1 : a.relFname > b.relFname ? 1 : 0));
    const totalRefs = nodes.reduce((sum, node) => sum + node.refs, 0);
    domains.push({ id, label: ORY_DOMAIN_LABELS[id], files: nodes, totalRefs });
  }

  return {
    domains,
    graph,
    nodeRank,
    refCounts,
    fileCount: relSet.size,
    truncated: truncated || enterpriseMode,
    ...(enterpriseMode ? { enterpriseMode, totalWorkspaceFiles, directoryIndex } : {})
  };
}

/** Directory prefix of a relative path, '' for a root file. */
function dirOf(relFname: string): string {
  const slash = relFname.lastIndexOf('/');
  return slash >= 0 ? relFname.slice(0, slash + 1) : '';
}

/**
 * Render an OryTree as a compact domain-grouped tree. Each file node shows its
 * relative path, a `[refs: N]` blast-radius badge, and its top exported
 * symbols. The render is cut to `tokenBudget` (chars/4), dropping whole domains
 * from the tail once the budget is spent — the strongest domains stay.
 */
export function renderOryTree(tree: OryTree, tokenBudget = DEFAULT_MAP_TOKENS): string {
  if (tree.domains.length === 0) return '';
  const maxChars = Math.max(0, Math.floor(tokenBudget)) * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  if (tree.enterpriseMode) {
    const dirSummary = (tree.directoryIndex ?? [])
      .slice(0, 8)
      .map((d) => `${d.dir} (${d.fileCount})`)
      .join(', ');
    const enterpriseHeader = `[ENTERPRISE REPO MODE: ${tree.fileCount}/${tree.totalWorkspaceFiles ?? tree.fileCount} active/priority files indexed${dirSummary ? `; dirs: ${dirSummary}` : ''}]`;
    if (used + enterpriseHeader.length + 1 <= maxChars || lines.length === 0) {
      lines.push(enterpriseHeader);
      used += enterpriseHeader.length + 1;
    }
  }
  for (const domain of tree.domains) {
    const header = `${domain.label} (${domain.files.length} files · refs ${domain.totalRefs})`;
    if (used + header.length + 1 > maxChars && lines.length > 0) break;
    lines.push(header);
    used += header.length + 1;
    let lastDir: string | null = null;
    for (const node of domain.files) {
      const dir = dirOf(node.relFname);
      if (dir !== lastDir) {
        if (dir) {
          const dirLine = `  ${dir}`;
          if (used + dirLine.length + 1 > maxChars) return `${lines.join('\n')}\n`;
          lines.push(dirLine);
          used += dirLine.length + 1;
        }
        lastDir = dir;
      }
      const base = dir ? node.relFname.slice(dir.length) : node.relFname;
      const badge = `[refs: ${node.refs}]`;
      const symbols = node.symbols.length > 0 ? ` {${node.symbols.join(', ')}}` : '';
      const nodeLine = `${dir ? '    ' : '  '}${base} ${badge}${symbols}`;
      if (used + nodeLine.length + 1 > maxChars) return `${lines.join('\n')}\n`;
      lines.push(nodeLine);
      used += nodeLine.length + 1;
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export interface OryDependent {
  file: string;
  weight: number;
  symbols: string[];
}

/**
 * Exact downstream dependents of the target files, read from the OryTree's
 * cached import graph (aider edges: src references dst). This is the blast
 * radius a refactor must check before touching shared code.
 */
export function dependentsFromGraph(
  graph: RepoMapGraph,
  targetPaths: readonly string[],
  limit = 20
): OryDependent[] {
  const targets = new Set(targetPaths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')));
  if (targets.size === 0 || limit <= 0) return [];
  const consumers = new Map<string, { weight: number; symbols: Set<string> }>();
  for (const edge of graph.edges) {
    if (!targets.has(edge.dst) || targets.has(edge.src)) continue;
    const entry = consumers.get(edge.src) ?? { weight: 0, symbols: new Set<string>() };
    entry.weight += edge.weight;
    entry.symbols.add(edge.ident);
    consumers.set(edge.src, entry);
  }
  return [...consumers]
    .map(([file, entry]) => ({ file, weight: entry.weight, symbols: [...entry.symbols].sort() }))
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, limit);
}
