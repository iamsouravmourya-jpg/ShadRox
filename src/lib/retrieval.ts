import { cosineSimilarity, mergeHybridScores } from './localEmbeddings';
import type { LocalEmbedder } from './localEmbeddings';
import type { WorkspaceFile, WorkspaceFileEntry } from './types';

/**
 * Codebase retrieval.
 *
 * The chat used to send the model 80 file *names* and the single open file, so
 * a question about any other file was unanswerable. This module builds a real
 * index over every file in the workspace and hands back the most relevant
 * pieces, sized to the model's context window.
 *
 * Everything runs in the browser — no index server, no embeddings API call.
 */

const MAX_CHUNK_LINES = 120;
const MIN_CHUNK_LINES = 24;
const REPO_MAP_MAX_CHARS = 6000;
const SYMBOLS_PER_FILE = 12;

const BM25_K1 = 1.4;
const BM25_B = 0.75;
/** A file whose name appears in the query is almost always the right answer. */
const FILENAME_BOOST = 3;

/** Semantic re-ranking only earns its latency over a shortlist, not the whole repo. */
const SEMANTIC_CANDIDATE_LIMIT = 24;
const HYBRID_WEIGHTS = { lexical: 1, semantic: 1 };

const SYMBOL_PATTERN =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|static\s+)?(function|class|interface|type|enum|const|let|var|def|fn|struct|impl|trait|func)\s+([A-Za-z_$][\w$]*)/;

export interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  /** term -> frequency inside this chunk */
  terms: Map<string, number>;
  length: number;
}

export interface RetrievedSnippet {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface RetrievalResult {
  repoMap: string;
  snippets: RetrievedSnippet[];
  totalChars: number;
}

interface CodeIndex {
  signature: string;
  chunks: CodeChunk[];
  /** term -> number of chunks containing it */
  documentFrequency: Map<string, number>;
  averageLength: number;
}

/** Splits identifiers so `handleSend` also matches the word "send". */
function tokenize(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9_$]+/g);
  if (!raw) return [];

  const tokens: string[] = [];
  for (const token of raw) {
    const pieces = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/);
    for (const piece of pieces) {
      const value = piece.toLowerCase();
      if (value.length >= 2) tokens.push(value);
    }
  }
  return tokens;
}

function countTerms(tokens: string[]): Map<string, number> {
  const terms = new Map<string, number>();
  tokens.forEach((token) => terms.set(token, (terms.get(token) || 0) + 1));
  return terms;
}

/** Names exported/declared at the top level of a file, for the repo map. */
export function extractSymbols(content: string, limit = SYMBOLS_PER_FILE): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const line of content.split('\n')) {
    if (symbols.length >= limit) break;
    const match = line.match(SYMBOL_PATTERN);
    if (!match) continue;
    const name = match[2];
    if (seen.has(name)) continue;
    seen.add(name);
    symbols.push(name);
  }
  return symbols;
}

/**
 * Cuts a file into retrieval-sized pieces.
 *
 * Chunking starts at each top-level declaration so a returned snippet is a
 * whole function rather than an arbitrary slice of lines.
 */
function chunkFile(file: WorkspaceFile): Array<{ startLine: number; endLine: number; content: string }> {
  const lines = file.content.split('\n');

  if (lines.length <= MAX_CHUNK_LINES) {
    return [{ startLine: 1, endLine: lines.length, content: file.content }];
  }

  const starts: number[] = [0];
  for (let index = MIN_CHUNK_LINES; index < lines.length - MIN_CHUNK_LINES; index += 1) {
    if (!SYMBOL_PATTERN.test(lines[index])) continue;
    const last = starts[starts.length - 1];
    if (index - last < MIN_CHUNK_LINES) continue;
    if (index - last > MAX_CHUNK_LINES) {
      starts.push(index);
      continue;
    }
    starts.push(index);
  }

  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const rawEnd = index === starts.length - 1 ? lines.length : starts[index + 1];
    const end = Math.min(rawEnd, start + MAX_CHUNK_LINES);
    chunks.push({
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n')
    });
  }
  return chunks;
}

function signatureOf(files: WorkspaceFile[]): string {
  let total = 0;
  files.forEach((file) => {
    total += file.name.length + file.content.length;
  });
  return `${files.length}:${total}`;
}

