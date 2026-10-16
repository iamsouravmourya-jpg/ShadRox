import type { WorkspaceFile } from './types';

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
      lines.push(`… ${files.length - lines.length} more files (naam ke liye poocho)`);
      break;
    }
    used += entry.length + 1;
    lines.push(entry);
  }

  return lines.join('\n');
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

    const block = `### ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n\`\`\`\n${chunk.content}\n\`\`\``;
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

/** Renders retrieval results as the block that goes into the system instruction. */
export function renderRetrievedContext(result: RetrievalResult): string {
  if (result.snippets.length === 0) return '';
  const blocks = result.snippets.map(
    (snippet) => `--- ${snippet.path} (lines ${snippet.startLine}-${snippet.endLine}) ---\n${snippet.content}`
  );
  return blocks.join('\n\n');
}
