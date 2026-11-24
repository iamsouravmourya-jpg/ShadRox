import { getDesktopBridge, type ShadRoxDesktopAPI } from '../desktop';
import { getApiKey } from '../storage';
import type { ToolDefinition, ToolOutcome } from './tools';

/**
 * Local incremental semantic search over the opened folder.
 *
 * Index: line-bounded chunks with extracted symbols, keyed by the bridge's
 * content-hash version, so a refresh re-chunks ONLY files whose bytes changed
 * (the bridge exposes no mtime; its `version` IS a content hash). Enumeration
 * walks listDirectory (the bridge already hides dot/generated dirs); contents
 * arrive through the bounded batch loadFiles path. The index persists in
 * localStorage per workspace and is mirrored best-effort to
 * `.shadrox/index.json` (the save path refuses to overwrite unmapped dot-files
 * after a restart, so the local copy stays authoritative — same contract as
 * project memory).
 *
 * Ranking: BM25 over camelCase-split tokens with symbol and path boosts —
 * strong, dependency-free, and ALWAYS available. When (and only when) the user
 * has a Gemini BYOK key configured, the BM25 shortlist is re-ranked with
 * text-embedding-004 cosine similarity (hybrid). No key is ever required; an
 * embedding failure degrades to the lexical result with an honest note.
 */

export const SEMANTIC_INDEX_PATH = '.shadrox/index.json';
const MAX_INDEX_FILES = 1_200;
const MAX_INDEX_CHUNKS = 6_000;
const MAX_INDEX_JSON_CHARS = 1_500_000;
const MAX_FILE_BYTES = 200_000;
const MAX_BATCH_BYTES = 3_000_000;
const LOAD_BATCH_SIZE = 40;
const MAX_DIRECTORY_CALLS = 400;
const MAX_DEPTH = 8;
const CHUNK_TARGET_CHARS = 1_200;
const CHUNK_MAX_LINES = 60;
const REFRESH_THROTTLE_MS = 20_000;
const EMBED_SHORTLIST = 16;
const EMBED_MODEL = 'text-embedding-004';
const EMBED_TIMEOUT_MS = 12_000;
const STORE_PREFIX = 'shadrox.semanticIndex.v1:';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'not', 'all', 'any', 'some', 'into', 'about', 'where',
  'what', 'which', 'how', 'why', 'when', 'you', 'your', 'our', 'their', 'its', 'but', 'because',
  'does', 'did', 'done', 'being', 'use', 'used', 'using', 'please', 'find', 'show', 'give', 'code',
  'file', 'files', 'function', 'return', 'const', 'let', 'var', 'import', 'export', 'default'
]);

export interface IndexChunk {
  id: string;
  startLine: number;
  endLine: number;
  text: string;
  symbols: string[];
}

export interface IndexedFile {
  version: string;
  chunks: IndexChunk[];
  /** Embedding vectors keyed by chunk id, present only after a BYOK rerank. */
  vectors?: Record<string, number[]>;
}

export interface SemanticIndex {
  v: 1;
  updatedAt: number;
  truncated: boolean;
  files: Record<string, IndexedFile>;
}

/* ------------------------------------------------------------------ *
 * Tokenization + chunking (pure, tested).
 * ------------------------------------------------------------------ */

/** Lowercase, camelCase-split, punctuation-split; stopwords never score. */
export function tokenize(text: string): string[] {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = expanded.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    for (const part of word.split(/[._-]+/)) {
      if (part.length >= 2 && !STOP_WORDS.has(part)) tokens.push(part);
    }
  }
  return tokens;
}

const SYMBOL_PATTERN = /\b(?:function|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_PATTERN = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

export function extractChunkSymbols(text: string): string[] {
  const symbols = new Set<string>();
  for (const pattern of [SYMBOL_PATTERN, EXPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null && symbols.size < 24) symbols.add(match[1]);
  }
  return [...symbols];
}

/** Split into ~CHUNK_TARGET_CHARS blocks on blank-line boundaries, 1-based lines. */
export function chunkText(content: string, fileKey: string): IndexChunk[] {
  const lines = content.split('\n');
  const chunks: IndexChunk[] = [];
  let start = 0;
  let buffer: string[] = [];
  let chars = 0;
  const flush = (endExclusive: number): void => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n');
    chunks.push({
      id: `${fileKey}#${chunks.length}`,
      startLine: start + 1,
      endLine: endExclusive,
      text: text.slice(0, CHUNK_TARGET_CHARS * 2),
      symbols: extractChunkSymbols(text)
    });
    buffer = [];
    chars = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    buffer.push(line);
    chars += line.length + 1;
    const atBlank = line.trim() === '';
    const tooBig = chars >= CHUNK_TARGET_CHARS || buffer.length >= CHUNK_MAX_LINES;
    if (tooBig && (atBlank || chars >= CHUNK_TARGET_CHARS * 1.5 || buffer.length >= CHUNK_MAX_LINES)) {
      flush(index + 1);
      start = index + 1;
    }
  }
  flush(lines.length);
  return chunks;
}