export interface ChunkPiece {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * The chunks BM25 sees, with their file attached and in stable index order.
 * Hybrid retrieval embeds these, so both halves of the ranker must agree on
 * exactly where a chunk begins and ends.
 */
export function buildChunksForTesting(files: WorkspaceFile[]): ChunkPiece[] {
  const chunks: ChunkPiece[] = [];
  files.forEach((file) => {
    chunkFile(file).forEach((piece) => {
      chunks.push({
        path: file.name,
        startLine: piece.startLine,
        endLine: piece.endLine,
        content: piece.content
      });
    });
  });
  return chunks;
}

let cachedIndex: CodeIndex | null = null;

function buildIndex(files: WorkspaceFile[]): CodeIndex {
  const signature = signatureOf(files);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;

  const chunks: CodeChunk[] = [];
  const documentFrequency = new Map<string, number>();

  files.forEach((file) => {
    chunkFile(file).forEach((piece) => {
      const tokens = tokenize(`${file.name}\n${piece.content}`);
      const terms = countTerms(tokens);
      const unique = new Set(tokens);
      unique.forEach((term) => documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1));
      chunks.push({
        path: file.name,
        startLine: piece.startLine,
        endLine: piece.endLine,
        content: piece.content,
        terms,
        length: tokens.length || 1
      });
    });
  });

  const averageLength = chunks.length
    ? chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length
    : 1;

  cachedIndex = { signature, chunks, documentFrequency, averageLength };
  return cachedIndex;
}

export interface EmbeddingIndex {
  signature: string;
  chunks: ChunkPiece[];
  vectors: number[][];
  dimension: number;
}

let cachedEmbeddingIndex: EmbeddingIndex | null = null;

/** Drops the vector cache. Only tests need this; retrieval reuses it by signature. */
export function resetEmbeddingCache(): void {
  cachedEmbeddingIndex = null;
}

function isValidVectorList(vectors: unknown, expected: number): boolean {
  if (!Array.isArray(vectors) || vectors.length !== expected) return false;

  let dimension = -1;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) return false;
    if (dimension === -1) dimension = vector.length;
    else if (vector.length !== dimension) return false;
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    }
  }
  return dimension > 0;
}

/**
 * Embeds every chunk once per workspace signature.
 *
 * Embedding a repo is the expensive part of hybrid retrieval, so the vectors
 * live in memory and are only rebuilt when the file set changes or a different
 * embedder asks for them. A `null` embedder yields an empty index rather than
 * an error — the caller simply has nothing semantic to rank with.
 */
export async function buildEmbeddingIndex(
  files: WorkspaceFile[],
  embedder: LocalEmbedder | null
): Promise<EmbeddingIndex> {
  const chunks = buildChunksForTesting(files);
  const signature = `${signatureOf(files)}|${embedder ? embedder.id : 'none'}`;

  if (cachedEmbeddingIndex && cachedEmbeddingIndex.signature === signature) return cachedEmbeddingIndex;
  if (!embedder || chunks.length === 0) return { signature, chunks, vectors: [], dimension: 0 };

  const vectors = await embedder.embed(chunks.map((chunk) => `${chunk.path}\n${chunk.content}`));
  if (!isValidVectorList(vectors, chunks.length)) {
    throw new Error('Embedding index failed: the embedder returned malformed vectors.');
  }

  cachedEmbeddingIndex = {
    signature,
    chunks,
    vectors: vectors as number[][],
    dimension: (vectors as number[][])[0].length
  };
  return cachedEmbeddingIndex;
}

function scoreChunk(chunk: CodeChunk, queryTerms: string[], index: CodeIndex): number {
  let score = 0;
  const basename = (chunk.path.split('/').pop() || chunk.path).toLowerCase();

  queryTerms.forEach((term) => {
    const frequency = chunk.terms.get(term);
    if (!frequency) return;

    const containing = index.documentFrequency.get(term) || 0;
    const idf = Math.log(1 + (index.chunks.length - containing + 0.5) / (containing + 0.5));
    const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / index.averageLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / denominator);

    if (basename.includes(term)) score *= FILENAME_BOOST;
  });

  return score;
}

