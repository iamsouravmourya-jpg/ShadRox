/**
 * Local embedding seam for hybrid retrieval.
 *
 * The shipped default is still BM25 (see `retrieval.ts`). This module only
 * describes the optional semantic half: vector maths that needs no dependency,
 * a very small registry for the active embedder, and a lazily created
 * transformers.js embedder.
 *
 * The transformers.js path imports `@huggingface/transformers` through a
 * variable specifier marked with `@vite-ignore`, so the bundler never tries to
 * resolve a package that may not be installed. Nothing is imported at module
 * load: with the package absent the module imports fine and every semantic
 * entry point degrades to "unavailable".
 */

export interface LocalEmbedder {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
  dimension?: number;
}

export interface ScoredId {
  id: string;
  score: number;
}

export interface HybridWeights {
  lexical: number;
  semantic: number;
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

const TRANSFORMERS_MODULE = '@huggingface/transformers';

/**
 * The semantic toggle is permanently off in this build: package.json has no
 * `@huggingface/transformers` dependency, so the lazy import below can never
 * resolve. Say that in the UI instead of leaving a switch that silently does
 * nothing.
 */
export const semanticUnavailableReason =
  'Local embeddings package not installed (@huggingface/transformers) — semantic search stays off and BM25 answers alone.';

/** Null once the optional package really loaded; the honest reason otherwise. */
export function getSemanticUnavailableReason(): string | null {
  return transformersAvailability === 'available' ? null : semanticUnavailableReason;
}

/** Availability is a string flag, not a boolean union — the tsconfig is not strict. */
const AVAILABILITY_UNKNOWN = 'unknown';
const AVAILABILITY_AVAILABLE = 'available';
const AVAILABILITY_UNAVAILABLE = 'unavailable';

type TransformersAvailability = 'unknown' | 'available' | 'unavailable';

type FeaturePipeline = (
  input: string[],
  options?: { pooling?: string; normalize?: boolean }
) => Promise<unknown>;

let transformersAvailability: TransformersAvailability = AVAILABILITY_UNKNOWN;
let activeEmbedder: LocalEmbedder | null = null;

/** Cosine similarity in [-1, 1]; 0 for length mismatches, bad values and zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;

  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** Euclidean length; 0 for empty vectors or non-numeric input. */
export function l2Norm(vector: number[]): number {
  if (!Array.isArray(vector) || vector.length === 0) return 0;

  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return 0;
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  return Number.isFinite(norm) ? norm : 0;
}

/** Unit-length copy of `vector`; a zero vector stays a (zero) vector of the same width. */
export function normalizeVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) return [];

  const norm = l2Norm(vector);
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

/**
 * Scores every snippet against the query, strongest first.
 * Equal scores keep their input order so callers get deterministic output.
 */
export function rankBySimilarity(
  snippets: Array<{ id: string; vector: number[] }>,
  queryVector: number[]
): ScoredId[] {
  const ranked = snippets.map((snippet, index) => ({
    id: snippet.id,
    score: cosineSimilarity(snippet.vector, queryVector),
    index
  }));

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  return ranked.map((entry) => ({ id: entry.id, score: entry.score }));
}

/** Min-max normalises one score list to [0, 1] without losing duplicate ids. */
function normalizeScores(entries: ScoredId[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (!Array.isArray(entries) || entries.length === 0) return scores;

  let min = Infinity;
  let max = -Infinity;

  for (const entry of entries) {
    const value = Number.isFinite(entry.score) ? entry.score : 0;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const span = max - min;
  for (const entry of entries) {
    if (scores.has(entry.id)) continue;
    const value = Number.isFinite(entry.score) ? entry.score : 0;
    // A flat list is either all-zero (contributes nothing) or uniformly good.
    const normalized = span > 0 ? (value - min) / span : value > 0 ? 1 : 0;
    scores.set(entry.id, normalized);
  }

  return scores;
}

/**
 * Blends lexical and semantic rankings.
 *
 * Each list is min-max normalised on its own so BM25 magnitudes (unbounded)
 * and cosine values ([-1, 1]) can be added. Ids that only appear in one list
 * are kept — a semantic hit with no lexical match is exactly what the hybrid
 * is for. Ties break by lexical position, then by id, so output never depends
 * on sort stability.
 */
export function mergeHybridScores(
  lexical: ScoredId[],
  semantic: ScoredId[],
  weights?: HybridWeights
): ScoredId[] {
  const lexicalWeight = weights && Number.isFinite(weights.lexical) ? weights.lexical : 1;
  const semanticWeight = weights && Number.isFinite(weights.semantic) ? weights.semantic : 1;

  const lexicalScores = normalizeScores(lexical || []);
  const semanticScores = normalizeScores(semantic || []);

  const lexicalOrder = new Map<string, number>();
  (lexical || []).forEach((entry, index) => {
    if (!lexicalOrder.has(entry.id)) lexicalOrder.set(entry.id, index);
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...(lexical || []), ...(semantic || [])]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    ids.push(entry.id);
  }

  const merged = ids.map((id) => ({
    id,
    score: lexicalWeight * (lexicalScores.get(id) || 0) + semanticWeight * (semanticScores.get(id) || 0),
    order: lexicalOrder.has(id) ? (lexicalOrder.get(id) as number) : Number.MAX_SAFE_INTEGER
  }));

  merged.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.order !== right.order) return left.order - right.order;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });

  return merged.map((entry) => ({ id: entry.id, score: entry.score }));
}