/* ------------------------------------------------------------------ *
 * BM25 + boosts (pure, tested).
 * ------------------------------------------------------------------ */

export interface ScoredChunk {
  path: string;
  chunk: IndexChunk;
  score: number;
}

export function bm25Rank(index: SemanticIndex, query: string, limit: number): ScoredChunk[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const entries: Array<{ path: string; chunk: IndexChunk; tokens: string[] }> = [];
  for (const [path, file] of Object.entries(index.files)) {
    for (const chunk of file.chunks) {
      entries.push({ path, chunk, tokens: tokenize(`${chunk.text} ${chunk.symbols.join(' ')}`) });
    }
  }
  if (entries.length === 0) return [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const entry of entries) {
    totalLength += entry.tokens.length;
    const seen = new Set(entry.tokens);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const averageLength = totalLength / entries.length || 1;
  const k1 = 1.5;
  const b = 0.75;
  const scored: ScoredChunk[] = [];
  for (const entry of entries) {
    const frequencies = new Map<string, number>();
    for (const token of entry.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    const lowerPath = entry.path.toLowerCase();
    const symbolSet = new Set(entry.chunk.symbols.map((symbol) => symbol.toLowerCase()));
    for (const token of queryTokens) {
      const tf = frequencies.get(token) ?? 0;
      const df = documentFrequency.get(token) ?? 0;
      if (df > 0 && tf > 0) {
        const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (entry.tokens.length / averageLength))));
      }
      // Symbol and path evidence: a chunk DEFINING the queried name outranks a
      // chunk that merely mentions it, and a matching file name is a strong hint.
      if (symbolSet.has(token)) score += 2.0;
      if (lowerPath.includes(token)) score += 0.75;
    }
    if (score > 0) scored.push({ path: entry.path, chunk: entry.chunk, score });
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.chunk.startLine - right.chunk.startLine);
  return scored.slice(0, limit);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------------------ *
 * Index lifecycle: load, incremental refresh, persist.
 * ------------------------------------------------------------------ */

const memoryIndexes = new Map<string, SemanticIndex>();
const lastRefresh = new Map<string, number>();

export function resetSemanticIndexCache(): void {
  memoryIndexes.clear();
  lastRefresh.clear();
}

export function evictSemanticIndex(workspaceId: string): void {
  if (!workspaceId) return;
  memoryIndexes.delete(workspaceId);
  lastRefresh.delete(workspaceId);
}

function emptyIndex(): SemanticIndex {
  return { v: 1, updatedAt: 0, truncated: false, files: {} };
}