/** Compact "what is in this repo" summary — cheap enough to always include. */
export function buildRepoMap(files: WorkspaceFile[], maxChars = REPO_MAP_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;

  for (const file of files) {
    const symbols = extractSymbols(file.content);
    const lineCount = file.content.split('\n').length;
    const entry = `${file.name} · ${lineCount} lines${symbols.length ? ` · ${symbols.join(', ')}` : ''}`;
    if (used + entry.length > maxChars) {
      lines.push(`… ${files.length - lines.length} more files (truncated)`);
      break;
    }
    used += entry.length + 1;
    lines.push(entry);
  }

  return lines.join('\n');
}

const TREE_MAP_MAX_CHARS = 9_000;

/**
 * The same inventory without any file contents: every path the folder has,
 * grouped by directory. A folder workspace loads no buffers until a tab is
 * opened, so the content-based map above would be empty exactly when the model
 * needs to know what exists. Directory grouping is what lets 200+ paths fit in
 * a small budget, and one directory per line means a truncated list still
 * shows which sub-projects exist.
 */
export function buildFileTreeMap(
  entries: readonly WorkspaceFileEntry[],
  maxChars = TREE_MAP_MAX_CHARS
): string {
  if (entries.length === 0) return '';

  const directories: Array<{ dir: string; names: string[] }> = [];
  const indexOfDirectory = new Map<string, number>();
  for (const entry of entries) {
    const clean = entry.path.replace(/\\/g, '/');
    const slash = clean.lastIndexOf('/');
    const dir = slash < 0 ? '' : clean.slice(0, slash);
    const name = slash < 0 ? clean : clean.slice(slash + 1);
    const index = indexOfDirectory.get(dir) ?? directories.length;
    if (indexOfDirectory.get(dir) === undefined) indexOfDirectory.set(dir, index);
    (directories[index] ??= { dir, names: [] }).names.push(name);
  }

  // Directories are listed shallow-first: the root and the top-level folders
  // describe the project, so if the budget runs out it should cost the deep
  // leaves rather than `src/`. Sorting by depth then name keeps the output
  // byte-identical between requests, which is what makes prompt caching work.
  directories.sort((a, b) => depthOf(a.dir) - depthOf(b.dir) || a.dir.localeCompare(b.dir));

  // One line per directory with a capped number of names, so no single folder
  // can fill the budget before an untouched folder is ever mentioned. Breadth
  // first is what keeps a truncated list useful: the model still sees every
  // part of the project and knows how many files it is not seeing.
  // The cap grows shallower: the root holds the manifests, entry points and
  // config that describe the whole project, and a model that cannot see a root
  // file name has no way to ask for it. Deep leaf directories keep the small
  // cap because their names repeat what their parent already says.
  const namesPerDirectory = (depth: number) => (depth === 0 ? 48 : depth === 1 ? 16 : 8);
  // Room kept for the header line and a possible truncation notice, so the
  // returned string is always within `maxChars`.
  const RESERVE_CHARS = 150;
  const budget = Math.max(0, maxChars - RESERVE_CHARS);

  const lines: string[] = [];
  let used = 0;
  let shownPaths = 0;
  let droppedDirectories = 0;
  let droppedFiles = 0;

  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    const limit = namesPerDirectory(depthOf(directory.dir));
    const shown = directory.names.slice(0, limit);
    const rest = directory.names.length - shown.length;
    const line = `${directory.dir ? `${directory.dir}/` : '(root)'} — ${shown.join(', ')}${rest > 0 ? `, … +${rest} more` : ''}`;
    if (used + line.length + 1 > budget) {
      for (const remaining of directories.slice(index)) {
        droppedDirectories += 1;
        droppedFiles += remaining.names.length;
      }
      break;
    }
    used += line.length + 1;
    shownPaths += shown.length;
    lines.push(line);
  }

  const notice = droppedDirectories > 0
    ? `… ${droppedDirectories} more director(ies) with ${droppedFiles} file(s) not listed (path list truncated at this budget)`
    : '';
  const body = notice ? [...lines, notice] : lines;
  const header = notice
    ? `${shownPaths} of ${entries.length} file(s) listed by path; contents not included unless shown below:`
    : `${entries.length} file(s), contents not included unless shown below:`;
  return `${header}\n${body.join('\n')}`;
}

/** How many path segments deep a directory is, with the workspace root at 0. */
function depthOf(directory: string): number {
  return directory ? directory.split('/').length : 0;
}

/** The exact text a snippet costs against the context budget. */
function formatSnippetBlock(snippet: {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}): string {
  return `### ${snippet.path}:${snippet.startLine}-${snippet.endLine}\n\`\`\`\n${snippet.content}\n\`\`\``;
}