/** The embedder hybrid retrieval should use, if the app opted in. */
export function getActiveEmbedder(): LocalEmbedder | null {
  return activeEmbedder;
}

/** Swaps the active embedder. `null` restores the BM25-only default. */
export function setActiveEmbedder(embedder: LocalEmbedder | null): void {
  activeEmbedder = embedder;
}

/** Test seam: same as {@link setActiveEmbedder}, named for the test suite. */
export function setEmbedderForTests(embedder: LocalEmbedder | null): void {
  activeEmbedder = embedder;
}

/**
 * Imports transformers.js without giving the bundler a static specifier.
 * Any failure (package missing, no network for the model) is the caller's cue
 * to stay on BM25.
 */
async function importTransformers(): Promise<Record<string, unknown>> {
  const specifier = TRANSFORMERS_MODULE;
  const module = await import(/* @vite-ignore */ specifier);
  return module as Record<string, unknown>;
}

/** True only when the optional package can actually be imported. Never throws. */
export async function isTransformersAvailable(): Promise<boolean> {
  if (transformersAvailability === AVAILABILITY_AVAILABLE) return true;
  if (transformersAvailability === AVAILABILITY_UNAVAILABLE) return false;

  try {
    const module = await importTransformers();
    if (typeof module.pipeline !== 'function') {
      transformersAvailability = AVAILABILITY_UNAVAILABLE;
      return false;
    }
    transformersAvailability = AVAILABILITY_AVAILABLE;
    return true;
  } catch {
    transformersAvailability = AVAILABILITY_UNAVAILABLE;
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** Pulls plain arrays out of a Tensor (`.tolist()`) or an already-plain value. */
function readVectorMatrix(output: unknown): number[][] | null {
  if (!output) return null;

  let raw: unknown = output;
  if (typeof output === 'object' && typeof (output as { tolist?: unknown }).tolist === 'function') {
    raw = (output as { tolist: () => unknown }).tolist();
  }

  if (!Array.isArray(raw) || raw.length === 0) return null;

  const rows: unknown[] = raw;
  const looksLikeRows = rows.every((row) => Array.isArray(row));
  const matrix: number[][] = looksLikeRows ? (rows as number[][]) : [rows as number[]];

  const valid = matrix.every(
    (row) =>
      Array.isArray(row) &&
      row.length > 0 &&
      row.every((value) => typeof value === 'number' && Number.isFinite(value))
  );

  return valid ? matrix : null;
}

/**
 * Creates the transformer-backed embedder, or `null` when the optional package
 * is known to be missing. The model/pipeline itself is created on the first
 * `embed` call so importing this module never touches transformers.
 */
export function createTransformersEmbedder(options?: { model?: string }): LocalEmbedder | null {
  if (transformersAvailability === AVAILABILITY_UNAVAILABLE) return null;

  const model = (options && options.model) || DEFAULT_EMBEDDING_MODEL;
  let pipelinePromise: Promise<FeaturePipeline> | null = null;

  async function loadPipeline(): Promise<FeaturePipeline> {
    if (pipelinePromise) return pipelinePromise;

    pipelinePromise = (async () => {
      let module: Record<string, unknown>;
      try {
        module = await importTransformers();
      } catch (error) {
        transformersAvailability = AVAILABILITY_UNAVAILABLE;
        throw new Error(
          `Local embeddings unavailable: cannot import ${TRANSFORMERS_MODULE} (${errorMessage(error)}).`
        );
      }

      if (typeof module.pipeline !== 'function') {
        transformersAvailability = AVAILABILITY_UNAVAILABLE;
        throw new Error(`Local embeddings unavailable: ${TRANSFORMERS_MODULE} exports no pipeline().`);
      }

      const factory = module.pipeline as (
        task: string,
        modelName: string,
        config: { pooling: string; normalize: boolean }
      ) => Promise<FeaturePipeline>;

      try {
        const pipeline = await factory('feature-extraction', model, { pooling: 'mean', normalize: true });
        transformersAvailability = AVAILABILITY_AVAILABLE;
        return pipeline;
      } catch (error) {
        // A model that cannot load will not load on the next keystroke either.
        transformersAvailability = AVAILABILITY_UNAVAILABLE;
        throw new Error(
          `Local embeddings unavailable: could not load ${model} (${errorMessage(error)}).`
        );
      }
    })();

    try {
      return await pipelinePromise;
    } catch (error) {
      pipelinePromise = null;
      if (error instanceof Error) throw error;
      throw new Error(`Local embeddings unavailable: ${errorMessage(error)}`);
    }
  }

  return {
    id: `transformers:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      if (transformersAvailability === AVAILABILITY_UNAVAILABLE) {
        throw new Error(`Local embeddings unavailable: cannot import ${TRANSFORMERS_MODULE}.`);
      }

      const pipeline = await loadPipeline();
      const output = await pipeline(texts.slice(), { pooling: 'mean', normalize: true });
      const matrix = readVectorMatrix(output);

      if (!matrix || matrix.length !== texts.length) {
        throw new Error('Local embeddings failed: the model returned malformed vectors.');
      }
      return matrix;
    }
  };
}