function loadPersisted(workspaceId: string): SemanticIndex | null {
  try {
    const raw = localStorage.getItem(`${STORE_PREFIX}${workspaceId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SemanticIndex;
    if (!parsed || parsed.v !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(workspaceId: string, index: SemanticIndex): void {
  memoryIndexes.set(workspaceId, index);
  try {
    const json = JSON.stringify(index);
    if (json.length <= MAX_INDEX_JSON_CHARS) {
      localStorage.setItem(`${STORE_PREFIX}${workspaceId}`, json);
    }
  } catch {
    /* quota: the in-memory index still serves this session */
  }
}

/** Best-effort on-disk mirror; a refusal never fails the search. */
async function mirrorIndex(desktop: ShadRoxDesktopAPI, workspaceId: string, index: SemanticIndex): Promise<void> {
  try {
    const json = JSON.stringify(index);
    if (json.length > 1_900_000) return;
    await desktop.saveFiles(workspaceId, [{ name: SEMANTIC_INDEX_PATH, content: json }]);
  } catch {
    /* hidden-path save rules: local copy stays authoritative */
  }
}

/** Enumerate visible files through the bridge's own filtered directory walk. */
async function enumerateFiles(desktop: ShadRoxDesktopAPI, workspaceId: string): Promise<{ paths: string[]; capped: boolean }> {
  const paths: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  let calls = 0;
  let capped = false;
  while (queue.length > 0) {
    if (calls >= MAX_DIRECTORY_CALLS || paths.length >= MAX_INDEX_FILES) { capped = true; break; }
    const current = queue.shift() as { path: string; depth: number };
    let cursor: number | undefined;
    do {
      calls += 1;
      let page;
      try {
        page = await desktop.listDirectory(workspaceId, current.path, cursor);
      } catch {
        break;
      }
      for (const entry of page.entries) {
        if (entry.kind === 'directory') {
          if (current.depth < MAX_DEPTH) queue.push({ path: entry.path, depth: current.depth + 1 });
        } else if (paths.length < MAX_INDEX_FILES) {
          paths.push(entry.path);
        } else {
          capped = true;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && calls < MAX_DIRECTORY_CALLS);
  }
  return { paths, capped };
}

export interface RefreshReport {
  index: SemanticIndex;
  scanned: number;
  rechunked: number;
  removed: number;
  capped: boolean;
}

/**
 * Incremental refresh: read every visible file's current bytes (bounded),
 * compare content-hash versions, and re-chunk only what changed. Deleted files
 * leave the index; the cap is reported, never hidden.
 */
export async function refreshSemanticIndex(workspaceId: string, force = false): Promise<RefreshReport> {
  const desktop = getDesktopBridge();
  if (!desktop) throw new Error('The desktop bridge is unavailable, so the semantic index cannot refresh.');
  const now = Date.now();
  const cached = memoryIndexes.get(workspaceId) ?? loadPersisted(workspaceId);
  if (!force && cached && now - (lastRefresh.get(workspaceId) ?? 0) < REFRESH_THROTTLE_MS) {
    return { index: cached, scanned: 0, rechunked: 0, removed: 0, capped: cached.truncated };
  }
  const index: SemanticIndex = cached ?? emptyIndex();
  const { paths, capped } = await enumerateFiles(desktop, workspaceId);
  const live = new Set(paths);
  let removed = 0;
  for (const path of Object.keys(index.files)) {
    if (!live.has(path)) {
      delete index.files[path];
      removed += 1;
    }
  }
  let rechunked = 0;
  let chunkCount = Object.values(index.files).reduce((total, file) => total + file.chunks.length, 0);
  let truncated = capped;
  for (let offset = 0; offset < paths.length; offset += LOAD_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + LOAD_BATCH_SIZE);
    let loaded;
    try {
      loaded = await desktop.loadFiles(workspaceId, batch, { maxBytesPerFile: MAX_FILE_BYTES, maxTotalBytes: MAX_BATCH_BYTES });
    } catch {
      continue;
    }
    for (const file of loaded.files) {
      const existing = index.files[file.name];
      if (existing && existing.version === file.version) continue;
      if (chunkCount >= MAX_INDEX_CHUNKS) { truncated = true; continue; }
      const chunks = chunkText(file.content, file.name);
      chunkCount += chunks.length - (existing?.chunks.length ?? 0);
      index.files[file.name] = { version: file.version, chunks };
      rechunked += 1;
    }
  }
  index.updatedAt = now;
  index.truncated = truncated;
  lastRefresh.set(workspaceId, now);
  persist(workspaceId, index);
  void mirrorIndex(desktop, workspaceId, index);
  return { index, scanned: paths.length, rechunked, removed, capped: truncated };
}

/* ------------------------------------------------------------------ *
 * Optional BYOK Gemini rerank — never required, never blocking.
 * ------------------------------------------------------------------ */

async function embedTexts(texts: string[], apiKey: string): Promise<number[][] | null> {
  if (typeof fetch !== 'function' || texts.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          requests: texts.map((text) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: text.slice(0, 2_000) }] } }))
        })
      }
    );
    if (!response.ok) return null;
    const data = await response.json() as { embeddings?: Array<{ values?: number[] }> };
    const vectors = (data.embeddings ?? []).map((entry) => entry.values ?? []);
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length === 0)) return null;
    return vectors;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Hybrid rerank of the BM25 shortlist. Returns null when unavailable. */
async function hybridRerank(index: SemanticIndex, query: string, shortlist: ScoredChunk[], apiKey: string): Promise<ScoredChunk[] | null> {
  const texts = [query, ...shortlist.map((entry) => entry.chunk.text)];
  const vectors = await embedTexts(texts, apiKey);
  if (!vectors) return null;
  const queryVector = vectors[0];
  const maxBm25 = shortlist[0]?.score || 1;
  const reranked = shortlist.map((entry, position) => {
    const vector = vectors[position + 1];
    const file = index.files[entry.path];
    if (file) {
      file.vectors = file.vectors ?? {};
      file.vectors[entry.chunk.id] = vector;
    }
    const cosine = cosineSimilarity(queryVector, vector);
    return { ...entry, score: 0.65 * cosine + 0.35 * (entry.score / maxBm25) };
  });
  reranked.sort((left, right) => right.score - left.score);
  return reranked;
}

/* ------------------------------------------------------------------ *
 * Tool surface.
 * ------------------------------------------------------------------ */

function refusal(message: string): ToolOutcome {
  return { ok: false, content: '', error: message, refused: true };
}

export async function handleSemanticSearch(workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!workspaceId) return refusal('semantic_search needs an opened folder workspace.');
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length < 2) return refusal('semantic_search needs a query of at least 2 characters.');
  const limit = Math.min(Math.max(typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 8, 1), 20);
  try {
    const report = await refreshSemanticIndex(workspaceId, args.refresh === true);
    const index = report.index;
    const chunkTotal = Object.values(index.files).reduce((total, file) => total + file.chunks.length, 0);
    if (chunkTotal === 0) {
      return { ok: true, content: 'The semantic index is empty — no indexable text files were found in this workspace.' };
    }
    let ranked = bm25Rank(index, query, Math.max(limit, EMBED_SHORTLIST));
    let mode = 'lexical (BM25 + symbol/path boosts)';
    const apiKey = getApiKey('gemini');
    if (apiKey && ranked.length > 0) {
      const reranked = await hybridRerank(index, query, ranked.slice(0, EMBED_SHORTLIST), apiKey);
      if (reranked) {
        ranked = reranked;
        mode = 'hybrid (BM25 shortlist + Gemini text-embedding-004 rerank, BYOK)';
        persist(workspaceId, index);
      } else {
        mode = 'lexical (BM25 + symbol/path boosts; Gemini rerank unavailable — key rejected or network error)';
      }
    }
    ranked = ranked.slice(0, limit);
    if (ranked.length === 0) {
      return { ok: true, content: `No chunk matched "${query}" in ${chunkTotal} indexed chunks. Try different words — semantic_search ranks by token and symbol evidence, so a paraphrase with no shared vocabulary can miss. search_text is the fallback for exact strings.` };
    }
    const body = ranked.map((entry, position) => {
      const preview = entry.chunk.text.split('\n').slice(0, 8).map((line) => `  ${line.slice(0, 160)}`).join('\n');
      const symbols = entry.chunk.symbols.length > 0 ? ` · symbols: ${entry.chunk.symbols.slice(0, 6).join(', ')}` : '';
      return `${position + 1}. ${entry.path}:${entry.chunk.startLine}-${entry.chunk.endLine} (score ${entry.score.toFixed(3)})${symbols}\n${preview}`;
    }).join('\n');
    const stats = `Index: ${Object.keys(index.files).length} files, ${chunkTotal} chunks${report.capped ? ' (CAPPED — not every file is indexed)' : ''}; refresh re-chunked ${report.rechunked}, removed ${report.removed}. Mode: ${mode}.`;
    const content = `${ranked.length} result(s) for "${query}":\n${body}\n\n${stats}`;
    return { ok: true, content: content.length <= 22_000 ? content : `${content.slice(0, 22_000)}\n…(output bounded)` };
  } catch (error) {
    return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
  }
}

export const SEMANTIC_SEARCH_TOOLS: ToolDefinition[] = [
  {
    name: 'semantic_search',
    description: 'Search indexed workspace code chunks by concept/symbol (BM25 + optional embeddings), returning file:line ranges.',
    parameters: 'query: string (required), limit?: number (default 8), refresh?: boolean'
  }
];

export const SEMANTIC_SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Concept, identifier, or behavior to locate.' },
    limit: { type: 'integer', description: 'Max chunks (default 8, max 20).' },
    refresh: { type: 'boolean', description: 'Force incremental index refresh.' }
  },
  required: ['query'],
  additionalProperties: false
};