/**
 * Picks the most relevant code for a prompt, inside a character budget.
 *
 * `budgetChars` comes from the selected model's context window so a small
 * model is not handed a folder it cannot read.
 */
export function retrieveContext(files: WorkspaceFile[], query: string, budgetChars: number): RetrievalResult {
  const repoMap = buildRepoMap(files);
  if (files.length === 0 || budgetChars <= 0) return { repoMap, snippets: [], totalChars: repoMap.length };

  const index = buildIndex(files);
  const queryTerms = Array.from(new Set(tokenize(query)));

  const scored = index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTerms, index) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const snippets: RetrievedSnippet[] = [];
  const coveredPaths = new Set<string>();
  let used = 0;

  for (const entry of scored) {
    const { chunk, score } = entry;
    // One snippet per file is enough; the whole point is breadth.
    if (coveredPaths.has(chunk.path)) continue;

    const block = formatSnippetBlock(chunk);
    if (used + block.length > budgetChars) continue;

    coveredPaths.add(chunk.path);
    used += block.length;
    snippets.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      score
    });
  }

  return { repoMap, snippets, totalChars: used + repoMap.length };
}

/** Unique id for a snippet inside one retrieval pass. */
function snippetKey(snippet: RetrievedSnippet, index: number): string {
  return `${snippet.path}:${snippet.startLine}-${snippet.endLine}#${index}`;
}

/**
 * Hybrid retrieval: BM25 shortlist, then a local embedding re-rank.
 *
 * Lexical recall stays in charge of *what* is fetched — embeddings only decide
 * the order of the top candidates, so a workspace with 900 files never gets
 * fully embedded to answer one question. The repo map always comes from the
 * lexical pass.
 *
 * Every semantic failure path (no embedder, thrown import, wrong-shaped
 * vectors) returns the lexical result untouched. That is the whole fallback
 * contract: the caller never has to branch on availability.
 */
export async function retrieveContextSemantic(
  files: WorkspaceFile[],
  query: string,
  budgetChars: number,
  embedder: LocalEmbedder | null
): Promise<RetrievalResult> {
  const lexical = retrieveContext(files, query, budgetChars);
  if (!embedder || lexical.snippets.length === 0) return lexical;

  const candidates = lexical.snippets.slice(0, SEMANTIC_CANDIDATE_LIMIT);

  try {
    const vectors = await embedder.embed([query, ...candidates.map((snippet) => snippet.content)]);
    if (!isValidVectorList(vectors, candidates.length + 1)) return lexical;

    const queryVector = vectors[0];
    const lexicalScores = candidates.map((snippet, index) => ({
      id: snippetKey(snippet, index),
      score: snippet.score
    }));
    const semanticScores = candidates.map((snippet, index) => ({
      id: snippetKey(snippet, index),
      score: cosineSimilarity(vectors[index + 1], queryVector)
    }));

    const byKey = new Map<string, RetrievedSnippet>();
    candidates.forEach((snippet, index) => byKey.set(snippetKey(snippet, index), snippet));

    const reordered: RetrievedSnippet[] = [];
    let used = 0;

    for (const entry of mergeHybridScores(lexicalScores, semanticScores, HYBRID_WEIGHTS)) {
      const snippet = byKey.get(entry.id);
      if (!snippet) continue;
      const block = formatSnippetBlock(snippet);
      // Re-ordering can only cost budget if a bigger block moves ahead of a
      // smaller one; skipping it keeps the same invariant as the lexical pass.
      if (used + block.length > budgetChars) continue;
      used += block.length;
      reordered.push({ ...snippet, score: entry.score });
    }

    if (reordered.length === 0) return lexical;
    return { repoMap: lexical.repoMap, snippets: reordered, totalChars: used + lexical.repoMap.length };
  } catch {
    return lexical;
  }
}

/** The retrieved snippets as standalone blocks, strongest match first. */
export function renderRetrievedChunks(result: RetrievalResult): string[] {
  return result.snippets.map(
    (snippet) => `--- ${snippet.path} (lines ${snippet.startLine}-${snippet.endLine}) ---\n${snippet.content}`
  );
}

/** Renders retrieval results as the block that goes into the system instruction. */
export function renderRetrievedContext(result: RetrievalResult): string {
  if (result.snippets.length === 0) return '';
  return renderRetrievedChunks(result).join('\n\n');
}
